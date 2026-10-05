use std::{
    fs::File,
    io::BufReader,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use exif::{In, Tag};
use image::{
    codecs::jpeg::JpegEncoder, metadata::Orientation, DynamicImage, ImageDecoder, ImageReader,
    Limits,
};
use serde_json::{json, Map, Value};
use sqlx::SqlitePool;
use tokio::task;
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    job_engine::JobEngine,
    model::{
        ArtifactLogicalType, JobState, ObservationAnalysis, ObservationAnalysisStatus,
        ObservationSourceType,
    },
    observation_repository::ObservationRepository,
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
};

const ANALYZER_VERSION: &str = "rust-observation-baseline-v1";
const PREVIEW_MAX_EDGE: u32 = 1600;
const QUALITY_MAX_EDGE: u32 = 1024;
const MAX_IMAGE_DIMENSION: u32 = 32_768;
const MAX_DECODE_ALLOC_BYTES: u64 = 512 * 1024 * 1024;
const PREVIEW_JPEG_QUALITY: u8 = 85;

#[derive(Clone)]
pub struct ObservationAnalysisService {
    pool: SqlitePool,
    artifacts: ArtifactStore,
    observations: ObservationRepository,
    jobs: JobEngine,
}

impl ObservationAnalysisService {
    pub fn new(artifacts: ArtifactStore, pool: SqlitePool) -> Self {
        Self {
            pool: pool.clone(),
            artifacts,
            observations: ObservationRepository::new(pool.clone()),
            jobs: JobEngine::new(pool),
        }
    }

    pub async fn execute_job(&self, job_id: Uuid) -> Result<ObservationAnalysis> {
        let job = self.jobs.get(job_id).await?.context("job does not exist")?;
        if job.task_type != "ANALYZE_OBSERVATION" {
            bail!("job is not ANALYZE_OBSERVATION");
        }

        let observation_id = required_uuid(&job.input, "observation_id")?;
        if job.state == JobState::Completed {
            return self
                .latest(observation_id)
                .await?
                .context("completed analysis job has no persisted analysis");
        }
        if job.state != JobState::Ready {
            bail!("ANALYZE_OBSERVATION job must be READY before execution");
        }

        self.jobs.transition(job_id, JobState::Running).await?;
        let result = self.analyze_observation(observation_id).await;

        match result {
            Ok(analysis) => {
                if analysis.status == ObservationAnalysisStatus::Failed {
                    self.jobs
                        .fail(
                            job_id,
                            "OBSERVATION_ANALYSIS_FAILED",
                            Some(json!({
                                "observation_id": observation_id,
                                "analysis_id": analysis.id,
                                "error": analysis.error,
                            })),
                        )
                        .await?;
                } else {
                    self.jobs.transition(job_id, JobState::Completed).await?;
                }
                Ok(analysis)
            }
            Err(error) => {
                let _ = self
                    .jobs
                    .fail(
                        job_id,
                        "OBSERVATION_ANALYSIS_INTERNAL_ERROR",
                        Some(json!({
                            "observation_id": observation_id,
                            "error": error.to_string(),
                        })),
                    )
                    .await;
                Err(error)
            }
        }
    }

