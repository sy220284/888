use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    model::{Job, JobState},
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
};

#[derive(Clone)]
pub struct JobEngine {
    pool: SqlitePool,
}

impl JobEngine {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        world_id: Option<Uuid>,
        task_type: &str,
        max_attempts: i64,
    ) -> Result<Job> {
        let task_type = task_type.trim();
        if task_type.is_empty() {
            bail!("task_type must not be empty");
        }
        if max_attempts < 1 {
            bail!("max_attempts must be at least 1");
        }

        let now = Utc::now();
        let job = Job {
            id: Uuid::new_v4(),
            world_id,
            task_type: task_type.to_owned(),
            state: JobState::Created,
            attempt: 0,
            max_attempts,
            checkpoint_artifact_id: None,
            provider_run_id: None,
            error_code: None,
            error_payload: None,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            r#"
            INSERT INTO jobs(
                id, world_id, task_type, state, attempt, max_attempts,
                checkpoint_artifact_id, provider_run_id, error_code,
                error_payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
            "#,
        )
        .bind(job.id.to_string())
        .bind(job.world_id.map(|value| value.to_string()))
        .bind(&job.task_type)
        .bind(enum_to_string(&job.state)?)
        .bind(job.attempt as i64)
        .bind(job.max_attempts)
        .bind(job.created_at.to_rfc3339())
        .bind(job.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(job)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Job>> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, state, attempt, max_attempts,
                   checkpoint_artifact_id, provider_run_id, error_code,
                   error_payload_json, created_at, updated_at
            FROM jobs
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn transition(&self, id: Uuid, target: JobState) -> Result<Job> {
        let current = self.get(id).await?.context("job does not exist")?;
        if current.state == target {
            return Ok(current);
        }
        if !can_transition(current.state, target) {
            bail!(
                "illegal job transition: {} -> {}",
                enum_to_string(&current.state)?,
                enum_to_string(&target)?
            );
        }

        let next_attempt = if target == JobState::Running {
            current.attempt.saturating_add(1)
        } else {
            current.attempt
        };
        if target == JobState::Running && next_attempt > current.max_attempts as u64 {
            bail!("job exceeded max_attempts");
        }

        let now = Utc::now();
        let result = sqlx::query(
            r#"
            UPDATE jobs
            SET state = ?, attempt = ?, updated_at = ?
            WHERE id = ? AND state = ?
            "#,
        )
        .bind(enum_to_string(&target)?)
        .bind(next_attempt as i64)
        .bind(now.to_rfc3339())
        .bind(id.to_string())
        .bind(enum_to_string(&current.state)?)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() != 1 {
            bail!("job state changed concurrently");
        }
        self.get(id)
            .await?
            .context("job disappeared after transition")
    }

    pub async fn request_cancel(&self, id: Uuid) -> Result<Job> {
        let current = self.get(id).await?.context("job does not exist")?;
        if current.state == JobState::Cancelled {
            return Ok(current);
        }
        if matches!(current.state, JobState::Completed | JobState::Failed) {
            bail!("terminal job cannot be cancelled");
        }
        self.transition(id, JobState::Cancelled).await
    }

    pub async fn set_checkpoint(&self, id: Uuid, artifact_id: Uuid) -> Result<()> {
        let result =
            sqlx::query("UPDATE jobs SET checkpoint_artifact_id = ?, updated_at = ? WHERE id = ?")
                .bind(artifact_id.to_string())
                .bind(Utc::now().to_rfc3339())
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        if result.rows_affected() != 1 {
            bail!("job does not exist");
        }
        Ok(())
    }

    pub async fn fail(&self, id: Uuid, code: &str, payload: Option<Value>) -> Result<Job> {
        let current = self.get(id).await?.context("job does not exist")?;
        if matches!(current.state, JobState::Completed | JobState::Cancelled) {
            bail!("completed or cancelled job cannot fail");
        }
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            UPDATE jobs
            SET state = ?, error_code = ?, error_payload_json = ?, updated_at = ?
            WHERE id = ? AND state = ?
            "#,
        )
        .bind(enum_to_string(&JobState::Failed)?)
        .bind(code)
        .bind(payload.as_ref().map(to_json).transpose()?)
        .bind(now.to_rfc3339())
        .bind(id.to_string())
        .bind(enum_to_string(&current.state)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!("job state changed concurrently");
        }
        self.get(id).await?.context("job disappeared after failure")
    }

    pub async fn recover_interrupted(&self) -> Result<Vec<Job>> {
        let running = enum_to_string(&JobState::Running)?;
        let rows = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, state, attempt, max_attempts,
                   checkpoint_artifact_id, provider_run_id, error_code,
                   error_payload_json, created_at, updated_at
            FROM jobs
            WHERE state = ?
            "#,
        )
        .bind(running)
        .fetch_all(&self.pool)
        .await?;

        let mut recovered = Vec::with_capacity(rows.len());
        for row in rows {
            let job: Job = row.try_into()?;
            let target = if job.checkpoint_artifact_id.is_some() {
                JobState::Recoverable
            } else if job.attempt < job.max_attempts as u64 {
                JobState::Ready
            } else {
                JobState::Failed
            };
            let now = Utc::now();
            sqlx::query("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
                .bind(enum_to_string(&target)?)
                .bind(now.to_rfc3339())
                .bind(job.id.to_string())
                .bind(enum_to_string(&JobState::Running)?)
                .execute(&self.pool)
                .await?;

            if let Some(updated) = self.get(job.id).await? {
                recovered.push(updated);
            }
        }
        Ok(recovered)
    }
}

fn can_transition(from: JobState, to: JobState) -> bool {
    use JobState::*;
    matches!(
        (from, to),
        (Created, Pending)
            | (Created, Ready)
            | (Created, Cancelled)
            | (Pending, Ready)
            | (Pending, Blocked)
            | (Pending, Cancelled)
            | (Ready, Running)
            | (Ready, WaitingResource)
            | (Ready, WaitingProvider)
            | (Ready, WaitingUser)
            | (Ready, Cancelled)
            | (WaitingResource, Ready)
            | (WaitingResource, Failed)
            | (WaitingResource, Cancelled)
            | (WaitingProvider, Ready)
            | (WaitingProvider, Failed)
            | (WaitingProvider, Cancelled)
            | (WaitingUser, Ready)
            | (WaitingUser, Failed)
            | (WaitingUser, Cancelled)
            | (Running, Pausing)
            | (Running, Recoverable)
            | (Running, Failed)
            | (Running, Cancelled)
            | (Running, Completed)
            | (Pausing, Paused)
            | (Pausing, Failed)
            | (Pausing, Cancelled)
            | (Paused, Ready)
            | (Paused, Cancelled)
            | (Recoverable, Ready)
            | (Recoverable, Failed)
            | (Recoverable, Cancelled)
            | (Blocked, Ready)
            | (Blocked, Failed)
            | (Blocked, Cancelled)
    )
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: String,
    world_id: Option<String>,
    task_type: String,
    state: String,
    attempt: i64,
    max_attempts: i64,
    checkpoint_artifact_id: Option<String>,
    provider_run_id: Option<String>,
    error_code: Option<String>,
    error_payload_json: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<JobRow> for Job {
    type Error = anyhow::Error;

    fn try_from(row: JobRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: row.world_id.as_deref().map(Uuid::parse_str).transpose()?,
            task_type: row.task_type,
            state: enum_from_string(&row.state)?,
            attempt: u64::try_from(row.attempt).context("negative job attempt")?,
            max_attempts: row.max_attempts,
            checkpoint_artifact_id: row
                .checkpoint_artifact_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            provider_run_id: row
                .provider_run_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            error_code: row.error_code,
            error_payload: row
                .error_payload_json
                .as_deref()
                .map(from_json)
                .transpose()?,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)?.with_timezone(&Utc),
            updated_at: DateTime::parse_from_rfc3339(&row.updated_at)?.with_timezone(&Utc),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{db, model::JobState};

    use super::JobEngine;

    #[tokio::test]
    async fn enforces_job_state_machine_and_cancel_idempotency() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "TEST", 2).await.unwrap();

        assert!(jobs.transition(job.id, JobState::Running).await.is_err());
        jobs.transition(job.id, JobState::Ready).await.unwrap();
        let running = jobs.transition(job.id, JobState::Running).await.unwrap();
        assert_eq!(running.attempt, 1);

        let cancelled = jobs.request_cancel(job.id).await.unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);
        let repeated = jobs.request_cancel(job.id).await.unwrap();
        assert_eq!(repeated.state, JobState::Cancelled);
    }

    #[tokio::test]
    async fn recovers_interrupted_running_jobs_without_pretending_they_are_running() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "RECOVER", 3).await.unwrap();
        jobs.transition(job.id, JobState::Ready).await.unwrap();
        jobs.transition(job.id, JobState::Running).await.unwrap();

        let recovered = jobs.recover_interrupted().await.unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, JobState::Ready);
    }
}
