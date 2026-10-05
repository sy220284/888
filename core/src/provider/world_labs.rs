use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, AIOutputEnvelopeStatus, Artifact},
    provider::collect_remote_files,
    provider_run_repository::ProviderRunRepository,
};

pub const WORLD_LABS_PROVIDER: &str = "world-labs";
pub const WORLD_LABS_MODEL: &str = "marble-1.1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldGenerationOptions {
    pub display_name: String,
    pub prompt: Option<String>,
}

#[derive(Clone)]
pub struct WorldLabsRunner {
    http: Client,
    api_key: String,
    base_url: String,
    artifact_store: ArtifactStore,
    runs: ProviderRunRepository,
    poll_interval: Duration,
    timeout: Duration,
}

impl WorldLabsRunner {
    pub fn new(
        api_key: impl Into<String>,
        artifact_store: ArtifactStore,
        runs: ProviderRunRepository,
    ) -> Result<Self> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            bail!("WORLD_LABS_API_KEY must not be empty");
        }
        Ok(Self {
            http: Client::new(),
            api_key,
            base_url: "https://api.worldlabs.ai/marble/v1".to_owned(),
            artifact_store,
            runs,
            poll_interval: Duration::from_secs(15),
            timeout: Duration::from_secs(45 * 60),
        })
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_owned();
        self
    }

    pub async fn run(
        &self,
        image: Option<&Artifact>,
        options: &WorldGenerationOptions,
    ) -> Result<AIOutputEnvelope> {
        if options.display_name.trim().is_empty() {
            bail!("display_name must not be empty");
        }
        if image.is_none() && options.prompt.as_deref().is_none_or(str::is_empty) {
            bail!("world generation requires an image or text prompt");
        }

        let request = self.build_request(image, options).await?;
        let endpoint = format!("{}/worlds:generate", self.base_url);
        let run = self
            .runs
            .create("WORLD_GENERATION", WORLD_LABS_PROVIDER, &endpoint, &request)
            .await?;

        let execution = async {
            let response = self
                .http
                .post(&endpoint)
                .header("WLT-Api-Key", &self.api_key)
                .json(&request)
                .send()
                .await
                .context("World Labs submit request failed")?;
            let status = response.status();
            let mut operation: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                bail!("World Labs submit failed ({status}): {operation}");
            }

            let operation_id = operation_id(&operation)?;
            self.runs.mark_submitted(run.id, &operation_id).await?;
            let started = tokio::time::Instant::now();

            while !operation.get("done").and_then(Value::as_bool).unwrap_or(false) {
                if operation.get("error").is_some() {
                    bail!("World Labs operation failed: {}", operation["error"]);
                }
                if started.elapsed() >= self.timeout {
                    bail!("World Labs operation timed out after {}s", self.timeout.as_secs());
                }
                self.runs.mark_status(run.id, &operation).await?;
                tokio::time::sleep(self.poll_interval).await;

                let poll_url = format!("{}/operations/{operation_id}", self.base_url);
                let response = self
                    .http
                    .get(&poll_url)
                    .header("WLT-Api-Key", &self.api_key)
                    .send()
                    .await
                    .context("World Labs poll request failed")?;
                let status = response.status();
                operation = response.json().await.unwrap_or(Value::Null);
                if !status.is_success() {
                    bail!("World Labs poll failed ({status}): {operation}");
                }
            }

            if let Some(error) = operation.get("error") {
                bail!("World Labs generation failed: {error}");
            }
            let world = operation
                .get("response")
                .cloned()
                .context("World Labs completed without response")?;

            let remote_files = collect_remote_files(&world);
            if remote_files.is_empty() {
                bail!("WORLD_GENERATION returned no downloadable world artifacts");
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
                    "original_file_name": remote.file_name,
                }));
            }

            self.runs.complete(run.id, &operation, &artifact_ids).await?;
            Ok::<_, anyhow::Error>(AIOutputEnvelope {
                run_id: run.id,
                provider: WORLD_LABS_PROVIDER.to_owned(),
                model: Some(WORLD_LABS_MODEL.to_owned()),
                model_version: None,
                status: AIOutputEnvelopeStatus::Completed,
                artifact_ids,
                payload: json!({
                    "outputs": outputs,
                    "world": world,
                }),
                raw_confidence: None,
                calibrated_confidence: None,
                provider_metadata: Some(json!({
                    "operation_id": operation_id,
                    "endpoint": endpoint,
                })),
            })
        }
        .await;

        if let Err(error) = &execution {
            let _ = self.runs.fail(run.id, &error.to_string()).await;
        }
        execution
    }

    async fn build_request(
        &self,
        image: Option<&Artifact>,
        options: &WorldGenerationOptions,
    ) -> Result<Value> {
        let world_prompt = match image {
            Some(image) => {
                let path = self.artifact_store.absolute_path(image).await?;
                let bytes = tokio::fs::read(path).await?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                json!({
                    "type": "image",
                    "image_prompt": {
                        "source": "data_base64",
                        "data_base64": encoded,
                        "extension": extension_for_mime(&image.mime),
                        "mime_type": image.mime,
                    },
                    "text_prompt": options.prompt,
                })
            }
            None => json!({
                "type": "text",
                "text_prompt": options.prompt,
            }),
        };

        Ok(json!({
            "display_name": options.display_name,
            "model": WORLD_LABS_MODEL,
            "world_prompt": world_prompt,
        }))
    }
}

fn operation_id(operation: &Value) -> Result<String> {
    let value = operation
        .get("operation_id")
        .or_else(|| operation.get("id"))
        .or_else(|| operation.get("name"))
        .and_then(Value::as_str)
        .context("World Labs operation did not include operation id")?;
    Ok(value.rsplit('/').next().unwrap_or(value).to_owned())
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/avif" => "avif",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{extension_for_mime, operation_id};

    #[test]
    fn extracts_operation_id_from_all_supported_shapes() {
        assert_eq!(operation_id(&json!({"operation_id": "abc"})).unwrap(), "abc");
        assert_eq!(
            operation_id(&json!({"name": "operations/xyz"})).unwrap(),
            "xyz"
        );
    }

    #[test]
    fn maps_common_image_mime_extensions() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/webp"), "webp");
        assert_eq!(extension_for_mime("image/png"), "png");
    }
}