    pub async fn analyze_observation(&self, observation_id: Uuid) -> Result<ObservationAnalysis> {
        let observation = self
            .observations
            .get(observation_id)
            .await?
            .context("observation does not exist")?;
        if observation.source_type != ObservationSourceType::Image {
            bail!("baseline observation analyzer currently accepts IMAGE only");
        }
        let artifact_id = observation
            .artifact_id
            .context("image observation has no artifact")?;
        let artifact = self
            .artifacts
            .get(artifact_id)
            .await?
            .context("observation artifact does not exist")?;
        if !artifact.mime.starts_with("image/") {
            bail!("observation artifact is not an image");
        }

        let path = self.artifacts.absolute_path(&artifact).await?;
        let mime = artifact.mime.clone();
        let blocking = task::spawn_blocking(move || analyze_file_guarded(&path))
            .await
            .context("observation analysis worker panicked or was cancelled")?;

        let analyzed_at = Utc::now();
        let analysis = match blocking {
            Ok(decoded) => {
                let preview = self
                    .artifacts
                    .import_bytes_with_metadata(
                        &decoded.preview_jpeg,
                        "image/jpeg",
                        None,
                        ArtifactLogicalType::Preview,
                        json!({
                            "kind": "OBSERVATION_PREVIEW",
                            "observation_id": observation_id,
                            "source_artifact_id": artifact_id,
                            "analyzer_version": ANALYZER_VERSION,
                        }),
                    )
                    .await?;

                ObservationAnalysis {
                    id: Uuid::new_v4(),
                    observation_id,
                    source_artifact_id: artifact_id,
                    status: ObservationAnalysisStatus::Completed,
                    preview_artifact_id: Some(preview.id),
                    width: Some(u64::from(decoded.width)),
                    height: Some(u64::from(decoded.height)),
                    orientation: decoded.orientation.map(u64::from),
                    captured_at: decoded.captured_at,
                    exif: decoded.exif,
                    quality: decoded.quality,
                    analyzer_version: ANALYZER_VERSION.to_owned(),
                    error: None,
                    analyzed_at,
                }
            }
            Err(error) if is_intentionally_partial_format(&mime) => ObservationAnalysis {
                id: Uuid::new_v4(),
                observation_id,
                source_artifact_id: artifact_id,
                status: ObservationAnalysisStatus::Partial,
                preview_artifact_id: None,
                width: None,
                height: None,
                orientation: error.orientation.map(u64::from),
                captured_at: error.captured_at,
                exif: error.exif,
                quality: json!({
                    "analysis_state": "PARTIAL",
                    "decode_supported": false,
                    "usable_for_geometry": null,
                    "usable_for_texture": null,
                    "limitations": ["PREVIEW_AND_PIXEL_QUALITY_REQUIRE_COMPATIBLE_DECODER"],
                }),
                analyzer_version: ANALYZER_VERSION.to_owned(),
                error: Some(error.message),
                analyzed_at,
            },
            Err(error) => ObservationAnalysis {
                id: Uuid::new_v4(),
                observation_id,
                source_artifact_id: artifact_id,
                status: ObservationAnalysisStatus::Failed,
                preview_artifact_id: None,
                width: None,
                height: None,
                orientation: error.orientation.map(u64::from),
                captured_at: error.captured_at,
                exif: error.exif,
                quality: json!({
                    "analysis_state": "FAILED",
                    "decode_supported": true,
                    "usable_for_geometry": false,
                    "usable_for_texture": false,
                }),
                analyzer_version: ANALYZER_VERSION.to_owned(),
                error: Some(error.message),
                analyzed_at,
            },
        };

        let saved = self.upsert(&analysis).await?;
        self.observations
            .update_derived_analysis(saved.observation_id, saved.captured_at, &saved.quality)
            .await?;
        Ok(saved)
    }

