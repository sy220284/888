use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, AIOutputEnvelopeStatus},
    provider::{audio::postprocess_audio, fal::FalQueueClient},
    provider_run_repository::ProviderRunRepository,
};

pub const ELEVENLABS_SFX_ENDPOINT: &str = "fal-ai/elevenlabs/sound-effects/v2";
pub const ELEVENLABS_SFX_PROVIDER: &str = "elevenlabs-sfx";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SfxOptions {
    pub prompt: String,
    pub count: u8,
    pub loop_audio: bool,
    pub duration_seconds: Option<f64>,
    pub prompt_influence: f64,
    pub output_format: String,
    pub postprocess: bool,
}

impl Default for SfxOptions {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            count: 1,
            loop_audio: false,
            duration_seconds: None,
            prompt_influence: 0.3,
            output_format: "mp3_44100_128".to_owned(),
            postprocess: true,
        }
    }
}

impl SfxOptions {
    pub fn validate(&self) -> Result<()> {
        if self.prompt.trim().is_empty() {
            bail!("SFX prompt must not be empty");
        }
        if !(1..=4).contains(&self.count) {
            bail!("SFX count must be between 1 and 4");
        }
        if let Some(duration) = self.duration_seconds {
            if !(0.5..=22.0).contains(&duration) {
                bail!("SFX duration_seconds must be between 0.5 and 22");
            }
        }
        if !(0.0..=1.0).contains(&self.prompt_influence) {
            bail!("SFX prompt_influence must be between 0 and 1");
        }
        Ok(())
    }

    fn input(&self) -> Value {
        let mut input = json!({
            "text": self.prompt,
            "loop": self.loop_audio,
            "prompt_influence": self.prompt_influence,
            "output_format": self.output_format,
        });
        if let Some(duration) = self.duration_seconds {
            input["duration_seconds"] = json!(duration);
        }
        input
    }
}

#[derive(Clone)]
pub struct FalSfxRunner {
    fal: FalQueueClient,
    artifact_store: ArtifactStore,
    runs: ProviderRunRepository,
    poll_interval: Duration,
    timeout: Duration,
}

impl FalSfxRunner {
    pub fn new(
        fal: FalQueueClient,
        artifact_store: ArtifactStore,
        runs: ProviderRunRepository,
    ) -> Self {
        Self {
            fal,
            artifact_store,
            runs,
            poll_interval: Duration::from_secs(3),
            timeout: Duration::from_secs(10 * 60),
        }
    }

    pub async fn run(&self, options: &SfxOptions) -> Result<Vec<AIOutputEnvelope>> {
        options.validate()?;
        let mut outputs = Vec::with_capacity(options.count as usize);
        for _ in 0..options.count {
            outputs.push(self.run_one(options).await?);
        }
        Ok(outputs)
    }

    async fn run_one(&self, options: &SfxOptions) -> Result<AIOutputEnvelope> {
        let input = options.input();
        let run = self
            .runs
            .create(
                "SFX_GENERATION",
                ELEVENLABS_SFX_PROVIDER,
                ELEVENLABS_SFX_ENDPOINT,
                &input,
            )
            .await?;

        let execution = async {
            let submission = self.fal.submit(ELEVENLABS_SFX_ENDPOINT, &input).await?;
            self.runs
                .mark_submitted(run.id, &submission.request_id)
                .await?;

            let started = tokio::time::Instant::now();
            loop {
                let status = self
                    .fal
                    .status(ELEVENLABS_SFX_ENDPOINT, &submission, true)
                    .await?;
                self.runs.mark_status(run.id, &status.raw).await?;
                if status.is_completed() {
                    if let Some(message) = status.error_message() {
                        bail!("SFX request completed with error: {message}");
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
                    bail!("SFX request timed out after {}s", self.timeout.as_secs());
                }
                tokio::time::sleep(self.poll_interval).await;
            }

            let raw_result = self.fal.result(ELEVENLABS_SFX_ENDPOINT, &submission).await?;
            let audio = raw_result
                .get("audio")
                .context("SFX result did not include audio")?;
            let url = audio
                .get("url")
                .and_then(Value::as_str)
                .context("SFX result did not include audio.url")?;
            let content_type = audio.get("content_type").and_then(Value::as_str);
            let raw_artifact = self
                .artifact_store
                .import_source(url, content_type)
                .await?;

            let should_postprocess = options.postprocess && !options.loop_audio;
            let analysis = postprocess_audio(
                &self.artifact_store,
                &raw_artifact,
                should_postprocess,
            )
            .await?;
            let output_artifact = self
                .artifact_store
                .get(analysis.output_artifact_id)
                .await?
                .context("processed audio artifact is missing")?;

            let artifact_ids = if output_artifact.id == raw_artifact.id {
                vec![raw_artifact.id]
            } else {
                vec![raw_artifact.id, output_artifact.id]
            };

            self.runs
                .complete(run.id, &raw_result, &artifact_ids)
                .await?;

            Ok::<_, anyhow::Error>(AIOutputEnvelope {
                run_id: run.id,
                provider: ELEVENLABS_SFX_PROVIDER.to_owned(),
                model: Some(ELEVENLABS_SFX_ENDPOINT.to_owned()),
                model_version: None,
                status: AIOutputEnvelopeStatus::Completed,
                artifact_ids,
                payload: json!({
                    "audio_artifact_id": output_artifact.id,
                    "raw_audio_artifact_id": raw_artifact.id,
                    "audio_analysis": analysis,
                    "loop": options.loop_audio,
                    "output_format": options.output_format,
                }),
                raw_confidence: None,
                calibrated_confidence: None,
                provider_metadata: Some(json!({
                    "endpoint": ELEVENLABS_SFX_ENDPOINT,
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

use anyhow::Context;

#[cfg(test)]
mod tests {
    use super::SfxOptions;

    #[test]
    fn validates_provider_contract_ranges() {
        let mut options = SfxOptions {
            prompt: "door close".into(),
            ..Default::default()
        };
        assert!(options.validate().is_ok());

        options.count = 5;
        assert!(options.validate().is_err());

        options.count = 1;
        options.duration_seconds = Some(30.0);
        assert!(options.validate().is_err());
    }
}
