use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    candidate_service::CandidateService,
    entity_service::EntityService,
    job_engine::JobEngine,
    model::{
        Command, CommandResponse, CommandResponseStatus, CommandType, JobState,
        WorldRevisionActorType,
    },
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
    world_repository::WorldRepository,
};

const COMMAND_LEASE_SECONDS: i64 = 30;

#[derive(Clone)]
pub struct CommandService {
    pool: SqlitePool,
    worlds: WorldRepository,
    jobs: JobEngine,
    candidates: CandidateService,
    entities: EntityService,
}

impl CommandService {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            worlds: WorldRepository::new(pool.clone()),
            jobs: JobEngine::new(pool.clone()),
            candidates: CandidateService::new(pool.clone()),
            entities: EntityService::new(pool.clone()),
            pool,
        }
    }

    pub async fn execute(&self, command: &Command) -> Result<CommandResponse> {
        let owner = Uuid::new_v4();
        match self.claim(command, owner).await? {
            ClaimOutcome::Finished(response) => return Ok(response),
            ClaimOutcome::Busy => return Ok(accepted(command.command_id)),
            ClaimOutcome::Claimed => {}
        }

        let response = match self.execute_new(command).await {
            Ok(response) => response,
            Err(error) => CommandResponse {
                command_id: command.command_id,
                status: CommandResponseStatus::Rejected,
                job_ids: Vec::new(),
                result: None,
                error: Some(json!({"message": error.to_string()})),
            },
        };

        self.persist_response(&response, owner).await?;
        Ok(response)
    }

    pub async fn get_response(&self, command_id: Uuid) -> Result<Option<CommandResponse>> {
        Ok(self.load(command_id).await?.and_then(|row| row.response))
    }

    async fn execute_new(&self, command: &Command) -> Result<CommandResponse> {
        match command.r#type {
            CommandType::CreateWorld => {
                if command.world_id.is_some() {
                    bail!("CREATE_WORLD must not include world_id");
                }
                let name = required_string(&command.payload, "name")?;
                let world = self
                    .worlds
                    .create_for_command(name, command.command_id)
                    .await?;
                completed(command.command_id, serde_json::to_value(world)?)
            }
            CommandType::OpenWorld => {
                let world_id = command.world_id.context("OPEN_WORLD requires world_id")?;
                let world = self
                    .worlds
                    .get(world_id)
                    .await?
                    .context("world does not exist")?;
                completed(command.command_id, serde_json::to_value(world)?)
            }
            CommandType::PauseJob => {
                let job_id = required_uuid(&command.payload, "job_id")?;
                let job = self.jobs.transition(job_id, JobState::Pausing).await?;
                completed(command.command_id, serde_json::to_value(job)?)
            }
            CommandType::ResumeJob => {
                let job_id = required_uuid(&command.payload, "job_id")?;
                let job = self.jobs.transition(job_id, JobState::Ready).await?;
                completed(command.command_id, serde_json::to_value(job)?)
            }
            CommandType::CancelJob => {
                let job_id = required_uuid(&command.payload, "job_id")?;
                let job = self.jobs.request_cancel(job_id).await?;
                completed(command.command_id, serde_json::to_value(job)?)
            }
            CommandType::AcceptCandidate => {
                let candidate_id = required_uuid(&command.payload, "candidate_id")?;
                let candidate = self
                    .candidates
                    .get(candidate_id)
                    .await?
                    .context("candidate does not exist")?;
                if let Some(world_id) = command.world_id {
                    if candidate.world_id != world_id {
                        bail!("candidate does not belong to command world");
                    }
                }
                let expected_parent_revision_id =
                    optional_uuid(&command.payload, "expected_parent_revision_id")?;
                let actor_type = actor_type(&command.caller_context)?;
                let revision = self
                    .candidates
                    .accept(
                        candidate_id,
                        expected_parent_revision_id,
                        Some(command.command_id),
                        actor_type,
                    )
                    .await?;
                completed(command.command_id, serde_json::to_value(revision)?)
            }
            CommandType::RejectCandidate => {
                let candidate_id = required_uuid(&command.payload, "candidate_id")?;
                let candidate = self
                    .candidates
                    .get(candidate_id)
                    .await?
                    .context("candidate does not exist")?;
                if let Some(world_id) = command.world_id {
                    if candidate.world_id != world_id {
                        bail!("candidate does not belong to command world");
                    }
                }
                self.candidates.reject(candidate_id).await?;
                completed(command.command_id, json!({"candidate_id": candidate_id}))
            }
            CommandType::UpdateEntityTransform => {
                let world_id = command
                    .world_id
                    .context("UPDATE_ENTITY_TRANSFORM requires world_id")?;
                let entity_id = required_uuid(&command.payload, "entity_id")?;
                let transform = required_object(&command.payload, "transform")?.clone();
                let expected_parent_revision_id =
                    optional_uuid(&command.payload, "expected_parent_revision_id")?;
                let result = self
                    .entities
                    .update_transform(
                        world_id,
                        entity_id,
                        transform,
                        expected_parent_revision_id,
                        command.command_id,
                        actor_type(&command.caller_context)?,
                    )
                    .await?;
                completed(command.command_id, serde_json::to_value(result)?)
            }
            CommandType::DeleteEntity => {
                let world_id = command
                    .world_id
                    .context("DELETE_ENTITY requires world_id")?;
                let entity_id = required_uuid(&command.payload, "entity_id")?;
                let expected_parent_revision_id =
                    optional_uuid(&command.payload, "expected_parent_revision_id")?;
                let result = self
                    .entities
                    .delete(
                        world_id,
                        entity_id,
                        expected_parent_revision_id,
                        command.command_id,
                        actor_type(&command.caller_context)?,
                    )
                    .await?;
                completed(command.command_id, serde_json::to_value(result)?)
            }
            CommandType::DuplicateEntity => {
                let world_id = command
                    .world_id
                    .context("DUPLICATE_ENTITY requires world_id")?;
                let entity_id = required_uuid(&command.payload, "entity_id")?;
                let transform = optional_object(&command.payload, "transform")?.cloned();
                let expected_parent_revision_id =
                    optional_uuid(&command.payload, "expected_parent_revision_id")?;
                let result = self
                    .entities
                    .duplicate(
                        world_id,
                        entity_id,
                        transform,
                        expected_parent_revision_id,
                        command.command_id,
                        actor_type(&command.caller_context)?,
                    )
                    .await?;
                completed(command.command_id, serde_json::to_value(result)?)
            }
            _ => Ok(CommandResponse {
                command_id: command.command_id,
                status: CommandResponseStatus::Rejected,
                job_ids: Vec::new(),
                result: None,
                error: Some(json!({
                    "code": "COMMAND_NOT_IMPLEMENTED",
                    "command_type": enum_to_string(&command.r#type)?,
                })),
            }),
        }
    }

    async fn claim(&self, command: &Command, owner: Uuid) -> Result<ClaimOutcome> {
        let now = Utc::now();
        let lease_expires_at = now + Duration::seconds(COMMAND_LEASE_SECONDS);
        if self
            .insert_command(command, owner, lease_expires_at)
            .await?
        {
            return Ok(ClaimOutcome::Claimed);
        }

        let existing = self
            .load(command.command_id)
            .await?
            .context("command conflict row disappeared")?;
        ensure_same_command(&existing, command)?;
        if let Some(response) = existing.response {
            return Ok(ClaimOutcome::Finished(response));
        }
        if existing
            .lease_expires_at
            .is_some_and(|expires| expires > now)
        {
            return Ok(ClaimOutcome::Busy);
        }

        let result = sqlx::query(
            r#"
            UPDATE commands
            SET execution_owner = ?, lease_expires_at = ?,
                execution_attempt = execution_attempt + 1
            WHERE command_id = ?
              AND response_json IS NULL
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            "#,
        )
        .bind(owner.to_string())
        .bind(lease_expires_at.to_rfc3339())
        .bind(command.command_id.to_string())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 1 {
            return Ok(ClaimOutcome::Claimed);
        }

        let latest = self
            .load(command.command_id)
            .await?
            .context("command disappeared during lease claim")?;
        ensure_same_command(&latest, command)?;
        Ok(latest
            .response
            .map(ClaimOutcome::Finished)
            .unwrap_or(ClaimOutcome::Busy))
    }

    async fn insert_command(
        &self,
        command: &Command,
        owner: Uuid,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<bool> {
        let result = sqlx::query(
            r#"
            INSERT INTO commands(
                command_id, type, world_id, payload_json, schema_version,
                caller_context_json, requested_at, status, response_json,
                execution_owner, lease_expires_at, execution_attempt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
            ON CONFLICT(command_id) DO NOTHING
            "#,
        )
        .bind(command.command_id.to_string())
        .bind(enum_to_string(&command.r#type)?)
        .bind(command.world_id.map(|value| value.to_string()))
        .bind(to_json(&command.payload)?)
        .bind(i64::try_from(command.schema_version).context("command schema_version too large")?)
        .bind(to_json(&command.caller_context)?)
        .bind(command.requested_at.to_rfc3339())
        .bind(enum_to_string(&CommandResponseStatus::Accepted)?)
        .bind(owner.to_string())
        .bind(lease_expires_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() == 1)
    }

    async fn persist_response(&self, response: &CommandResponse, owner: Uuid) -> Result<()> {
        let result = sqlx::query(
            r#"
            UPDATE commands
            SET status = ?, response_json = ?,
                execution_owner = NULL, lease_expires_at = NULL
            WHERE command_id = ? AND execution_owner = ?
            "#,
        )
        .bind(enum_to_string(&response.status)?)
        .bind(to_json(response)?)
        .bind(response.command_id.to_string())
        .bind(owner.to_string())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!("command execution lease was lost before response persistence");
        }
        Ok(())
    }

    async fn load(&self, command_id: Uuid) -> Result<Option<StoredCommand>> {
        let row = sqlx::query_as::<_, StoredCommandRow>(
            r#"
            SELECT command_id, type, world_id, payload_json, schema_version,
                   caller_context_json, response_json, lease_expires_at
            FROM commands
            WHERE command_id = ?
            "#,
        )
        .bind(command_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }
}

fn accepted(command_id: Uuid) -> CommandResponse {
    CommandResponse {
        command_id,
        status: CommandResponseStatus::Accepted,
        job_ids: Vec::new(),
        result: None,
        error: None,
    }
}

fn completed(command_id: Uuid, result: Value) -> Result<CommandResponse> {
    Ok(CommandResponse {
        command_id,
        status: CommandResponseStatus::Completed,
        job_ids: Vec::new(),
        result: Some(result),
        error: None,
    })
}

fn required_string<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("payload.{key} must be a non-empty string"))
}

fn required_object<'a>(payload: &'a Value, key: &str) -> Result<&'a Value> {
    payload
        .get(key)
        .filter(|value| value.is_object())
        .with_context(|| format!("payload.{key} must be an object"))
}

