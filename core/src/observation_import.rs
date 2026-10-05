use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde_json::json;
use tokio::{fs, io::AsyncReadExt};
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    job_engine::JobEngine,
    model::{ArtifactLogicalType, Job, Observation},
    observation_repository::{NewImageObservation, ObservationRepository},
    world_repository::WorldRepository,
};

#[derive(Debug, Clone)]
pub struct ObservationImportResult {
    pub observations: Vec<Observation>,
    pub unique_artifact_ids: Vec<Uuid>,
    pub analysis_jobs: Vec<Job>,
}

#[derive(Clone)]
pub struct ObservationImportService {
    artifacts: ArtifactStore,
    observations: ObservationRepository,
    jobs: JobEngine,
    worlds: WorldRepository,
}

impl ObservationImportService {
    pub fn new(artifacts: ArtifactStore, pool: sqlx::SqlitePool) -> Self {
        Self {
            artifacts,
            observations: ObservationRepository::new(pool.clone()),
            jobs: JobEngine::new(pool.clone()),
            worlds: WorldRepository::new(pool),
        }
    }

    pub async fn import_images(
        &self,
        world_id: Uuid,
        paths: &[PathBuf],
    ) -> Result<ObservationImportResult> {
        if paths.is_empty() {
            bail!("IMPORT_OBSERVATIONS requires at least one image path");
        }
        self.worlds
            .get(world_id)
            .await?
            .context("world does not exist")?;

        let mut entries = Vec::with_capacity(paths.len());
        let mut artifact_ids = Vec::with_capacity(paths.len());

        for path in paths {
            let inspected = inspect_image(path).await?;
            let artifact = self
                .artifacts
                .import_file_with_metadata(
                    path,
                    inspected.mime,
                    None,
                    ArtifactLogicalType::OriginalImage,
                    json!({
                        "kind": "LOCAL_IMPORT",
                        "file_name": inspected.file_name,
                        "extension": inspected.extension,
                    }),
                )
                .await?;

            entries.push(NewImageObservation {
                artifact_id: artifact.id,
                timestamp: None,
                quality: json!({
                    "analysis_state": "PENDING",
                    "byte_size": artifact.size_bytes,
                    "mime": artifact.mime,
                    "usable_for_geometry": null,
                    "usable_for_texture": null,
                }),
            });
            artifact_ids.push(artifact.id);
        }

        let observations = self.observations.create_images(world_id, &entries).await?;

        let mut analysis_jobs = Vec::with_capacity(observations.len());
        for observation in &observations {
            let artifact_id = observation
                .artifact_id
                .context("imported image observation must reference artifact")?;
            let job = self
                .jobs
                .create_with_input(
                    Some(world_id),
                    "ANALYZE_OBSERVATION",
                    json!({
                        "observation_id": observation.id,
                        "artifact_id": artifact_id,
                    }),
                    2,
                    true,
                )
                .await?;
            analysis_jobs.push(self.jobs.resolve_dependencies(job.id).await?);
        }

        let mut seen = HashSet::new();
        let unique_artifact_ids = artifact_ids
            .into_iter()
            .filter(|id| seen.insert(*id))
            .collect();

        Ok(ObservationImportResult {
            observations,
            unique_artifact_ids,
            analysis_jobs,
        })
    }
}

struct InspectedImage {
    mime: &'static str,
    file_name: String,
    extension: String,
}

async fn inspect_image(path: &Path) -> Result<InspectedImage> {
    let metadata = fs::metadata(path)
        .await
        .with_context(|| format!("failed to inspect image {}", path.display()))?;
    if !metadata.is_file() {
        bail!("image source is not a regular file: {}", path.display());
    }

    let mut file = fs::File::open(path)
        .await
        .with_context(|| format!("failed to open image {}", path.display()))?;
    let mut header = [0_u8; 32];
    let read = file.read(&mut header).await?;
    let mime = detect_image_mime(&header[..read])
        .with_context(|| format!("unsupported or invalid image: {}", path.display()))?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("image file name must be valid UTF-8")?
        .to_owned();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    Ok(InspectedImage {
        mime,
        file_name,
        extension,
    })
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Some("image/avif"),
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => Some("image/heic"),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::{artifact_store::ArtifactStore, db, model::JobState, world_repository::WorldRepository};

    use super::{detect_image_mime, ObservationImportService};

    #[test]
    fn detects_common_photo_formats_from_content() {
        assert_eq!(detect_image_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(detect_image_mime(&[0xff, 0xd8, 0xff, 0x00]), Some("image/jpeg"));
        assert_eq!(
            detect_image_mime(b"RIFF\x00\x00\x00\x00WEBPrest"),
            Some("image/webp")
        );
        assert_eq!(
            detect_image_mime(b"\x00\x00\x00\x18ftypheicmore"),
            Some("image/heic")
        );
        assert_eq!(detect_image_mime(b"plain text"), None);
    }

    #[tokio::test]
    async fn imports_duplicate_files_as_two_observations_one_artifact_and_ready_jobs() {
        let pool = db::connect_memory().await.unwrap();
        let root = tempdir().unwrap();
        let sources = tempdir().unwrap();
        let store = ArtifactStore::new(root.path(), pool.clone()).await.unwrap();
        let world = WorldRepository::new(pool.clone())
            .create("Observation Import")
            .await
            .unwrap();

        let bytes = b"\x89PNG\r\n\x1a\nfixture-content";
        let first = sources.path().join("first.png");
        let second = sources.path().join("second.png");
        tokio::fs::write(&first, bytes).await.unwrap();
        tokio::fs::write(&second, bytes).await.unwrap();

        let service = ObservationImportService::new(store, pool.clone());
        let result = service
            .import_images(world.id, &[first, second])
            .await
            .unwrap();

        assert_eq!(result.observations.len(), 2);
        assert_eq!(result.unique_artifact_ids.len(), 1);
        assert_eq!(result.analysis_jobs.len(), 2);
        assert!(result
            .analysis_jobs
            .iter()
            .all(|job| job.state == JobState::Ready));
        assert!(result
            .analysis_jobs
            .iter()
            .all(|job| job.input.get("observation_id").is_some()));

        let observation_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM observations WHERE world_id = ?")
                .bind(world.id.to_string())
                .fetch_one(&pool)
                .await
                .unwrap();
        let artifact_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(observation_count, 2);
        assert_eq!(artifact_count, 1);
    }

    #[tokio::test]
    async fn rejects_non_image_before_creating_observation() {
        let pool = db::connect_memory().await.unwrap();
        let root = tempdir().unwrap();
        let sources = tempdir().unwrap();
        let store = ArtifactStore::new(root.path(), pool.clone()).await.unwrap();
        let world = WorldRepository::new(pool.clone())
            .create("Bad Import")
            .await
            .unwrap();
        let bad = sources.path().join("bad.txt");
        tokio::fs::write(&bad, b"not an image").await.unwrap();

        let service = ObservationImportService::new(store, pool.clone());
        assert!(service.import_images(world.id, &[bad]).await.is_err());

        let observation_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM observations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(observation_count, 0);
    }
}
