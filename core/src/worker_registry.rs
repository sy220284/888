use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    job_engine::JobEngine,
    model::{JobState, WorkerHeartbeat, WorkerHeartbeatHealth, WorkerRegistration},
    serde_db::{enum_from_string, enum_to_string, to_json},
    worker_protocol::WORKER_PROTOCOL_VERSION,
};

#[derive(Clone)]
pub struct WorkerRegistry {
    pool: SqlitePool,
}

impl WorkerRegistry {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn register(&self, registration: &WorkerRegistration) -> Result<()> {
        validate_protocol(registration.protocol_version)?;
        let now = Utc::now().to_rfc3339();
        let capabilities = to_json(&registration.capabilities)?;
        let device = to_json(&registration.device)?;
        let software = to_json(&registration.software)?;

        sqlx::query(
            r#"
            INSERT INTO worker_registrations(
                worker_id, worker_type, protocol_version, capabilities_json,
                device_json, software_json, health, current_job_ids_json,
                last_heartbeat_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
            ON CONFLICT(worker_id) DO UPDATE SET
                worker_type = excluded.worker_type,
                protocol_version = excluded.protocol_version,
                capabilities_json = excluded.capabilities_json,
                device_json = excluded.device_json,
                software_json = excluded.software_json,
                health = excluded.health,
                current_job_ids_json = '[]',
                last_heartbeat_at = excluded.last_heartbeat_at,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(registration.worker_id.to_string())
        .bind(enum_to_string(&registration.worker_type)?)
        .bind(
            i64::try_from(registration.protocol_version)
                .context("worker protocol_version too large")?,
        )
        .bind(capabilities)
        .bind(device)
        .bind(software)
        .bind(enum_to_string(&WorkerHeartbeatHealth::Healthy)?)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn heartbeat(&self, heartbeat: &WorkerHeartbeat) -> Result<()> {
        validate_protocol(heartbeat.protocol_version)?;
        if heartbeat.health == WorkerHeartbeatHealth::Lost {
            bail!("worker cannot self-report LOST; Core owns lost detection");
        }
        for job_id in &heartbeat.current_job_ids {
            let row = sqlx::query_as::<_, HeartbeatJobRow>(
                "SELECT state, assigned_worker_id FROM jobs WHERE id = ?",
            )
            .bind(job_id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .context("heartbeat references unknown job")?;

            let state: JobState = enum_from_string(&row.state)?;
            if !matches!(state, JobState::Running | JobState::Pausing) {
                bail!("heartbeat references job that is not running");
            }
            if row.assigned_worker_id.as_deref() != Some(&heartbeat.worker_id.to_string()) {
                bail!("heartbeat references job assigned to another worker");
            }
        }

        let current_jobs: Vec<String> = heartbeat
            .current_job_ids
            .iter()
            .map(Uuid::to_string)
            .collect();

        let received_at = Utc::now();
        let result = sqlx::query(
            r#"
            UPDATE worker_registrations
            SET health = ?, current_job_ids_json = ?, cpu_usage = ?, ram_mb = ?,
                gpu_usage = ?, vram_mb = ?, last_heartbeat_at = ?, updated_at = ?
            WHERE worker_id = ?
            "#,
        )
        .bind(enum_to_string(&heartbeat.health)?)
        .bind(to_json(&current_jobs)?)
        .bind(heartbeat.cpu_usage)
        .bind(i64::try_from(heartbeat.ram_mb).context("ram_mb too large")?)
        .bind(heartbeat.gpu_usage)
        .bind(
            heartbeat
                .vram_mb
                .map(i64::try_from)
                .transpose()
                .context("vram_mb too large")?,
        )
        .bind(received_at.to_rfc3339())
        .bind(received_at.to_rfc3339())
        .bind(heartbeat.worker_id.to_string())
        .execute(&self.pool)
        .await?;

        if result.rows_affected() != 1 {
            bail!("worker must register before heartbeat");
        }
        Ok(())
    }

    pub async fn mark_lost_before(&self, cutoff: DateTime<Utc>) -> Result<u64> {
        let workers: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT worker_id
            FROM worker_registrations
            WHERE last_heartbeat_at < ? AND health != ?
            "#,
        )
        .bind(cutoff.to_rfc3339())
        .bind(enum_to_string(&WorkerHeartbeatHealth::Lost)?)
        .fetch_all(&self.pool)
        .await?;

        let jobs = JobEngine::new(self.pool.clone());
        let mut marked = 0_u64;
        for worker_id in workers {
            let result = sqlx::query(
                r#"
                UPDATE worker_registrations
                SET health = ?, current_job_ids_json = '[]', updated_at = ?
                WHERE worker_id = ? AND last_heartbeat_at < ? AND health != ?
                "#,
            )
            .bind(enum_to_string(&WorkerHeartbeatHealth::Lost)?)
            .bind(Utc::now().to_rfc3339())
            .bind(&worker_id)
            .bind(cutoff.to_rfc3339())
            .bind(enum_to_string(&WorkerHeartbeatHealth::Lost)?)
            .execute(&self.pool)
            .await?;

            if result.rows_affected() == 1 {
                marked += 1;
                jobs.recover_worker_lost(Uuid::parse_str(&worker_id)?)
                    .await?;
            }
        }
        Ok(marked)
    }

    pub async fn health(&self, worker_id: Uuid) -> Result<Option<WorkerHeartbeatHealth>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT health FROM worker_registrations WHERE worker_id = ?")
                .bind(worker_id.to_string())
                .fetch_optional(&self.pool)
                .await?;
        value.as_deref().map(enum_from_string).transpose()
    }
}

#[derive(sqlx::FromRow)]
struct HeartbeatJobRow {
    state: String,
    assigned_worker_id: Option<String>,
}

fn validate_protocol(version: u64) -> Result<()> {
    if version != WORKER_PROTOCOL_VERSION {
        bail!(
            "worker protocol mismatch: expected {}, got {}",
            WORKER_PROTOCOL_VERSION,
            version
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::json;
    use uuid::Uuid;

    use crate::{
        db,
        job_engine::JobEngine,
        model::{
            WorkerHeartbeat, WorkerHeartbeatHealth, WorkerRegistration,
            WorkerRegistrationWorkerType,
        },
    };

    use crate::worker_protocol::WORKER_PROTOCOL_VERSION;

    use super::WorkerRegistry;

    #[tokio::test]
    async fn registration_heartbeat_and_lost_detection_are_core_owned() {
        let pool = db::connect_memory().await.unwrap();
        let registry = WorkerRegistry::new(pool);
        let worker_id = Uuid::new_v4();
        let registration = WorkerRegistration {
            worker_id,
            worker_type: WorkerRegistrationWorkerType::Vision,
            protocol_version: WORKER_PROTOCOL_VERSION,
            capabilities: vec!["DEPTH".into(), "MATCHING".into()],
            device: json!({"device": "cpu"}),
            software: json!({"worker_version": "0.1.0"}),
        };
        registry.register(&registration).await.unwrap();

        let heartbeat = WorkerHeartbeat {
            worker_id,
            protocol_version: WORKER_PROTOCOL_VERSION,
            timestamp: Utc::now(),
            current_job_ids: vec![],
            cpu_usage: 0.2,
            ram_mb: 512,
            gpu_usage: None,
            vram_mb: None,
            health: WorkerHeartbeatHealth::Healthy,
        };
        registry.heartbeat(&heartbeat).await.unwrap();
        assert_eq!(
            registry.health(worker_id).await.unwrap(),
            Some(WorkerHeartbeatHealth::Healthy)
        );

        let lost = registry
            .mark_lost_before(Utc::now() + Duration::seconds(1))
            .await
            .unwrap();
        assert_eq!(lost, 1);
        assert_eq!(
            registry.health(worker_id).await.unwrap(),
            Some(WorkerHeartbeatHealth::Lost)
        );
    }

    #[tokio::test]
    async fn lost_worker_recovers_assigned_running_job() {
        let pool = db::connect_memory().await.unwrap();
        let registry = WorkerRegistry::new(pool.clone());
        let jobs = JobEngine::new(pool.clone());
        let worker_id = Uuid::new_v4();

        registry
            .register(&WorkerRegistration {
                worker_id,
                worker_type: WorkerRegistrationWorkerType::Vision,
                protocol_version: WORKER_PROTOCOL_VERSION,
                capabilities: vec!["DEPTH".into()],
                device: json!({}),
                software: json!({}),
            })
            .await
            .unwrap();

        let job = jobs.create(None, "DEPTH", 3, true).await.unwrap();
        jobs.transition(job.id, crate::model::JobState::Ready)
            .await
            .unwrap();
        let running = jobs.start_on_worker(job.id, worker_id).await.unwrap();
        assert_eq!(running.assigned_worker_id, Some(worker_id));

        registry
            .heartbeat(&WorkerHeartbeat {
                worker_id,
                protocol_version: WORKER_PROTOCOL_VERSION,
                timestamp: Utc::now() - Duration::hours(3),
                current_job_ids: vec![job.id],
                cpu_usage: 0.3,
                ram_mb: 256,
                gpu_usage: None,
                vram_mb: None,
                health: WorkerHeartbeatHealth::Healthy,
            })
            .await
            .unwrap();

        let marked = registry
            .mark_lost_before(Utc::now() + Duration::seconds(1))
            .await
            .unwrap();
        assert_eq!(marked, 1);

        let recovered = jobs.get(job.id).await.unwrap().unwrap();
        assert_eq!(recovered.state, crate::model::JobState::Ready);
        assert_eq!(recovered.assigned_worker_id, None);

        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_events WHERE job_id = ? AND event_type = 'WORKER_LOST'",
        )
        .bind(job.id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(events, 1);
    }

    #[tokio::test]
    async fn rejects_worker_owned_lost_state_and_unknown_jobs() {
        let pool = db::connect_memory().await.unwrap();
        let registry = WorkerRegistry::new(pool);
        let worker_id = Uuid::new_v4();
        let registration = WorkerRegistration {
            worker_id,
            worker_type: WorkerRegistrationWorkerType::Vision,
            protocol_version: WORKER_PROTOCOL_VERSION,
            capabilities: vec![],
            device: json!({}),
            software: json!({}),
        };
        registry.register(&registration).await.unwrap();

        let lost = WorkerHeartbeat {
            worker_id,
            protocol_version: WORKER_PROTOCOL_VERSION,
            timestamp: Utc::now(),
            current_job_ids: vec![],
            cpu_usage: 0.0,
            ram_mb: 0,
            gpu_usage: None,
            vram_mb: None,
            health: WorkerHeartbeatHealth::Lost,
        };
        assert!(registry.heartbeat(&lost).await.is_err());

        let unknown_job = WorkerHeartbeat {
            health: WorkerHeartbeatHealth::Healthy,
            current_job_ids: vec![Uuid::new_v4()],
            ..lost
        };
        assert!(registry.heartbeat(&unknown_job).await.is_err());
    }

    #[tokio::test]
    async fn rejects_incompatible_worker_protocol() {
        let pool = db::connect_memory().await.unwrap();
        let registry = WorkerRegistry::new(pool);
        let registration = WorkerRegistration {
            worker_id: Uuid::new_v4(),
            worker_type: WorkerRegistrationWorkerType::Tool,
            protocol_version: 999,
            capabilities: vec![],
            device: json!({}),
            software: json!({}),
        };
        assert!(registry.register(&registration).await.is_err());
    }
}