fn optional_object<'a>(payload: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    let Some(value) = payload.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !value.is_object() {
        bail!("payload.{key} must be an object or null");
    }
    Ok(Some(value))
}

fn required_uuid(payload: &Value, key: &str) -> Result<Uuid> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("payload.{key} must be a UUID string"))?;
    Uuid::parse_str(value).with_context(|| format!("payload.{key} is not a valid UUID"))
}

fn optional_uuid(payload: &Value, key: &str) -> Result<Option<Uuid>> {
    let Some(value) = payload.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .with_context(|| format!("payload.{key} must be a UUID string or null"))?;
    Ok(Some(Uuid::parse_str(value).with_context(|| {
        format!("payload.{key} is not a valid UUID")
    })?))
}

fn actor_type(caller_context: &Value) -> Result<WorldRevisionActorType> {
    let value = caller_context
        .get("actor_type")
        .and_then(Value::as_str)
        .unwrap_or("USER");
    enum_from_string(value)
}

fn ensure_same_command(stored: &StoredCommand, incoming: &Command) -> Result<()> {
    if stored.command_type != incoming.r#type
        || stored.world_id != incoming.world_id
        || stored.payload != incoming.payload
        || stored.schema_version != incoming.schema_version
        || stored.caller_context != incoming.caller_context
    {
        bail!("command_id was reused with different command content");
    }
    Ok(())
}

