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
        max_attempts: u64,
        idempotent: bool,
    ) -> Result<Job> {
        self.create_with_input(
            world_id,
            task_type,
            Value::Object(Default::default()),
            max_attempts,
            idempotent,
        )
        .await
    }

    pub async fn create_with_input(
        &self,
        world_id: Option<Uuid>,
        task_type: &str,
        input: Value,
        max_attempts: u64,
        idempotent: bool,
    ) -> Result<Job> {
        let task_type = task_type.trim();
        if task_type.is_empty() {
            bail!("task_type must not be empty");
        }
        if !input.is_object() {
            bail!("job input must be a JSON object");
        }
        if max_attempts < 1 {
            bail!("max_attempts must be at least 1");
        }

        let now = Utc::now();
        let job = Job {
            id: Uuid::new_v4(),
            world_id,
            task_type: task_type.to_owned(),
            input,
            state: JobState::Created,
            attempt: 0,
            max_attempts,
            idempotent,
            assigned_worker_id: None,
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
                id, world_id, task_type, input_json, state, attempt, max_attempts, idempotent,
                assigned_worker_id, checkpoint_artifact_id, provider_run_id, error_code,
                error_payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
            "#,
        )
        .bind(job.id.to_string())
        .bind(job.world_id.map(|value| value.to_string()))
        .bind(&job.task_type)
        .bind(to_json(&job.input)?)
        .bind(enum_to_string(&job.state)?)
        .bind(job.attempt as i64)
        .bind(i64::try_from(job.max_attempts).context("max_attempts too large")?)
        .bind(job.idempotent)
        .bind(job.created_at.to_rfc3339())
        .bind(job.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(job)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Job>> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, input_json, state, attempt, max_attempts, idempotent,
                   assigned_worker_id, checkpoint_artifact_id, provider_run_id, error_code,
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

    pub async fn list_ready(&self, limit: u64) -> Result<Vec<Job>> {
        let limit = i64::try_from(limit.max(1)).context("ready job limit too large")?;
        let rows = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, input_json, state, attempt, max_attempts, idempotent,
                   assigned_worker_id, checkpoint_artifact_id, provider_run_id, error_code,
                   error_payload_json, created_at, updated_at
            FROM jobs
            WHERE state = ? AND assigned_worker_id IS NULL
            ORDER BY created_at, id
            LIMIT ?
            "#,
        )
        .bind(enum_to_string(&JobState::Ready)?)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn add_dependency(
        &self,
        job_id: Uuid,
        dependency_job_id: Uuid,
        optional: bool,
    ) -> Result<()> {
        if job_id == dependency_job_id {
            bail!("job cannot depend on itself");
        }

        let job = self.get(job_id).await?.context("job does not exist")?;
        let dependency = self
            .get(dependency_job_id)
            .await?
            .context("dependency job does not exist")?;

        if let (Some(job_world), Some(dependency_world)) = (job.world_id, dependency.world_id) {
            if job_world != dependency_world {
                bail!("job dependency cannot cross worlds");
            }
        }

        let creates_cycle: Option<i64> = sqlx::query_scalar(
            r#"
            WITH RECURSIVE reachable(id) AS (
                SELECT dependency_job_id
                FROM job_dependencies
                WHERE job_id = ?
                UNION
                SELECT jd.dependency_job_id
                FROM job_dependencies jd
                JOIN reachable r ON jd.job_id = r.id
            )
            SELECT 1
            FROM reachable
            WHERE id = ?
            LIMIT 1
            "#,
        )
        .bind(dependency_job_id.to_string())
        .bind(job_id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        if creates_cycle.is_some() {
            bail!("job dependency would create a cycle");
        }

        sqlx::query(
            r#"
            INSERT INTO job_dependencies(job_id, dependency_job_id, optional)
            VALUES (?, ?, ?)
            ON CONFLICT(job_id, dependency_job_id)
            DO UPDATE SET optional = excluded.optional
            "#,
        )
        .bind(job_id.to_string())
        .bind(dependency_job_id.to_string())
        .bind(optional)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn resolve_dependencies(&self, id: Uuid) -> Result<Job> {
        let current = self.get(id).await?.context("job does not exist")?;
        if !matches!(
            current.state,
            JobState::Created | JobState::Pending | JobState::Blocked
        ) {
            bail!("job dependencies can only be resolved before execution");
        }

        let rows = sqlx::query_as::<_, DependencyStateRow>(
            r#"
            SELECT jd.optional, dep.state
            FROM job_dependencies jd
            JOIN jobs dep ON dep.id = jd.dependency_job_id
            WHERE jd.job_id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_all(&self.pool)
        .await?;

        let mut required_pending = false;
        let mut required_failed = false;
        for row in rows {
            if row.optional {
                continue;
            }
            let state: JobState = enum_from_string(&row.state)?;
            match state {
                JobState::Completed => {}
                JobState::Failed | JobState::Cancelled => required_failed = true,
                _ => required_pending = true,
            }
        }

        let target = if required_failed {
            JobState::Blocked
        } else if required_pending {
            JobState::Pending
        } else {
            JobState::Ready
        };

        if current.state == target {
            return Ok(current);
        }
        if current.state == JobState::Created && target == JobState::Blocked {
            self.transition(id, JobState::Pending).await?;
        }
        self.transition(id, target).await
    }

    pub async fn start_on_worker(&self, id: Uuid, worker_id: Uuid) -> Result<Job> {
        let current = self.get(id).await?.context("job does not exist")?;
        if current.state != JobState::Ready {
            bail!("job must be READY before worker start");
        }

        let health: Option<String> =
            sqlx::query_scalar("SELECT health FROM worker_registrations WHERE worker_id = ?")
                .bind(worker_id.to_string())
                .fetch_optional(&self.pool)
                .await?;
        let health = health.context("worker is not registered")?;
        let healthy = matches!(
            enum_from_string::<crate::model::WorkerHeartbeatHealth>(&health)?,
            crate::model::WorkerHeartbeatHealth::Healthy
                | crate::model::WorkerHeartbeatHealth::Degraded
        );
        if !healthy {
            bail!("worker is not available for scheduling");
        }

        let next_attempt = current.attempt.saturating_add(1);
        if next_attempt > current.max_attempts {
            bail!("job exceeded max_attempts");
        }

        let now = Utc::now();
        let result = sqlx::query(
            r#"
            UPDATE jobs
            SET state = ?, attempt = ?, assigned_worker_id = ?, updated_at = ?
            WHERE id = ? AND state = ? AND assigned_worker_id IS NULL
            "#,
        )
        .bind(enum_to_string(&JobState::Running)?)
        .bind(next_attempt as i64)
        .bind(worker_id.to_string())
        .bind(now.to_rfc3339())
        .bind(id.to_string())
        .bind(enum_to_string(&JobState::Ready)?)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() != 1 {
            bail!("job state or worker assignment changed concurrently");
        }
        self.record_event(
            id,
            "WORKER_ASSIGNED",
            serde_json::json!({"worker_id": worker_id}),
        )
        .await?;
        self.get(id)
            .await?
            .context("job disappeared after worker start")
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
        if target == JobState::Running && next_attempt > current.max_attempts {
            bail!("job exceeded max_attempts");
        }

        let now = Utc::now();
        let assigned_worker_id = if releases_worker(target) {
            None
        } else {
            current.assigned_worker_id
        };
        let result = sqlx::query(
            r#"
            UPDATE jobs
            SET state = ?, attempt = ?, assigned_worker_id = ?, updated_at = ?
            WHERE id = ? AND state = ?
            "#,
        )
        .bind(enum_to_string(&target)?)
        .bind(next_attempt as i64)
        .bind(assigned_worker_id.map(|value| value.to_string()))
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
        if current.assigned_worker_id.is_some()
            && matches!(current.state, JobState::Running | JobState::Pausing)
        {
            self.record_event(
                id,
                "CANCEL_REQUESTED",
                serde_json::json!({"assigned_worker_id": current.assigned_worker_id}),
            )
            .await?;
            return Ok(current);
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
        if current.state == JobState::Failed {
            return Ok(current);
        }
        if !can_transition(current.state, JobState::Failed) {
            bail!(
                "illegal job transition: {} -> {}",
                enum_to_string(&current.state)?,
                enum_to_string(&JobState::Failed)?
            );
        }
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            UPDATE jobs
            SET state = ?, assigned_worker_id = NULL,
                error_code = ?, error_payload_json = ?, updated_at = ?
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

    pub async fn recover_worker_lost(&self, worker_id: Uuid) -> Result<Vec<Job>> {
        let rows = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, input_json, state, attempt, max_attempts, idempotent,
                   assigned_worker_id, checkpoint_artifact_id, provider_run_id, error_code,
                   error_payload_json, created_at, updated_at
            FROM jobs
            WHERE assigned_worker_id = ? AND state IN (?, ?)
            "#,
        )
        .bind(worker_id.to_string())
        .bind(enum_to_string(&JobState::Running)?)
        .bind(enum_to_string(&JobState::Pausing)?)
        .fetch_all(&self.pool)
        .await?;

        let mut recovered = Vec::with_capacity(rows.len());
        for row in rows {
            let job: Job = row.try_into()?;
            let target = recovery_target(&job);
            let result = sqlx::query(
                r#"
                UPDATE jobs
                SET state = ?, assigned_worker_id = NULL, updated_at = ?
                WHERE id = ? AND assigned_worker_id = ? AND state IN (?, ?)
                "#,
            )
            .bind(enum_to_string(&target)?)
            .bind(Utc::now().to_rfc3339())
            .bind(job.id.to_string())
            .bind(worker_id.to_string())
            .bind(enum_to_string(&JobState::Running)?)
            .bind(enum_to_string(&JobState::Pausing)?)
            .execute(&self.pool)
            .await?;
            if result.rows_affected() == 1 {
                self.record_event(
                    job.id,
                    "WORKER_LOST",
                    serde_json::json!({
                        "worker_id": worker_id,
                        "recovered_to": enum_to_string(&target)?,
                    }),
                )
                .await?;
                if let Some(updated) = self.get(job.id).await? {
                    recovered.push(updated);
                }
            }
        }
        Ok(recovered)
    }

    pub async fn record_event(&self, id: Uuid, event_type: &str, payload: Value) -> Result<()> {
        let event_type = event_type.trim();
        if event_type.is_empty() {
            bail!("job event_type must not be empty");
        }
        sqlx::query(
            r#"
            INSERT INTO job_events(id, job_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(id.to_string())
        .bind(event_type)
        .bind(to_json(&payload)?)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn recover_interrupted(&self) -> Result<Vec<Job>> {
        let running = enum_to_string(&JobState::Running)?;
        let rows = sqlx::query_as::<_, JobRow>(
            r#"
            SELECT id, world_id, task_type, input_json, state, attempt, max_attempts, idempotent,
                   assigned_worker_id, checkpoint_artifact_id, provider_run_id, error_code,
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
            let target = recovery_target(&job);
            let now = Utc::now();
            sqlx::query(
                "UPDATE jobs SET state = ?, assigned_worker_id = NULL, updated_at = ? WHERE id = ? AND state = ?",
            )
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

fn recovery_target(job: &Job) -> JobState {
    if job.checkpoint_artifact_id.is_some() {
        JobState::Recoverable
    } else if job.idempotent && job.attempt < job.max_attempts {
        JobState::Ready
    } else {
        JobState::Failed
    }
}

fn releases_worker(state: JobState) -> bool {
    matches!(
        state,
        JobState::Ready
            | JobState::Paused
            | JobState::Recoverable
            | JobState::Failed
            | JobState::Cancelled
            | JobState::Completed
            | JobState::Blocked
    )
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
            | (Pausing, Completed)
            | (Pausing, Failed)
            | (Pausing, Cancelled)
            | (Paused, Ready)
            | (Paused, Cancelled)
            | (Recoverable, Ready)
            | (Recoverable, Failed)
            | (Recoverable, Cancelled)
            | (Blocked, Pending)
            | (Blocked, Ready)
            | (Blocked, Failed)
            | (Blocked, Cancelled)
    )
}

#[derive(sqlx::FromRow)]
struct DependencyStateRow {
    optional: bool,
    state: String,
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: String,
    world_id: Option<String>,
    task_type: String,
    input_json: String,
    state: String,
    attempt: i64,
    max_attempts: i64,
    idempotent: bool,
    assigned_worker_id: Option<String>,
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
            input: from_json(&row.input_json)?,
            state: enum_from_string(&row.state)?,
            attempt: u64::try_from(row.attempt).context("negative job attempt")?,
            max_attempts: u64::try_from(row.max_attempts).context("negative max_attempts")?,
            idempotent: row.idempotent,
            assigned_worker_id: row
                .assigned_worker_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
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
    async fn create_with_input_persists_structured_input() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs
            .create_with_input(
                None,
                "ANALYZE_IMAGE",
                serde_json::json!({"observation_id": "obs-1"}),
                2,
                true,
            )
            .await
            .unwrap();

        let loaded = jobs.get(job.id).await.unwrap().unwrap();
        assert_eq!(loaded.input["observation_id"], "obs-1");
        assert!(loaded.assigned_worker_id.is_none());
    }

    #[tokio::test]
    async fn enforces_job_state_machine_and_cancel_idempotency() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "TEST", 2, true).await.unwrap();

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
    async fn pause_race_allows_completed_result() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "TEST", 1, true).await.unwrap();

        jobs.transition(job.id, JobState::Ready).await.unwrap();
        jobs.transition(job.id, JobState::Running).await.unwrap();
        jobs.transition(job.id, JobState::Pausing).await.unwrap();
        let completed = jobs
            .transition(job.id, JobState::Completed)
            .await
            .unwrap();

        assert_eq!(completed.state, JobState::Completed);
    }

    #[tokio::test]
    async fn failure_cannot_bypass_job_state_machine() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "TEST", 1, true).await.unwrap();

        assert!(jobs.fail(job.id, "EARLY_FAILURE", None).await.is_err());
        jobs.transition(job.id, JobState::Ready).await.unwrap();
        assert!(jobs.fail(job.id, "READY_FAILURE", None).await.is_err());

        jobs.transition(job.id, JobState::Running).await.unwrap();
        let failed = jobs.fail(job.id, "RUNNING_FAILURE", None).await.unwrap();
        assert_eq!(failed.state, JobState::Failed);
    }

    #[tokio::test]
    async fn resolves_required_and_optional_dependencies_without_cycles() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);

        let root = jobs.create(None, "ROOT", 1, true).await.unwrap();
        let required = jobs.create(None, "REQUIRED", 1, true).await.unwrap();
        let optional = jobs.create(None, "OPTIONAL", 1, true).await.unwrap();

        jobs.add_dependency(root.id, required.id, false)
            .await
            .unwrap();
        jobs.add_dependency(root.id, optional.id, true)
            .await
            .unwrap();
        assert!(jobs
            .add_dependency(required.id, root.id, false)
            .await
            .is_err());

        let pending = jobs.resolve_dependencies(root.id).await.unwrap();
        assert_eq!(pending.state, JobState::Pending);

        jobs.transition(required.id, JobState::Ready).await.unwrap();
        jobs.transition(required.id, JobState::Running)
            .await
            .unwrap();
        jobs.transition(required.id, JobState::Completed)
            .await
            .unwrap();

        jobs.transition(optional.id, JobState::Ready).await.unwrap();
        jobs.transition(optional.id, JobState::Running)
            .await
            .unwrap();
        jobs.fail(optional.id, "OPTIONAL_FAILED", None)
            .await
            .unwrap();

        let ready = jobs.resolve_dependencies(root.id).await.unwrap();
        assert_eq!(ready.state, JobState::Ready);
    }

    #[tokio::test]
    async fn required_dependency_failure_blocks_job() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);

        let root = jobs.create(None, "ROOT", 1, true).await.unwrap();
        let required = jobs.create(None, "REQUIRED", 1, true).await.unwrap();
        jobs.add_dependency(root.id, required.id, false)
            .await
            .unwrap();

        jobs.transition(required.id, JobState::Ready).await.unwrap();
        jobs.transition(required.id, JobState::Running)
            .await
            .unwrap();
        jobs.fail(required.id, "FAILED", None).await.unwrap();

        let blocked = jobs.resolve_dependencies(root.id).await.unwrap();
        assert_eq!(blocked.state, JobState::Blocked);
    }

    #[tokio::test]
    async fn non_idempotent_interrupted_job_fails_without_checkpoint() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "NON_IDEMPOTENT", 3, false).await.unwrap();
        jobs.transition(job.id, JobState::Ready).await.unwrap();
        jobs.transition(job.id, JobState::Running).await.unwrap();

        let recovered = jobs.recover_interrupted().await.unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, JobState::Failed);
    }

    #[tokio::test]
    async fn recovers_interrupted_running_jobs_without_pretending_they_are_running() {
        let pool = db::connect_memory().await.unwrap();
        let jobs = JobEngine::new(pool);
        let job = jobs.create(None, "RECOVER", 3, true).await.unwrap();
        jobs.transition(job.id, JobState::Ready).await.unwrap();
        jobs.transition(job.id, JobState::Running).await.unwrap();

        let recovered = jobs.recover_interrupted().await.unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, JobState::Ready);
    }
}