    pub async fn latest(&self, observation_id: Uuid) -> Result<Option<ObservationAnalysis>> {
        let row = sqlx::query_as::<_, ObservationAnalysisRow>(
            r#"
            SELECT id, observation_id, source_artifact_id, status, preview_artifact_id,
                   width, height, orientation, captured_at, exif_json, quality_json,
                   analyzer_version, error, analyzed_at
            FROM observation_analyses
            WHERE observation_id = ?
            ORDER BY analyzed_at DESC
            LIMIT 1
            "#,
        )
        .bind(observation_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    async fn upsert(&self, analysis: &ObservationAnalysis) -> Result<ObservationAnalysis> {
        sqlx::query(
            r#"
            INSERT INTO observation_analyses(
                id, observation_id, source_artifact_id, status, preview_artifact_id,
                width, height, orientation, captured_at, exif_json, quality_json,
                analyzer_version, error, analyzed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(observation_id, analyzer_version) DO UPDATE SET
                source_artifact_id = excluded.source_artifact_id,
                status = excluded.status,
                preview_artifact_id = excluded.preview_artifact_id,
                width = excluded.width,
                height = excluded.height,
                orientation = excluded.orientation,
                captured_at = excluded.captured_at,
                exif_json = excluded.exif_json,
                quality_json = excluded.quality_json,
                error = excluded.error,
                analyzed_at = excluded.analyzed_at
            "#,
        )
        .bind(analysis.id.to_string())
        .bind(analysis.observation_id.to_string())
        .bind(analysis.source_artifact_id.to_string())
        .bind(enum_to_string(&analysis.status)?)
        .bind(analysis.preview_artifact_id.map(|value| value.to_string()))
        .bind(analysis.width)
        .bind(analysis.height)
        .bind(analysis.orientation)
        .bind(analysis.captured_at.map(|value| value.to_rfc3339()))
        .bind(to_json(&analysis.exif)?)
        .bind(to_json(&analysis.quality)?)
        .bind(&analysis.analyzer_version)
        .bind(&analysis.error)
        .bind(analysis.analyzed_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        self.get_version(analysis.observation_id, &analysis.analyzer_version)
            .await?
            .context("observation analysis missing after upsert")
    }

    async fn get_version(
        &self,
        observation_id: Uuid,
        analyzer_version: &str,
    ) -> Result<Option<ObservationAnalysis>> {
        let row = sqlx::query_as::<_, ObservationAnalysisRow>(
            r#"
            SELECT id, observation_id, source_artifact_id, status, preview_artifact_id,
                   width, height, orientation, captured_at, exif_json, quality_json,
                   analyzer_version, error, analyzed_at
            FROM observation_analyses
            WHERE observation_id = ? AND analyzer_version = ?
            "#,
        )
        .bind(observation_id.to_string())
        .bind(analyzer_version)
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }
}

struct DecodedAnalysis {
    width: u32,
    height: u32,
    orientation: Option<u8>,
    captured_at: Option<DateTime<Utc>>,
    exif: Value,
    quality: Value,
    preview_jpeg: Vec<u8>,
}

struct AnalysisFailure {
    message: String,
    orientation: Option<u8>,
    captured_at: Option<DateTime<Utc>>,
    exif: Value,
}

fn analyze_file_guarded(path: &Path) -> std::result::Result<DecodedAnalysis, AnalysisFailure> {
    let (exif, exif_orientation, captured_at) = read_exif(path);
    let path = path.to_path_buf();
    let decoded = catch_unwind(AssertUnwindSafe(|| decode_image(&path, exif_orientation)));

    match decoded {
        Ok(Ok((image, orientation))) => {
            let width = image.width();
            let height = image.height();
            let quality = quality_metrics(&image);
            let preview_jpeg = encode_preview(&image).map_err(|error| AnalysisFailure {
                message: error.to_string(),
                orientation: Some(orientation.to_exif()),
                captured_at,
                exif: exif.clone(),
            })?;

            Ok(DecodedAnalysis {
                width,
                height,
                orientation: Some(orientation.to_exif()),
                captured_at,
                exif,
                quality,
                preview_jpeg,
            })
        }
        Ok(Err(error)) => Err(AnalysisFailure {
            message: error.to_string(),
            orientation: exif_orientation,
            captured_at,
            exif,
        }),
        Err(_) => Err(AnalysisFailure {
            message: "image decoder panicked while processing untrusted input".to_owned(),
            orientation: exif_orientation,
            captured_at,
            exif,
        }),
    }
}

fn decode_image(path: &Path, exif_orientation: Option<u8>) -> Result<(DynamicImage, Orientation)> {
    let file = File::open(path)?;
    let mut reader = ImageReader::new(BufReader::new(file)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    reader.limits(limits);

    let mut decoder = reader.into_decoder()?;
    let decoder_orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let orientation = exif_orientation
        .and_then(Orientation::from_exif)
        .unwrap_or(decoder_orientation);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok((image, orientation))
}

fn encode_preview(image: &DynamicImage) -> Result<Vec<u8>> {
    let preview = image.thumbnail(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE);
    let mut bytes = Vec::new();
    preview.write_with_encoder(JpegEncoder::new_with_quality(
        &mut bytes,
        PREVIEW_JPEG_QUALITY,
    ))?;
    Ok(bytes)
}

fn quality_metrics(image: &DynamicImage) -> Value {
    let width = image.width();
    let height = image.height();
    let sample = image.thumbnail(QUALITY_MAX_EDGE, QUALITY_MAX_EDGE).to_luma8();
    let pixels = sample.as_raw();
    let pixel_count = pixels.len().max(1) as f64;

    let sum: u64 = pixels.iter().map(|value| u64::from(*value)).sum();
    let mean_luma = sum as f64 / pixel_count;
    let underexposed = pixels.iter().filter(|value| **value <= 15).count() as f64 / pixel_count;
    let overexposed = pixels.iter().filter(|value| **value >= 240).count() as f64 / pixel_count;
    let sharpness = laplacian_variance(&sample);

    let resolution_ok = width >= 640 && height >= 480;
    let exposure_ok = underexposed < 0.60 && overexposed < 0.60;
    let sharpness_ok = sharpness >= 50.0;

    json!({
        "analysis_state": "COMPLETED",
        "profile": "BASELINE_HEURISTIC_V1",
        "width": width,
        "height": height,
        "resolution_megapixels": (f64::from(width) * f64::from(height)) / 1_000_000.0,
        "mean_luma": mean_luma,
        "underexposed_ratio": underexposed,
        "overexposed_ratio": overexposed,
        "sharpness_laplacian_variance": sharpness,
        "motion_blur": null,
        "occlusion": null,
        "usable_for_geometry": resolution_ok && exposure_ok && sharpness_ok,
        "usable_for_texture": resolution_ok && exposure_ok,
        "limitations": [
            "NO_DEDICATED_MOTION_BLUR_CLASSIFIER",
            "NO_SEMANTIC_OCCLUSION_MODEL"
        ]
    })
}

fn laplacian_variance(image: &image::GrayImage) -> f64 {
    let (width, height) = image.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }

    let mut count = 0_f64;
    let mut sum = 0_f64;
    let mut sum_sq = 0_f64;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let center = f64::from(image.get_pixel(x, y)[0]);
            let left = f64::from(image.get_pixel(x - 1, y)[0]);
            let right = f64::from(image.get_pixel(x + 1, y)[0]);
            let up = f64::from(image.get_pixel(x, y - 1)[0]);
            let down = f64::from(image.get_pixel(x, y + 1)[0]);
            let value = 4.0 * center - left - right - up - down;
            count += 1.0;
            sum += value;
            sum_sq += value * value;
        }
    }

    if count == 0.0 {
        0.0
    } else {
        let mean = sum / count;
        (sum_sq / count - mean * mean).max(0.0)
    }
}

fn read_exif(path: &Path) -> (Value, Option<u8>, Option<DateTime<Utc>>) {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            return (
                json!({"available": false, "parse_error": error.to_string()}),
                None,
                None,
            );
        }
    };

