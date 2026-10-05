use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, AIOutputEnvelopeStatus, Artifact},
    provider::{collect_remote_files, fal::FalQueueClient},
    provider_run_repository::ProviderRunRepository,
};

pub const GPT_IMAGE_2_ENDPOINT: &str = "openai/gpt-image-2/edit";
pub const NANO_BANANA_ENDPOINT: &str = "fal-ai/nano-banana-2/edit";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ImageEditProvider {
    GptImage2,
    NanoBanana,
}

impl ImageEditProvider {
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::GptImage2 => GPT_IMAGE_2_ENDPOINT,
            Self::NanoBanana => NANO_BANANA_ENDPOINT,
        }
    }

    pub fn provider_id(self) -> &'static str {
        match self {
            Self::GptImage2 => "gpt-image-2",
            Self::NanoBanana => "nano-banana",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageEditOptions {
    pub provider: ImageEditProvider,
    pub prompt: String,
    pub num_images: u8,
    pub output_format: String,
    pub resolution: String,
    pub aspect_ratio: String,
    pub quality: String,
    pub image_size: String,
    pub safety_tolerance: String,
    pub limit_generations: bool,
    pub seed: Option<u64>,
}

impl Default for ImageEditOptions {
    fn default() -> Self {
        Self {
            provider: ImageEditProvider::NanoBanana,
            prompt: String::new(),
            num_images: 1,
            output_format: "png".to_owned(),
            resolution: "1K".to_owned(),
            aspect_ratio: "auto".to_owned(),
            quality: "medium".to_owned(),
            image_size: "auto".to_owned(),
            safety_tolerance: "4".to_owned(),
            limit_generations: true,
            seed: None,
        }
    }
}

impl ImageEditOptions {
    pub fn validate(&self, image_count: usize) -> Result<()> {
        if self.prompt.trim().is_empty() {
            bail!("image edit prompt must not be empty");
        }
        if image_count == 0 {
            bail!("image edit requires at least one source image");
        }
        if self.num_images == 0 || self.num_images > 4 {
            bail!("num_images must be between 1 and 4");
        }
        if self.output_format.trim().is_empty() {
            bail!("output_format must not be empty");
        }
        Ok(())
    }

    fn build_input(&self, image_urls: Vec<String>, mask_url: Option<String>) -> Value {
        match self.provider {
            ImageEditProvider::GptImage2 => {
                let mut input = json!({
                    "prompt": self.prompt,
                    "image_urls": image_urls,
                    "image_size": self.image_size,
                    "quality": self.quality,
                    "num_images": self.num_images,
                    "output_format": self.output_format,
                });
                if let Some(mask_url) = mask_url {
                    input["mask_image_url"] = Value::String(mask_url);
                }
                input
            }
            ImageEditProvider::NanoBanana => {
                let mut input = json!({
                    "prompt": self.prompt,
                    "image_urls": image_urls,
                    "num_images": self.num_images,
                    "aspect_ratio": self.aspect_ratio,
                    "output_format": self.output_format,
                    "safety_tolerance": self.safety_tolerance,
                    "resolution": self.resolution,
                    "limit_generations": self.limit_generations,
                });
                if let Some(seed) = self.seed {
                    input["seed"] = Value::Number(seed.into());
                }
                input
            }
        }
    }
}

#[derive(Clone)]
pub struct FalImageEditRunner {
    fal: FalQueueClient,
    artifact_store: ArtifactStore,
    runs: ProviderRunRepository,
    poll_interval: Duration,
    timeout: Duration,
}

impl FalImageEditRunner {
    pub fn new(
        fal: FalQueueClient,
        artifact_store: ArtifactStore,
        runs: ProviderRunRepository,
    ) -> Self {
        Self {
            fal,
            artifact_store,
            runs,
            poll_interval: Duration::from_secs(5),
            timeout: Duration::from_secs(20 * 60),
        }
    }

    pub async fn run(
        &self,
        images: &[Artifact],
        mask: Option<&Artifact>,
        options: &ImageEditOptions,
    ) -> Result<AIOutputEnvelope> {
        options.validate(images.len())?;

        let mut image_urls = Vec::with_capacity(images.len());
        for image in images {
            image_urls.push(self.artifact_store.to_data_uri(image).await?);
        }
        let mask_url = match mask {
            Some(mask) => Some(self.artifact_store.to_data_uri(mask).await?),
            None => None,
        };

        let input = options.build_input(image_urls, mask_url);
        let endpoint = options.provider.endpoint();
        let provider = options.provider.provider_id();
        let run = self
            .runs
            .create("IMAGE_EDIT", provider, endpoint, &input)
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
                        bail!("FAL image edit completed with error: {message}");
                    }
                    break;
                }
                if status.is_failed() {
                    bail!(
                        "{}",
                        status
                            .error_message()
                            .unwrap_or_else(|| format!("FAL request {}", status.status))
                    );
                }
                if started.elapsed() >= self.timeout {
                    bail!("image edit timed out after {}s", self.timeout.as_secs());
                }
                tokio::time::sleep(self.poll_interval).await;
            }

            let raw_result = self.fal.result(endpoint, &submission).await?;
            let remote_files = collect_remote_files(&raw_result);
            if remote_files.is_empty() {
                bail!("IMAGE_EDIT provider returned no downloadable artifacts");
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
                .complete(run.id, &raw_result, &artifact_ids)
                .await?;

            Ok::<_, anyhow::Error>(AIOutputEnvelope {
                run_id: run.id,
                provider: provider.to_owned(),
                model: Some(endpoint.to_owned()),
                model_version: None,
                status: AIOutputEnvelopeStatus::Completed,
                artifact_ids,
                payload: json!({"outputs": outputs}),
                raw_confidence: None,
                calibrated_confidence: None,
                provider_metadata: Some(json!({
                    "endpoint": endpoint,
                    "request_id": submission.request_id,
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

#[cfg(test)]
mod tests {
    use super::{ImageEditOptions, ImageEditProvider};

    #[test]
    fn keeps_provider_specific_payloads_separate() {
        let nano = ImageEditOptions {
            provider: ImageEditProvider::NanoBanana,
            prompt: "remove background".into(),
            ..Default::default()
        };
        let input = nano.build_input(vec!["data:image/png;base64,AAAA".into()], None);
        assert_eq!(input["resolution"], "1K");
        assert!(input.get("quality").is_none());

        let gpt = ImageEditOptions {
            provider: ImageEditProvider::GptImage2,
            prompt: "remove background".into(),
            ..Default::default()
        };
        let input = gpt.build_input(vec!["data:image/png;base64,AAAA".into()], None);
        assert_eq!(input["quality"], "medium");
        assert!(input.get("resolution").is_none());
    }
}
