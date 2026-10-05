use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    model::{
        Candidate, CandidateCandidateType, CandidateStatus, ValidationResult,
        ValidationResultStatus, WorldRevision, WorldRevisionActorType,
    },
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
    world_repository::commit_revision_in_tx,
};

#[derive(Clone)]
pub struct CandidateService {
    pool: SqlitePool,
}

impl CandidateService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        world_id: Uuid,
        candidate_type: CandidateCandidateType,
        source_job_id: Option<Uuid>,
        provider_run_id: Option<Uuid>,
        artifact_ids: Vec<Uuid>,
        payload: Value,
    ) -> Result<Candidate> {
        let unique_artifacts: HashSet<Uuid> = artifact_ids.iter().copied().collect();
        if unique_artifacts.len() != artifact_ids.len() {
            bail!("candidate artifact_ids must be unique");
        }
        for artifact_id in &artifact_ids {
            let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM artifacts WHERE id = ?")
                .bind(artifact_id.to_string())
                .fetch_optional(&self.pool)
                .await?;
            if exists.is_none() {
                bail!("candidate references missing artifact {artifact_id}");
            }
        }

        let candidate = Candidate {
            id: Uuid::new_v4(),
            world_id,
            candidate_type,
            source_job_id,
            provider_run_id,
            artifact_ids,
            payload,
            status: CandidateStatus::Pending,
            created_at: Utc::now(),
        };

        let artifact_ids: Vec<String> =
            candidate.artifact_ids.iter().map(Uuid::to_string).collect();

        sqlx::query(
            r#"
            INSERT INTO candidates(
                id, world_id, candidate_type, source_job_id, provider_run_id,
                artifact_ids_json, payload_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(candidate.id.to_string())
        .bind(candidate.world_id.to_string())
        .bind(enum_to_string(&candidate.candidate_type)?)
        .bind(candidate.source_job_id.map(|value| value.to_string()))
        .bind(candidate.provider_run_id.map(|value| value.to_string()))
        .bind(to_json(&artifact_ids)?)
        .bind(to_json(&candidate.payload)?)
        .bind(enum_to_string(&candidate.status)?)
        .bind(candidate.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(candidate)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Candidate>> {
        let row = sqlx::query_as::<_, CandidateRow>(
            r#"
            SELECT id, world_id, candidate_type, source_job_id, provider_run_id,
                   artifact_ids_json, payload_json, status, created_at
            FROM candidates
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn add_validation(
        &self,
        candidate_id: Uuid,
        status: ValidationResultStatus,
        issues: Vec<Value>,
        metrics: Value,
        validator: &str,
    ) -> Result<ValidationResult> {
        if validator.trim().is_empty() {
            bail!("validator must not be empty");
        }
        let candidate = self
            .get(candidate_id)
            .await?
            .context("candidate does not exist")?;
        if candidate.status != CandidateStatus::Pending {
            bail!("only PENDING candidates can be validated");
        }

        let result = ValidationResult {
            id: Uuid::new_v4(),
            candidate_id,
            status,
            issues,
            metrics,
            validator: validator.trim().to_owned(),
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO validation_results(
                id, candidate_id, status, issues_json, metrics_json, validator, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(result.id.to_string())
        .bind(result.candidate_id.to_string())
        .bind(enum_to_string(&result.status)?)
        .bind(to_json(&result.issues)?)
        .bind(to_json(&result.metrics)?)
        .bind(&result.validator)
        .bind(result.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(result)
    }

    pub async fn accept(
        &self,
        candidate_id: Uuid,
        expected_parent_revision_id: Option<Uuid>,
        command_id: Option<Uuid>,
        actor_type: WorldRevisionActorType,
    ) -> Result<WorldRevision> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query_as::<_, CandidateRow>(
            r#"
            SELECT id, world_id, candidate_type, source_job_id, provider_run_id,
                   artifact_ids_json, payload_json, status, created_at
            FROM candidates
            WHERE id = ?
            "#,
        )
        .bind(candidate_id.to_string())
        .fetch_optional(&mut *tx)
        .await?
        .context("candidate does not exist")?;

        let candidate: Candidate = row.try_into()?;
        if candidate.status != CandidateStatus::Pending {
            bail!("only PENDING candidates can be accepted");
        }

        let latest_validation: Option<String> = sqlx::query_scalar(
            r#"
            SELECT status
            FROM validation_results
            WHERE candidate_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            "#,
        )
        .bind(candidate_id.to_string())
        .fetch_optional(&mut *tx)
        .await?;

        let latest_validation = latest_validation
            .as_deref()
            .map(enum_from_string::<ValidationResultStatus>)
            .transpose()?;
        if latest_validation != Some(ValidationResultStatus::Passed) {
            bail!("candidate latest validation must be PASSED before acceptance");
        }

        let revision = commit_revision_in_tx(
            &mut tx,
            candidate.world_id,
            expected_parent_revision_id,
            command_id,
            actor_type,
            json!({
                "operation": "ACCEPT_CANDIDATE",
                "candidate_id": candidate.id,
                "candidate_type": enum_to_string(&candidate.candidate_type)?,
                "artifact_ids": candidate.artifact_ids,
                "payload": candidate.payload,
            }),
        )
        .await?;

        let update = sqlx::query("UPDATE candidates SET status = ? WHERE id = ? AND status = ?")
            .bind(enum_to_string(&CandidateStatus::Accepted)?)
            .bind(candidate_id.to_string())
            .bind(enum_to_string(&CandidateStatus::Pending)?)
            .execute(&mut *tx)
            .await?;

        if update.rows_affected() != 1 {
            bail!("candidate changed concurrently");
        }

        tx.commit().await?;
        Ok(revision)
    }

    pub async fn reject(&self, candidate_id: Uuid) -> Result<()> {
        let result = sqlx::query("UPDATE candidates SET status = ? WHERE id = ? AND status = ?")
            .bind(enum_to_string(&CandidateStatus::Rejected)?)
            .bind(candidate_id.to_string())
            .bind(enum_to_string(&CandidateStatus::Pending)?)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() != 1 {
            bail!("candidate is missing or no longer pending");
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct CandidateRow {
    id: String,
    world_id: String,
    candidate_type: String,
    source_job_id: Option<String>,
    provider_run_id: Option<String>,
    artifact_ids_json: String,
    payload_json: String,
    status: String,
    created_at: String,
}

impl TryFrom<CandidateRow> for Candidate {
    type Error = anyhow::Error;

    fn try_from(row: CandidateRow) -> Result<Self> {
        let artifact_ids: Vec<String> = from_json(&row.artifact_ids_json)?;
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            candidate_type: enum_from_string(&row.candidate_type)?,
            source_job_id: row
                .source_job_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            provider_run_id: row
                .provider_run_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            artifact_ids: artifact_ids
                .into_iter()
                .map(|value| Uuid::parse_str(&value))
                .collect::<std::result::Result<Vec<_>, _>>()?,
            payload: from_json(&row.payload_json)?,
            status: enum_from_string(&row.status)?,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)?.with_timezone(&Utc),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        db,
        model::{
            CandidateCandidateType, CandidateStatus, ValidationResultStatus, WorldRevisionActorType,
        },
        world_repository::WorldRepository,
    };

    use super::CandidateService;

    #[tokio::test]
    async fn rejects_missing_or_duplicate_artifact_references() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let service = CandidateService::new(pool);
        let world = worlds.create("Artifact Validation").await.unwrap();
        let missing = uuid::Uuid::new_v4();

        assert!(service
            .create(
                world.id,
                CandidateCandidateType::Geometry,
                None,
                None,
                vec![missing],
                json!({}),
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn latest_failed_validation_blocks_acceptance() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let service = CandidateService::new(pool);
        let world = worlds.create("Validation Ordering").await.unwrap();
        let candidate = service
            .create(
                world.id,
                CandidateCandidateType::Geometry,
                None,
                None,
                vec![],
                json!({}),
            )
            .await
            .unwrap();

        service
            .add_validation(
                candidate.id,
                ValidationResultStatus::Passed,
                vec![],
                json!({}),
                "validator",
            )
            .await
            .unwrap();
        service
            .add_validation(
                candidate.id,
                ValidationResultStatus::Failed,
                vec![json!({"type": "POSITION_ERROR"})],
                json!({}),
                "validator",
            )
            .await
            .unwrap();

        assert!(service
            .accept(candidate.id, None, None, WorldRevisionActorType::System)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn candidate_requires_passed_validation_before_revision_acceptance() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let service = CandidateService::new(pool);
        let world = worlds.create("Candidate World").await.unwrap();

        let candidate = service
            .create(
                world.id,
                CandidateCandidateType::Geometry,
                None,
                None,
                vec![],
                json!({"mesh": "candidate"}),
            )
            .await
            .unwrap();

        assert!(service
            .accept(candidate.id, None, None, WorldRevisionActorType::System,)
            .await
            .is_err());

        service
            .add_validation(
                candidate.id,
                ValidationResultStatus::Passed,
                vec![],
                json!({"reprojection_error": 0.01}),
                "geometry-validator-v1",
            )
            .await
            .unwrap();

        let revision = service
            .accept(candidate.id, None, None, WorldRevisionActorType::System)
            .await
            .unwrap();

        let accepted = service.get(candidate.id).await.unwrap().unwrap();
        assert_eq!(accepted.status, CandidateStatus::Accepted);
        assert_eq!(revision.world_id, world.id);
    }
}
