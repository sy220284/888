use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    model::Artifact,
    provider::{collect_remote_files, fal::FalQueueClient},
    provider_run_repository::ProviderRunRepository,
};

use super::{
    hunyuan::{Hunyuan3dOptions, HUNYUAN_3D_ENDPOINT, HUNYUAN_PROVIDER},
    meshy::{Meshy3dOptions, MESHY_3D_ENDPOINT, MESHY_PROVIDER},
};

#[derive(Debug, Clone)]
pub enum ImageSource {
    Artifact(Artifact),
    RemoteUrl(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageTo3dRunResult {
    pub run_id: Uuid,
    pub request_id: String,
    pub artifacts: Vec<Artifact>,
    pub raw_result: Value,
}

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
        image: ImageSource,
        options: &Hunyuan3dOptions,
    ) -> Result<ImageTo3dRunResult> {
        let model_input = self.resolve_image_input(image).await?;
        let input = options.build_input(&model_input)?;
        self.run_fal_provider(HUNYUAN_PROVIDER, HUNYUAN_3D_ENDPOINT, input)
            .await
    }

    pub async fn run_meshy(
        &self,
        image: ImageSource,
        options: &Meshy3dOptions,
    ) -> Result<ImageTo3dRunResult> {
        let model_input = self.resolve_image_input(image).await?;
        let input = options.build_input(&model_input)?;
        self.run_fal_provider(MESHY_PROVIDER, MESHY_3D_ENDPOINT, input)
            .await
    }

    async fn resolve_image_input(&self, image: ImageSource) -> Result<String> {
        match image {
            ImageSource::Artifact(artifact) => self.artifact_store.to_data_uri(&artifact).await,
            ImageSource::RemoteUrl(url) => {
                if !url.starts_with("https://") {
                    bail!("remote image input must use HTTPS");
                }
                Ok(url)
            }
        }
    }

    async fn run_fal_provider(
        &self,
        provider: &str,
        endpoint: &str,
        input: Value,
    ) -> Result<ImageTo3dRunResult> {
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
            let mut artifacts = Vec::with_capacity(remote_files.len());
            for remote in remote_files {
                let artifact = self
                    .artifact_store
                    .import_source(&remote.url, remote.content_type.as_deref())
                    .await?;
                artifacts.push(artifact);
            }

            let artifact_ids: Vec<Uuid> = artifacts.iter().map(|artifact| artifact.id).collect();
            self.runs
                .complete(run.id, &raw_result, &artifact_ids)
                .await?;

            Ok::<_, anyhow::Error>(ImageTo3dRunResult {
                run_id: run.id,
                request_id: submission.request_id,
                artifacts,
                raw_result,
            })
        }
        .await;

        if let Err(error) = &execution {
            let _ = self.runs.fail(run.id, &error.to_string()).await;
        }
        execution
    }
}