    let exif = match exif::Reader::new().read_from_container(&mut BufReader::new(file)) {
        Ok(exif) => exif,
        Err(error) => {
            return (
                json!({"available": false, "parse_error": error.to_string()}),
                None,
                None,
            );
        }
    };

    let orientation = exif
        .get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=8).contains(value));

    let date = ascii_field(&exif, Tag::DateTimeOriginal);
    let offset = ascii_field(&exif, Tag::OffsetTimeOriginal);
    let captured_at = date
        .as_deref()
        .zip(offset.as_deref())
        .and_then(|(date, offset)| {
            DateTime::parse_from_str(
                &format!("{date}{offset}"),
                "%Y:%m:%d %H:%M:%S%:z",
            )
            .ok()
        })
        .map(|value| value.with_timezone(&Utc));

    let mut fields = Map::new();
    fields.insert("available".to_owned(), Value::Bool(true));
    insert_display_field(&mut fields, &exif, "make", Tag::Make);
    insert_display_field(&mut fields, &exif, "model", Tag::Model);
    insert_display_field(&mut fields, &exif, "lens_model", Tag::LensModel);
    insert_display_field(&mut fields, &exif, "focal_length", Tag::FocalLength);
    insert_display_field(&mut fields, &exif, "f_number", Tag::FNumber);
    insert_display_field(&mut fields, &exif, "exposure_time", Tag::ExposureTime);
    insert_display_field(
        &mut fields,
        &exif,
        "photographic_sensitivity",
        Tag::PhotographicSensitivity,
    );
    insert_display_field(&mut fields, &exif, "iso_speed", Tag::ISOSpeed);
    if let Some(value) = date {
        fields.insert("date_time_original".to_owned(), Value::String(value));
    }
    if let Some(value) = offset {
        fields.insert("offset_time_original".to_owned(), Value::String(value));
    }
    if let Some(value) = orientation {
        fields.insert(
            "orientation".to_owned(),
            Value::Number(serde_json::Number::from(value)),
        );
    }

    (Value::Object(fields), orientation, captured_at)
}

fn ascii_field(exif: &exif::Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    let exif::Value::Ascii(values) = &field.value else {
        return None;
    };
    let value = values.first()?;
    let value = String::from_utf8_lossy(value)
        .trim_matches(char::from(0))
        .trim()
        .to_owned();
    (!value.is_empty()).then_some(value)
}

