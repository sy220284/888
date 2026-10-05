use std::{path::Path, process::Stdio};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use uuid::Uuid;

use crate::{artifact_store::ArtifactStore, model::Artifact};

const SILENCE_THRESHOLD_DB: &str = "-45dB";
const START_SILENCE_SECONDS: &str = "0.03";
const END_SILENCE_SECONDS: &str = "0.05";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioVolume {
    pub mean_db: Option<f64>,
    pub max_db: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioSilence {
    pub leading_seconds: f64,
    pub trailing_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioAnalysis {
    pub duration_seconds: Option<f64>,
    pub bytes: u64,
    pub volume: AudioVolume,
    pub silence: AudioSilence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPostprocessResult {
    pub raw_artifact_id: Uuid,
    pub output_artifact_id: Uuid,
    pub postprocessed: bool,
    pub before: AudioAnalysis,
    pub after: AudioAnalysis,
    pub quality_score: u8,
}

pub async fn analyze_audio(path: &Path) -> Result<AudioAnalysis> {
    let duration_seconds = probe_duration(path).await?;
    let volume = measure_volume(path).await?;
    let silence = detect_silence(path, duration_seconds).await?;
    let bytes = tokio::fs::metadata(path).await?.len();

    Ok(AudioAnalysis {
        duration_seconds,
        bytes,
        volume,
        silence,
    })
}

pub async fn postprocess_audio(
    store: &ArtifactStore,
    raw: &Artifact,
    enabled: bool,
) -> Result<AudioPostprocessResult> {
    let source = store.absolute_path(raw).await?;
    let before = analyze_audio(&source).await?;

    if !enabled || !can_postprocess(&raw.mime) {
        return Ok(AudioPostprocessResult {
            raw_artifact_id: raw.id,
            output_artifact_id: raw.id,
            postprocessed: false,
            quality_score: score_audio(&before),
            before: before.clone(),
            after: before,
        });
    }

    assert_audio_tools().await?;
    let extension = extension_for_mime(&raw.mime);
    let temp = std::env::temp_dir().join(format!("888-audio-{}.{extension}", Uuid::new_v4()));
    let filters = format!(
        "silenceremove=start_periods=1:start_duration={START_SILENCE_SECONDS}:start_threshold={SILENCE_THRESHOLD_DB}:stop_periods=-1:stop_duration={END_SILENCE_SECONDS}:stop_threshold={SILENCE_THRESHOLD_DB},loudnorm=I=-16:TP=-1.5:LRA=11"
    );

    let output = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-nostdin", "-i"])
        .arg(&source)
        .args(["-af", &filters])
        .arg(&temp)
        .stderr(Stdio::piped())
        .output()
        .await
        .context("failed to run ffmpeg audio postprocess")?;

    if !output.status.success() {
        let _ = tokio::fs::remove_file(&temp).await;
        bail!(
            "ffmpeg audio postprocess failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let after = analyze_audio(&temp).await?;
    let processed = store
        .import_file(&temp, raw.mime.clone(), None)
        .await
        .context("failed to import processed audio artifact")?;
    let _ = tokio::fs::remove_file(&temp).await;

    Ok(AudioPostprocessResult {
        raw_artifact_id: raw.id,
        output_artifact_id: processed.id,
        postprocessed: true,
        quality_score: score_audio(&after),
        before,
        after,
    })
}

async fn assert_audio_tools() -> Result<()> {
    for tool in ["ffmpeg", "ffprobe"] {
        let status = Command::new(tool)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .with_context(|| format!("{tool} is required for audio postprocessing"))?;
        if !status.success() {
            bail!("{tool} is not available");
        }
    }
    Ok(())
}

async fn probe_duration(path: &Path) -> Result<Option<f64>> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .await
        .context("failed to run ffprobe")?;
    if !output.status.success() {
        bail!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    Ok(value["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok()))
}

async fn measure_volume(path: &Path) -> Result<AudioVolume> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args(["-af", "volumedetect", "-f", "null", "-"])
        .output()
        .await
        .context("failed to measure audio volume")?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(AudioVolume {
        mean_db: parse_metric(&stderr, "mean_volume:"),
        max_db: parse_metric(&stderr, "max_volume:"),
    })
}

async fn detect_silence(path: &Path, duration: Option<f64>) -> Result<AudioSilence> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args([
            "-af",
            &format!("silencedetect=noise={SILENCE_THRESHOLD_DB}:d={START_SILENCE_SECONDS}"),
            "-f",
            "null",
            "-",
        ])
        .output()
        .await
        .context("failed to detect audio silence")?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    let starts = parse_all_metric(&stderr, "silence_start:");
    let ends = parse_all_metric(&stderr, "silence_end:");
    let leading = if starts.first().is_some_and(|value| *value <= 0.05) {
        ends.first().copied().unwrap_or(0.0)
    } else {
        0.0
    };
    let trailing = match (duration, starts.last().copied()) {
        (Some(duration), Some(start)) if duration >= start => duration - start,
        _ => 0.0,
    };

    Ok(AudioSilence {
        leading_seconds: round_seconds(leading),
        trailing_seconds: round_seconds(trailing),
    })
}

fn parse_metric(text: &str, marker: &str) -> Option<f64> {
    text.lines()
        .find_map(|line| parse_line_metric(line, marker))
}

fn parse_all_metric(text: &str, marker: &str) -> Vec<f64> {
    text.lines()
        .filter_map(|line| parse_line_metric(line, marker))
        .collect()
}

fn parse_line_metric(line: &str, marker: &str) -> Option<f64> {
    let index = line.find(marker)? + marker.len();
    line[index..]
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
}

fn score_audio(analysis: &AudioAnalysis) -> u8 {
    let mut score = 100.0;
    score -= (analysis.silence.leading_seconds * 120.0).min(35.0);
    score -= (analysis.silence.trailing_seconds * 50.0).min(20.0);
    if let Some(duration) = analysis.duration_seconds {
        if duration > 3.0 {
            score -= ((duration - 3.0) * 8.0).min(20.0);
        }
    }
    if let Some(max_db) = analysis.volume.max_db {
        if max_db < -8.0 {
            score -= ((max_db + 8.0).abs() * 2.0).min(20.0);
        }
    }
    score.clamp(0.0, 100.0).round() as u8
}

fn can_postprocess(mime: &str) -> bool {
    matches!(mime, "audio/mpeg" | "audio/ogg" | "audio/opus")
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "audio/ogg" | "audio/opus" => "opus",
        _ => "mp3",
    }
}

fn round_seconds(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::{parse_line_metric, score_audio, AudioAnalysis, AudioSilence, AudioVolume};

    #[test]
    fn parses_ffmpeg_metrics() {
        assert_eq!(
            parse_line_metric(
                "[Parsed_volumedetect] mean_volume: -18.4 dB",
                "mean_volume:"
            ),
            Some(-18.4)
        );
    }

    #[test]
    fn penalizes_large_silence_and_low_volume() {
        let analysis = AudioAnalysis {
            duration_seconds: Some(4.0),
            bytes: 100,
            volume: AudioVolume {
                mean_db: Some(-20.0),
                max_db: Some(-15.0),
            },
            silence: AudioSilence {
                leading_seconds: 0.2,
                trailing_seconds: 0.2,
            },
        };
        assert!(score_audio(&analysis) < 100);
    }
}
