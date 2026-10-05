use std::{collections::HashSet, time::Duration};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, AIOutputEnvelopeStatus, Artifact},
    provider::{collect_remote_files, RemoteFileRef},
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
        if image.is_none() && normalized_prompt(options.prompt.as_deref()).is_none() {
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

            while !operation
                .get("done")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                if let Some(error) = operation_error(&operation) {
                    bail!("World Labs operation failed: {error}");
                }
                if started.elapsed() >= self.timeout {
                    bail!(
                        "World Labs operation timed out after {}s",
                        self.timeout.as_secs()
                    );
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

            if let Some(error) = operation_error(&operation) {
                bail!("World Labs generation failed: {error}");
            }
            let world = operation
                .get("response")
                .cloned()
                .context("World Labs completed without response")?;

            let remote_files = collect_world_assets(&world);
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

            self.runs
                .complete(run.id, &operation, &artifact_ids)
                .await?;
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
        let prompt = normalized_prompt(options.prompt.as_deref());

        let world_prompt = match image {
            Some(image) => {
                let path = self.artifact_store.absolute_path(image).await?;
                let bytes = tokio::fs::read(path).await?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                let mut value = json!({
                    "type": "image",
                    "image_prompt": {
                        "source": "data_base64",
                        "data_base64": encoded,
                        "extension": extension_for_mime(&image.mime),
                        "mime_type": image.mime,
                    }
                });
                if let Some(prompt) = prompt {
                    value["text_prompt"] = Value::String(prompt.to_owned());
                }
                value
            }
            None => {
                let prompt = prompt.context("text world generation requires prompt")?;
                json!({
                    "type": "text",
                    "text_prompt": prompt,
                })
            }
        };

        Ok(json!({
            "display_name": options.display_name.trim(),
            "model": WORLD_LABS_MODEL,
            "world_prompt": world_prompt,
        }))
    }
}

fn normalized_prompt(prompt: Option<&str>) -> Option<&str> {
    prompt.map(str::trim).filter(|prompt| !prompt.is_empty())
}

fn operation_error(operation: &Value) -> Option<&Value> {
    operation.get("error").filter(|error| !error.is_null())
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

fn collect_world_assets(world: &Value) -> Vec<RemoteFileRef> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    let assets = world.get("assets").unwrap_or(&Value::Null);
    push_world_asset(
        &mut files,
        &mut seen,
        "collider",
        assets
            .pointer("/mesh/collider_mesh_url")
            .and_then(Value::as_str),
        Some("model/gltf-binary"),
    );
    push_world_asset(
        &mut files,
        &mut seen,
        "pano",
        assets.pointer("/imagery/pano_url").and_then(Value::as_str),
        None,
    );
    push_world_asset(
        &mut files,
        &mut seen,
        "thumbnail",
        assets.get("thumbnail_url").and_then(Value::as_str),
        None,
    );

    if let Some(spz_urls) = assets
        .pointer("/splats/spz_urls")
        .and_then(Value::as_object)
    {
        for (key, value) in spz_urls {
            push_world_asset(
                &mut files,
                &mut seen,
                &format!("splat-{key}"),
                value.as_str(),
                Some("application/octet-stream"),
            );
        }
    }

    for remote in collect_remote_files(world) {
        if seen.insert(remote.url.clone()) {
            files.push(remote);
        }
    }

    files
}

fn push_world_asset(
    files: &mut Vec<RemoteFileRef>,
    seen: &mut HashSet<String>,
    label: &str,
    url: Option<&str>,
    content_type: Option<&str>,
) {
    let Some(url) = url.filter(|url| url.starts_with("https://")) else {
        return;
    };
    if !seen.insert(url.to_owned()) {
        return;
    }
    files.push(RemoteFileRef {
        label: label.to_owned(),
        url: url.to_owned(),
        file_name: None,
        content_type: content_type.map(str::to_owned),
    });
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

    use super::{collect_world_assets, extension_for_mime, operation_error, operation_id};

    #[test]
    fn extracts_operation_id_from_all_supported_shapes() {
        assert_eq!(
            operation_id(&json!({"operation_id": "abc"})).unwrap(),
            "abc"
        );
        assert_eq!(
            operation_id(&json!({"name": "operations/xyz"})).unwrap(),
            "xyz"
        );
    }

    #[test]
    fn null_operation_error_is_not_failure() {
        assert!(operation_error(&json!({"error": null})).is_none());
        assert!(operation_error(&json!({"error": {"message": "boom"}})).is_some());
    }

    #[test]
    fn collects_world_labs_bare_asset_urls() {
        let world = json!({
            "assets": {
                "mesh": {"collider_mesh_url": "https://cdn/world.glb"},
                "imagery": {"pano_url": "https://cdn/pano.jpg"},
                "thumbnail_url": "https://cdn/thumb.webp",
                "splats": {
                    "spz_urls": {
                        "full": "https://cdn/full.spz",
                        "mobile": "https://cdn/mobile.spz"
                    }
                }
            }
        });

        let files = collect_world_assets(&world);
        assert_eq!(files.len(), 5);
        assert!(files.iter().any(|file| file.label == "collider"));
        assert!(files.iter().any(|file| file.label == "splat-full"));
        assert!(files
            .iter()
            .any(|file| file.url == "https://cdn/mobile.spz"));
    }

    #[test]
    fn maps_common_image_mime_extensions() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/webp"), "webp");
        assert_eq!(extension_for_mime("image/png"), "png");
    }
}
