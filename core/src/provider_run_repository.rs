use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    metadata::sanitize_json,
    model::{AIProviderRun, AIProviderRunStatus},
};

impl AIProviderRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "CREATED",
            Self::Submitted => "SUBMITTED",
            Self::Running => "RUNNING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
        }
    }
}

#[derive(Clone)]
pub struct ProviderRunRepository {
    pool: SqlitePool,
}

impl ProviderRunRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        capability: &str,
        provider: &str,
        endpoint: &str,
        input: &Value,
    ) -> Result<AIProviderRun> {
        let now = Utc::now();
        let record = AIProviderRun {
            id: Uuid::new_v4(),
            capability: capability.to_owned(),
            provider: provider.to_owned(),
            endpoint: endpoint.to_owned(),
            status: AIProviderRunStatus::Created,
            request_id: None,
            input: sanitize_json(input),
            status_payload: None,
            result: None,
            output_artifact_ids: Vec::new(),
            error: None,
            submitted_at: None,
            completed_at: None,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            r#"
            INSERT INTO ai_provider_runs(
                id, capability, provider, endpoint, status, input_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.capability)
        .bind(&record.provider)
        .bind(&record.endpoint)
        .bind(record.status.as_str())
        .bind(serde_json::to_string(&record.input)?)
        .bind(record.created_at.to_rfc3339())
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(record)
    }

    pub async fn mark_submitted(&self, id: Uuid, request_id: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE ai_provider_runs
            SET status = ?, request_id = ?, submitted_at = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(AIProviderRunStatus::Submitted.as_str())
        .bind(request_id)
        .bind(&now)
        .bind(&now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_status(&self, id: Uuid, status_payload: &Value) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE ai_provider_runs
            SET status = ?, status_json = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(AIProviderRunStatus::Running.as_str())
        .bind(serde_json::to_string(&sanitize_json(status_payload))?)
        .bind(&now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn complete(
        &self,
        id: Uuid,
        result: &Value,
        output_artifact_ids: &[Uuid],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let artifact_ids: Vec<String> = output_artifact_ids.iter().map(Uuid::to_string).collect();
        sqlx::query(
            r#"
            UPDATE ai_provider_runs
            SET status = ?, result_json = ?, output_artifact_ids_json = ?,
                completed_at = ?, updated_at = ?, error = NULL
            WHERE id = ?
            "#,
        )
        .bind(AIProviderRunStatus::Completed.as_str())
        .bind(serde_json::to_string(&sanitize_json(result))?)
        .bind(serde_json::to_string(&artifact_ids)?)
        .bind(&now)
        .bind(&now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fail(&self, id: Uuid, error: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE ai_provider_runs
            SET status = ?, error = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(AIProviderRunStatus::Failed.as_str())
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<AIProviderRun>> {
        let row = sqlx::query_as::<_, ProviderRunRow>(
            r#"
            SELECT id, capability, provider, endpoint, status, request_id, input_json,
                   status_json, result_json, output_artifact_ids_json, error,
                   submitted_at, completed_at, created_at, updated_at
            FROM ai_provider_runs
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }
}

#[derive(sqlx::FromRow)]
struct ProviderRunRow {
    id: String,
    capability: String,
    provider: String,
    endpoint: String,
    status: String,
    request_id: Option<String>,
    input_json: String,
    status_json: Option<String>,
    result_json: Option<String>,
    output_artifact_ids_json: Option<String>,
    error: Option<String>,
    submitted_at: Option<String>,
    completed_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<ProviderRunRow> for AIProviderRun {
    type Error = anyhow::Error;

    fn try_from(row: ProviderRunRow) -> Result<Self> {
        let status = match row.status.as_str() {
            "CREATED" => AIProviderRunStatus::Created,
            "SUBMITTED" => AIProviderRunStatus::Submitted,
            "RUNNING" => AIProviderRunStatus::Running,
            "COMPLETED" => AIProviderRunStatus::Completed,
            "FAILED" => AIProviderRunStatus::Failed,
            "CANCELLED" => AIProviderRunStatus::Cancelled,
            other => anyhow::bail!("unknown provider run status: {other}"),
        };
        let output_artifact_ids: Vec<String> = row
            .output_artifact_ids_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();

        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            capability: row.capability,
            provider: row.provider,
            endpoint: row.endpoint,
            status,
            request_id: row.request_id,
            input: serde_json::from_str(&row.input_json)?,
            status_payload: row
                .status_json
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()?,
            result: row
                .result_json
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()?,
            output_artifact_ids: output_artifact_ids
                .into_iter()
                .map(|id| Uuid::parse_str(&id))
                .collect::<std::result::Result<Vec<_>, _>>()?,
            error: row.error,
            submitted_at: parse_optional_datetime(row.submitted_at.as_deref())?,
            completed_at: parse_optional_datetime(row.completed_at.as_deref())?,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)
                .context("invalid provider run created_at")?
                .with_timezone(&Utc),
            updated_at: DateTime::parse_from_rfc3339(&row.updated_at)
                .context("invalid provider run updated_at")?
                .with_timezone(&Utc),
        })
    }
}

fn parse_optional_datetime(value: Option<&str>) -> Result<Option<DateTime<Utc>>> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&Utc))
                .context("invalid provider run timestamp")
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::db;

    use super::{AIProviderRunStatus, ProviderRunRepository};

    #[tokio::test]
    async fn persists_provider_run_without_embedded_base64() {
        let pool = db::connect_memory().await.unwrap();
        let repo = ProviderRunRepository::new(pool);
        let run = repo
            .create(
                "OBJECT_3D",
                "hunyuan",
                "fal-ai/hunyuan3d-v3/image-to-3d",
                &json!({"image": "data:image/png;base64,AAAA"}),
            )
            .await
            .unwrap();

        repo.mark_submitted(run.id, "req-1").await.unwrap();
        repo.mark_status(run.id, &json!({"status": "IN_PROGRESS"}))
            .await
            .unwrap();
        repo.complete(
            run.id,
            &json!({"mesh": {"url": "https://cdn/model.glb"}}),
            &[],
        )
        .await
        .unwrap();

        let loaded = repo.get(run.id).await.unwrap().unwrap();
        assert_eq!(loaded.status, AIProviderRunStatus::Completed);
        assert_eq!(loaded.input["image"], "[stripped]");
        assert_eq!(loaded.request_id.as_deref(), Some("req-1"));
    }
}
