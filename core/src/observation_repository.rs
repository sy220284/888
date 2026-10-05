use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    model::{Observation, ObservationSourceType},
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
};

#[derive(Debug, Clone)]
pub struct NewImageObservation {
    pub artifact_id: Uuid,
    pub timestamp: Option<DateTime<Utc>>,
    pub quality: Value,
}

#[derive(Clone)]
pub struct ObservationRepository {
    pool: SqlitePool,
}

impl ObservationRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create_images(
        &self,
        world_id: Uuid,
        entries: &[NewImageObservation],
    ) -> Result<Vec<Observation>> {
        let mut tx = self.pool.begin().await?;
        let observations = create_images_in_tx(&mut tx, world_id, entries).await?;
        tx.commit().await?;
        Ok(observations)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Observation>> {
        let row = sqlx::query_as::<_, ObservationRow>(
            r#"
            SELECT id, world_id, artifact_id, source_type, timestamp,
                   camera_intrinsics_json, camera_pose_candidate_json,
                   quality_json, immutable, created_at
            FROM observations
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn apply_image_analysis(
        &self,
        id: Uuid,
        timestamp: Option<DateTime<Utc>>,
        camera_intrinsics: Option<Value>,
        quality: Value,
    ) -> Result<Observation> {
        if !quality.is_object() {
            bail!("observation analysis quality must be an object");
        }
        if camera_intrinsics
            .as_ref()
            .is_some_and(|value| !value.is_object())
        {
            bail!("camera_intrinsics must be an object when present");
        }

        let result = sqlx::query(
            r#"
            UPDATE observations
            SET timestamp = COALESCE(?, timestamp),
                camera_intrinsics_json = COALESCE(?, camera_intrinsics_json),
                quality_json = ?
            WHERE id = ?
            "#,
        )
        .bind(timestamp.map(|value| value.to_rfc3339()))
        .bind(camera_intrinsics.as_ref().map(to_json).transpose()?)
        .bind(to_json(&quality)?)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!("observation does not exist");
        }
        self.get(id)
            .await?
            .context("observation disappeared after analysis update")
    }

    pub async fn list_for_world(&self, world_id: Uuid) -> Result<Vec<Observation>> {
        let rows = sqlx::query_as::<_, ObservationRow>(
            r#"
            SELECT id, world_id, artifact_id, source_type, timestamp,
                   camera_intrinsics_json, camera_pose_candidate_json,
                   quality_json, immutable, created_at
            FROM observations
            WHERE world_id = ?
            ORDER BY created_at, id
            "#,
        )
        .bind(world_id.to_string())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(TryInto::try_into).collect()
    }
}

pub(crate) async fn create_images_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    world_id: Uuid,
    entries: &[NewImageObservation],
) -> Result<Vec<Observation>> {
    let world_exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM worlds WHERE id = ? LIMIT 1")
        .bind(world_id.to_string())
        .fetch_optional(&mut **tx)
        .await?;
    if world_exists.is_none() {
        bail!("world does not exist");
    }

    let mut observations = Vec::with_capacity(entries.len());
    for entry in entries {
        if !entry.quality.is_object() {
            bail!("observation quality must be a JSON object");
        }
        let artifact_exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM artifacts WHERE id = ? LIMIT 1")
                .bind(entry.artifact_id.to_string())
                .fetch_optional(&mut **tx)
                .await?;
        if artifact_exists.is_none() {
            bail!("observation artifact does not exist");
        }

        let observation = Observation {
            id: Uuid::new_v4(),
            world_id,
            artifact_id: Some(entry.artifact_id),
            source_type: ObservationSourceType::Image,
            timestamp: entry.timestamp,
            camera_intrinsics: None,
            camera_pose_candidate: None,
            quality: entry.quality.clone(),
            immutable: true,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO observations(
                id, world_id, artifact_id, source_type, timestamp,
                camera_intrinsics_json, camera_pose_candidate_json,
                quality_json, immutable, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?)
            "#,
        )
        .bind(observation.id.to_string())
        .bind(observation.world_id.to_string())
        .bind(observation.artifact_id.map(|value| value.to_string()))
        .bind(enum_to_string(&observation.source_type)?)
        .bind(observation.timestamp.map(|value| value.to_rfc3339()))
        .bind(to_json(&observation.quality)?)
        .bind(observation.created_at.to_rfc3339())
        .execute(&mut **tx)
        .await?;

        observations.push(observation);
    }

    Ok(observations)
}

#[derive(sqlx::FromRow)]
struct ObservationRow {
    id: String,
    world_id: String,
    artifact_id: Option<String>,
    source_type: String,
    timestamp: Option<String>,
    camera_intrinsics_json: Option<String>,
    camera_pose_candidate_json: Option<String>,
    quality_json: String,
    immutable: bool,
    created_at: String,
}

impl TryFrom<ObservationRow> for Observation {
    type Error = anyhow::Error;

    fn try_from(row: ObservationRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            artifact_id: row
                .artifact_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            source_type: enum_from_string(&row.source_type)?,
            timestamp: parse_optional_datetime(row.timestamp.as_deref(), "observation timestamp")?,
            camera_intrinsics: row
                .camera_intrinsics_json
                .as_deref()
                .map(from_json)
                .transpose()?,
            camera_pose_candidate: row
                .camera_pose_candidate_json
                .as_deref()
                .map(from_json)
                .transpose()?,
            quality: from_json(&row.quality_json)?,
            immutable: row.immutable,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)
                .context("invalid observation created_at")?
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
    use serde_json::json;
    use tempfile::tempdir;

    use crate::{
        artifact_store::ArtifactStore, db, model::ArtifactLogicalType,
        world_repository::WorldRepository,
    };

    use super::{NewImageObservation, ObservationRepository};

    #[tokio::test]
    async fn duplicate_content_can_back_multiple_observations() {
        let pool = db::connect_memory().await.unwrap();
        let temp = tempdir().unwrap();
        let store = ArtifactStore::new(temp.path(), pool.clone()).await.unwrap();
        let world = WorldRepository::new(pool.clone())
            .create("Import Test")
            .await
            .unwrap();

        let first = store
            .import_bytes_with_metadata(
                b"same-image",
                "image/png",
                None,
                ArtifactLogicalType::OriginalImage,
                json!({"kind": "TEST"}),
            )
            .await
            .unwrap();
        let second = store
            .import_bytes_with_metadata(
                b"same-image",
                "image/png",
                None,
                ArtifactLogicalType::OriginalImage,
                json!({"kind": "TEST"}),
            )
            .await
            .unwrap();
        assert_eq!(first.id, second.id);

        let repo = ObservationRepository::new(pool.clone());
        let observations = repo
            .create_images(
                world.id,
                &[
                    NewImageObservation {
                        artifact_id: first.id,
                        timestamp: None,
                        quality: json!({"analysis_state": "PENDING"}),
                    },
                    NewImageObservation {
                        artifact_id: second.id,
                        timestamp: None,
                        quality: json!({"analysis_state": "PENDING"}),
                    },
                ],
            )
            .await
            .unwrap();

        assert_eq!(observations.len(), 2);
        assert_ne!(observations[0].id, observations[1].id);
        assert_eq!(observations[0].artifact_id, observations[1].artifact_id);

        let artifact_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(artifact_count, 1);
    }
}