enum ClaimOutcome {
    Claimed,
    Busy,
    Finished(CommandResponse),
}

struct StoredCommand {
    command_type: CommandType,
    world_id: Option<Uuid>,
    payload: Value,
    schema_version: u64,
    caller_context: Value,
    response: Option<CommandResponse>,
    lease_expires_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct StoredCommandRow {
    command_id: String,
    r#type: String,
    world_id: Option<String>,
    payload_json: String,
    schema_version: i64,
    caller_context_json: String,
    response_json: Option<String>,
    lease_expires_at: Option<String>,
}

impl TryFrom<StoredCommandRow> for StoredCommand {
    type Error = anyhow::Error;

    fn try_from(row: StoredCommandRow) -> Result<Self> {
        let _ = Uuid::parse_str(&row.command_id)?;
        Ok(Self {
            command_type: enum_from_string(&row.r#type)?,
            world_id: row.world_id.as_deref().map(Uuid::parse_str).transpose()?,
            payload: from_json(&row.payload_json)?,
            schema_version: u64::try_from(row.schema_version)
                .context("negative command schema_version")?,
            caller_context: from_json(&row.caller_context_json)?,
            response: row.response_json.as_deref().map(from_json).transpose()?,
            lease_expires_at: row
                .lease_expires_at
                .as_deref()
                .map(DateTime::parse_from_rfc3339)
                .transpose()?
                .map(|value| value.with_timezone(&Utc)),
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::json;
    use uuid::Uuid;

    use crate::{
        db,
        entity_service::EntityService,
        model::{Command, CommandResponseStatus, CommandType, EntityLifecycle},
        serde_db::enum_to_string,
        world_repository::WorldRepository,
    };

    use super::CommandService;

    fn create_world_command(id: Uuid, name: &str) -> Command {
        Command {
            command_id: id,
            r#type: CommandType::CreateWorld,
            world_id: None,
            payload: json!({"name": name}),
            schema_version: 1,
            caller_context: json!({"actor_type": "USER"}),
            requested_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn replaying_same_command_id_does_not_repeat_side_effect() {
        let pool = db::connect_memory().await.unwrap();
        let service = CommandService::new(pool.clone());
        let command = create_world_command(Uuid::new_v4(), "My World");

        let first = service.execute(&command).await.unwrap();
        let second = service.execute(&command).await.unwrap();

        assert_eq!(first.status, CommandResponseStatus::Completed);
        assert_eq!(first, second);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM worlds")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn expired_command_lease_recovers_without_repeating_world_creation() {
        let pool = db::connect_memory().await.unwrap();
        let service = CommandService::new(pool.clone());
        let command = create_world_command(Uuid::new_v4(), "Crash Recovery");

        let first = service.execute(&command).await.unwrap();
        let first_world_id = first.result.as_ref().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();

        sqlx::query(
            r#"
            UPDATE commands
            SET response_json = NULL,
                status = 'ACCEPTED',
                execution_owner = 'dead-owner',
                lease_expires_at = ?
            WHERE command_id = ?
            "#,
        )
        .bind((Utc::now() - Duration::minutes(1)).to_rfc3339())
        .bind(command.command_id.to_string())
        .execute(&pool)
        .await
        .unwrap();

        let replay = service.execute(&command).await.unwrap();
        assert_eq!(replay.status, CommandResponseStatus::Completed);
        assert_eq!(
            replay.result.as_ref().unwrap()["id"].as_str().unwrap(),
            first_world_id
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM worlds")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn entity_transform_command_commits_entity_and_revision_together() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let entities = EntityService::new(pool.clone());
        let service = CommandService::new(pool.clone());
        let world = worlds.create("Editor World").await.unwrap();
        let entity_id = Uuid::new_v4();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r#"
            INSERT INTO entities(
                id, world_id, semantic_class, display_name, zone_id,
                transform_json, scale_json, physical_properties_json,
                lifecycle, created_at, updated_at
            ) VALUES (?, ?, 'chair', 'Chair', NULL, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(entity_id.to_string())
        .bind(world.id.to_string())
        .bind(json!({"x": 0}).to_string())
        .bind(json!({"x": 1, "y": 1, "z": 1}).to_string())
        .bind(json!({}).to_string())
        .bind(enum_to_string(&EntityLifecycle::Active).unwrap())
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let command = Command {
            command_id: Uuid::new_v4(),
            r#type: CommandType::UpdateEntityTransform,
            world_id: Some(world.id),
            payload: json!({
                "entity_id": entity_id,
                "transform": {"x": 3},
                "expected_parent_revision_id": null
            }),
            schema_version: 1,
            caller_context: json!({"actor_type": "USER"}),
            requested_at: Utc::now(),
        };

        let first = service.execute(&command).await.unwrap();
        let second = service.execute(&command).await.unwrap();
        assert_eq!(first.status, CommandResponseStatus::Completed);
        assert_eq!(first, second);

        let entity = entities.get(entity_id).await.unwrap().unwrap();
        assert_eq!(entity.transform, json!({"x": 3}));
        let refreshed = worlds.get(world.id).await.unwrap().unwrap();
        assert!(refreshed.active_revision_id.is_some());

        let revision_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM world_revisions WHERE command_id = ?")
                .bind(command.command_id.to_string())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(revision_count, 1);
    }

    #[tokio::test]
    async fn same_command_id_with_different_payload_is_rejected() {
        let pool = db::connect_memory().await.unwrap();
        let service = CommandService::new(pool);
        let id = Uuid::new_v4();

        service
            .execute(&create_world_command(id, "World A"))
            .await
            .unwrap();

        let error = service
            .execute(&create_world_command(id, "World B"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("reused"));
    }

    #[tokio::test]
    async fn unsupported_command_is_explicitly_rejected_and_replayable() {
        let pool = db::connect_memory().await.unwrap();
        let service = CommandService::new(pool);
        let command = Command {
            command_id: Uuid::new_v4(),
            r#type: CommandType::ImportObservations,
            world_id: None,
            payload: json!({}),
            schema_version: 1,
            caller_context: json!({"actor_type": "USER"}),
            requested_at: Utc::now(),
        };

        let first = service.execute(&command).await.unwrap();
        let second = service.execute(&command).await.unwrap();
        assert_eq!(first.status, CommandResponseStatus::Rejected);
        assert_eq!(first, second);
    }
}
