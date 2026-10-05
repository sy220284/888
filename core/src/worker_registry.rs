use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    model::{WorkerHeartbeat, WorkerHeartbeatHealth, WorkerRegistration},
    serde_db::{enum_from_string, enum_to_string, to_json},
};

pub const WORKER_PROTOCOL_VERSION: u64 = 1;

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
        let current_jobs: Vec<String> = heartbeat
            .current_job_ids
            .iter()
            .map(Uuid::to_string)
            .collect();

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
        .bind(heartbeat.timestamp.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(heartbeat.worker_id.to_string())
        .execute(&self.pool)
        .await?;

        if result.rows_affected() != 1 {
            bail!("worker must register before heartbeat");
        }
        Ok(())
    }

    pub async fn mark_lost_before(&self, cutoff: DateTime<Utc>) -> Result<u64> {
        let result = sqlx::query(
            r#"
            UPDATE worker_registrations
            SET health = ?, updated_at = ?
            WHERE last_heartbeat_at < ? AND health != ?
            "#,
        )
        .bind(enum_to_string(&WorkerHeartbeatHealth::Lost)?)
        .bind(Utc::now().to_rfc3339())
        .bind(cutoff.to_rfc3339())
        .bind(enum_to_string(&WorkerHeartbeatHealth::Lost)?)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
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
        model::{
            WorkerHeartbeat, WorkerHeartbeatHealth, WorkerRegistration,
            WorkerRegistrationWorkerType,
        },
    };

    use super::{WorkerRegistry, WORKER_PROTOCOL_VERSION};

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