fn insert_display_field(fields: &mut Map<String, Value>, exif: &exif::Exif, key: &str, tag: Tag) {
    if let Some(field) = exif.get_field(tag, In::PRIMARY) {
        fields.insert(
            key.to_owned(),
            Value::String(field.display_value().with_unit(exif).to_string()),
        );
    }
}

fn required_uuid(payload: &Value, key: &str) -> Result<Uuid> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("job input.{key} must be a UUID string"))?;
    Uuid::parse_str(value).with_context(|| format!("job input.{key} is not a valid UUID"))
}

fn is_intentionally_partial_format(mime: &str) -> bool {
    matches!(mime, "image/avif" | "image/heic" | "image/heif")
}

#[derive(sqlx::FromRow)]
struct ObservationAnalysisRow {
    id: String,
    observation_id: String,
    source_artifact_id: String,
    status: String,
    preview_artifact_id: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    orientation: Option<i64>,
    captured_at: Option<String>,
    exif_json: String,
    quality_json: String,
    analyzer_version: String,
    error: Option<String>,
    analyzed_at: String,
}

impl TryFrom<ObservationAnalysisRow> for ObservationAnalysis {
    type Error = anyhow::Error;

    fn try_from(row: ObservationAnalysisRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            observation_id: Uuid::parse_str(&row.observation_id)?,
            source_artifact_id: Uuid::parse_str(&row.source_artifact_id)?,
            status: enum_from_string(&row.status)?,
            preview_artifact_id: row
                .preview_artifact_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            width: row.width.map(u64::try_from).transpose().context("negative analysis width")?,
            height: row.height.map(u64::try_from).transpose().context("negative analysis height")?,
            orientation: row
                .orientation
                .map(u64::try_from)
                .transpose()
                .context("negative analysis orientation")?,
            captured_at: parse_optional_datetime(row.captured_at.as_deref(), "captured_at")?,
            exif: from_json(&row.exif_json)?,
            quality: from_json(&row.quality_json)?,
            analyzer_version: row.analyzer_version,
            error: row.error,
            analyzed_at: DateTime::parse_from_rfc3339(&row.analyzed_at)
                .context("invalid observation analysis timestamp")?
                .with_timezone(&Utc),
        })
    }
}

fn parse_optional_datetime(value: Option<&str>, field: &str) -> Result<Option<DateTime<Utc>>> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&Utc))
                .with_context(|| format!("invalid {field}"))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::tempdir;

    use crate::{
        artifact_store::ArtifactStore, db, model::JobState, observation_import::ObservationImportService,
        world_repository::WorldRepository,
    };

    use super::{laplacian_variance, ObservationAnalysisService};

    #[test]
    fn laplacian_variance_is_zero_for_tiny_image() {
        let image = image::GrayImage::new(1, 1);
        assert_eq!(laplacian_variance(&image), 0.0);
    }

    #[tokio::test]
    async fn executes_imported_observation_analysis_job_and_persists_preview() {
        let pool = db::connect_memory().await.unwrap();
        let root = tempdir().unwrap();
        let store = ArtifactStore::new(root.path(), pool.clone()).await.unwrap();
        let world = WorldRepository::new(pool.clone())
            .create("Analysis Test")
            .await
            .unwrap();

        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../testdata/regression/observation-import-dedup/observations/first.png");
        let imported = ObservationImportService::new(store.clone(), pool.clone())
            .import_images(world.id, &[fixture])
            .await
            .unwrap();
        let job = &imported.analysis_jobs[0];

        let service = ObservationAnalysisService::new(store.clone(), pool.clone());
        let analysis = service.execute_job(job.id).await.unwrap();

        assert_eq!(analysis.status, crate::model::ObservationAnalysisStatus::Completed);
        assert!(analysis.preview_artifact_id.is_some());
        assert_eq!(analysis.quality["analysis_state"], "COMPLETED");

        let completed = crate::job_engine::JobEngine::new(pool.clone())
            .get(job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.state, JobState::Completed);

        let preview = store
            .get(analysis.preview_artifact_id.unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            preview.logical_type,
            crate::model::ArtifactLogicalType::Preview
        );

        let observation = crate::observation_repository::ObservationRepository::new(pool)
            .get(analysis.observation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observation.quality["analysis_state"], "COMPLETED");
    }
}
