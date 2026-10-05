use std::time::Duration;

use anyhow::{bail, Result};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, AIOutputEnvelopeStatus, Artifact},
    provider::{collect_remote_files, fal::FalQueueClient},
    provider_run_repository::ProviderRunRepository,
};

use super::{
    hunyuan::{Hunyuan3dOptions, HUNYUAN_3D_ENDPOINT, HUNYUAN_PROVIDER},
    meshy::{Meshy3dOptions, MESHY_3D_ENDPOINT, MESHY_PROVIDER},
};

#[derive(Clone)]
pub struct FalImageTo3dRunner {
    fal: FalQueueClient,
    artifact_store: ArtifactStore,
    runs: ProviderRunRepository,
    poll_interval: Duration,
    timeout: Duration,
}

impl FalImageTo3dRunner {
    pub fn new(
        fal: FalQueueClient,
        artifact_store: ArtifactStore,
        runs: ProviderRunRepository,
    ) -> Self {
        Self {
            fal,
            artifact_store,
            runs,
            poll_interval: Duration::from_secs(10),
            timeout: Duration::from_secs(30 * 60),
        }
    }

    pub fn with_polling(mut self, poll_interval: Duration, timeout: Duration) -> Self {
        self.poll_interval = poll_interval;
        self.timeout = timeout;
        self
    }

    pub async fn run_hunyuan(
        &self,
        image: &Artifact,
        options: &Hunyuan3dOptions,
    ) -> Result<AIOutputEnvelope> {
        let model_input = self.artifact_store.to_data_uri(image).await?;
        let input = options.build_input(&model_input)?;
        self.run_fal_provider(HUNYUAN_PROVIDER, HUNYUAN_3D_ENDPOINT, input)
            .await
    }

    pub async fn run_meshy(
        &self,
        image: &Artifact,
        options: &Meshy3dOptions,
    ) -> Result<AIOutputEnvelope> {
        let model_input = self.artifact_store.to_data_uri(image).await?;
        let input = options.build_input(&model_input)?;
        self.run_fal_provider(MESHY_PROVIDER, MESHY_3D_ENDPOINT, input)
            .await
    }

    async fn run_fal_provider(
        &self,
        provider: &str,
        endpoint: &str,
        input: Value,
    ) -> Result<AIOutputEnvelope> {
        let run = self
            .runs
            .create("OBJECT_3D", provider, endpoint, &input)
            .await?;

        let execution = async {
            let submission = self.fal.submit(endpoint, &input).await?;
            self.runs
                .mark_submitted(run.id, &submission.request_id)
                .await?;

            let started = tokio::time::Instant::now();
            loop {
                let status = self.fal.status(endpoint, &submission, true).await?;
                self.runs.mark_status(run.id, &status.raw).await?;

                if status.is_completed() {
                    if let Some(message) = status.error_message() {
                        bail!("FAL request completed with error: {message}");
                    }
                    break;
                }
                if status.is_failed() {
                    let message = status
                        .error_message()
                        .unwrap_or_else(|| format!("FAL request {}", status.status));
                    bail!("{message}");
                }
                if started.elapsed() >= self.timeout {
                    bail!("FAL request timed out after {}s", self.timeout.as_secs());
                }
                tokio::time::sleep(self.poll_interval).await;
            }

            let raw_result = self.fal.result(endpoint, &submission).await?;
            let remote_files = collect_remote_files(&raw_result);
            if remote_files.is_empty() {
                bail!("OBJECT_3D provider returned no downloadable artifacts");
            }

            let mut artifact_ids = Vec::with_capacity(remote_files.len());
            let mut outputs = Vec::with_capacity(remote_files.len());

            for remote in remote_files {
                let artifact = self
                    .artifact_store
                    .import_source(&remote.url, remote.content_type.as_deref())
                    .await?;
                artifact_ids.push(artifact.id);
                outputs.push(json!({
                    "role": remote.label,
                    "artifact_id": artifact.id,
                    "mime": artifact.mime,
                    "size_bytes": artifact.size_bytes,
                    "original_file_name": remote.file_name
                }));
            }

            self.runs
                .complete(run.id, &raw_result, &artifact_ids)
                .await?;

            Ok::<_, anyhow::Error>(AIOutputEnvelope {
                run_id: run.id,
                provider: provider.to_owned(),
                model: Some(endpoint.to_owned()),
                model_version: None,
                status: AIOutputEnvelopeStatus::Completed,
                artifact_ids,
                payload: json!({ "outputs": outputs }),
                raw_confidence: None,
                calibrated_confidence: None,
                provider_metadata: Some(json!({
                    "endpoint": endpoint,
                    "request_id": submission.request_id
                })),
            })
        }
        .await;

        if let Err(error) = &execution {
            let _ = self.runs.fail(run.id, &error.to_string()).await;
        }
        execution
    }
}

