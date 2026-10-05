use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    model::{Entity, EntityLifecycle, WorldRevision, WorldRevisionActorType},
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
    world_repository::{commit_revision_in_tx, WorldRepository},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntityMutationResult {
    pub entity_id: Uuid,
    pub revision: WorldRevision,
}

#[derive(Clone)]
pub struct EntityService {
    pool: SqlitePool,
}

impl EntityService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Entity>> {
        let row = sqlx::query_as::<_, EntityRow>(
            r#"
            SELECT id, world_id, semantic_class, display_name, zone_id,
                   transform_json, scale_json, physical_properties_json,
                   lifecycle, created_at, updated_at
            FROM entities
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    pub async fn list(&self, world_id: Uuid) -> Result<Vec<Entity>> {
        let rows = sqlx::query_as::<_, EntityRow>(
            r#"
            SELECT id, world_id, semantic_class, display_name, zone_id,
                   transform_json, scale_json, physical_properties_json,
                   lifecycle, created_at, updated_at
            FROM entities
            WHERE world_id = ?
            ORDER BY created_at, id
            "#,
        )
        .bind(world_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn update_transform(
        &self,
        world_id: Uuid,
        entity_id: Uuid,
        transform: Value,
        expected_parent_revision_id: Option<Uuid>,
        command_id: Uuid,
        actor_type: WorldRevisionActorType,
    ) -> Result<EntityMutationResult> {
        require_object(&transform, "transform")?;
        if let Some(replayed) = self
            .replay(command_id, "UPDATE_ENTITY_TRANSFORM", Some(entity_id))
            .await?
        {
            return Ok(replayed);
        }

        let mut tx = self.pool.begin().await?;
        let entity = load_entity_in_tx(&mut tx, entity_id).await?;
        ensure_entity_world(&entity, world_id)?;
        if entity.lifecycle == EntityLifecycle::Deleted {
            bail!("deleted entity cannot be transformed");
        }

        let now = Utc::now();
        let update = sqlx::query(
            r#"
            UPDATE entities
            SET transform_json = ?, updated_at = ?
            WHERE id = ? AND world_id = ? AND lifecycle != ?
            "#,
        )
        .bind(to_json(&transform)?)
        .bind(now.to_rfc3339())
        .bind(entity_id.to_string())
        .bind(world_id.to_string())
        .bind(enum_to_string(&EntityLifecycle::Deleted)?)
        .execute(&mut *tx)
        .await?;
        if update.rows_affected() != 1 {
            bail!("entity changed concurrently");
        }

        let revision = commit_revision_in_tx(
            &mut tx,
            world_id,
            expected_parent_revision_id,
            Some(command_id),
            actor_type,
            json!({
                "operation": "UPDATE_ENTITY_TRANSFORM",
                "entity_id": entity_id,
                "before_transform": entity.transform,
                "after_transform": transform,
            }),
        )
        .await?;
        tx.commit().await?;

        Ok(EntityMutationResult {
            entity_id,
            revision,
        })
    }

    pub async fn delete(
        &self,
        world_id: Uuid,
        entity_id: Uuid,
        expected_parent_revision_id: Option<Uuid>,
        command_id: Uuid,
        actor_type: WorldRevisionActorType,
    ) -> Result<EntityMutationResult> {
        if let Some(replayed) = self
            .replay(command_id, "DELETE_ENTITY", Some(entity_id))
            .await?
        {
            return Ok(replayed);
        }

        let mut tx = self.pool.begin().await?;
        let entity = load_entity_in_tx(&mut tx, entity_id).await?;
        ensure_entity_world(&entity, world_id)?;
        if entity.lifecycle == EntityLifecycle::Deleted {
            bail!("entity is already deleted by another command");
        }

        let update = sqlx::query(
            r#"
            UPDATE entities
            SET lifecycle = ?, updated_at = ?
            WHERE id = ? AND world_id = ? AND lifecycle != ?
            "#,
        )
        .bind(enum_to_string(&EntityLifecycle::Deleted)?)
        .bind(Utc::now().to_rfc3339())
        .bind(entity_id.to_string())
        .bind(world_id.to_string())
        .bind(enum_to_string(&EntityLifecycle::Deleted)?)
        .execute(&mut *tx)
        .await?;
        if update.rows_affected() != 1 {
            bail!("entity changed concurrently");
        }

        let revision = commit_revision_in_tx(
            &mut tx,
            world_id,
            expected_parent_revision_id,
            Some(command_id),
            actor_type,
            json!({
                "operation": "DELETE_ENTITY",
                "entity_id": entity_id,
                "previous_lifecycle": enum_to_string(&entity.lifecycle)?,
                "lifecycle": "DELETED",
            }),
        )
        .await?;
        tx.commit().await?;

        Ok(EntityMutationResult {
            entity_id,
            revision,
        })
    }

    pub async fn duplicate(
        &self,
        world_id: Uuid,
        source_entity_id: Uuid,
        transform_override: Option<Value>,
        expected_parent_revision_id: Option<Uuid>,
        command_id: Uuid,
        actor_type: WorldRevisionActorType,
    ) -> Result<EntityMutationResult> {
        if let Some(replayed) = self
            .replay(command_id, "DUPLICATE_ENTITY", Some(source_entity_id))
            .await?
        {
            return Ok(replayed);
        }
        if let Some(transform) = transform_override.as_ref() {
            require_object(transform, "transform")?;
        }

        let mut tx = self.pool.begin().await?;
        let source = load_entity_in_tx(&mut tx, source_entity_id).await?;
        ensure_entity_world(&source, world_id)?;
        if source.lifecycle == EntityLifecycle::Deleted {
            bail!("deleted entity cannot be duplicated");
        }

        let duplicate_id = Uuid::new_v4();
        let transform = transform_override.unwrap_or_else(|| source.transform.clone());
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO entities(
                id, world_id, semantic_class, display_name, zone_id,
                transform_json, scale_json, physical_properties_json,
                lifecycle, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(duplicate_id.to_string())
        .bind(world_id.to_string())
        .bind(&source.semantic_class)
        .bind(source.display_name.as_deref())
        .bind(source.zone_id.map(|value| value.to_string()))
        .bind(to_json(&transform)?)
        .bind(to_json(&source.scale)?)
        .bind(to_json(&source.physical_properties)?)
        .bind(enum_to_string(&EntityLifecycle::Active)?)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&mut *tx)
        .await?;

        clone_geometry_representations(&mut tx, source_entity_id, duplicate_id, world_id).await?;

        let revision = commit_revision_in_tx(
            &mut tx,
            world_id,
            expected_parent_revision_id,
            Some(command_id),
            actor_type,
            json!({
                "operation": "DUPLICATE_ENTITY",
                "source_entity_id": source_entity_id,
                "entity_id": duplicate_id,
                "transform": transform,
            }),
        )
        .await?;
        tx.commit().await?;

        Ok(EntityMutationResult {
            entity_id: duplicate_id,
            revision,
        })
    }

    async fn replay(
        &self,
        command_id: Uuid,
        expected_operation: &str,
        expected_source_entity_id: Option<Uuid>,
    ) -> Result<Option<EntityMutationResult>> {
        let worlds = WorldRepository::new(self.pool.clone());
        let Some(revision) = worlds.get_revision_by_command(command_id).await? else {
            return Ok(None);
        };

        let operation = revision
            .changeset
            .get("operation")
            .and_then(Value::as_str)
            .context("replayed entity revision is missing operation")?;
        if operation != expected_operation {
            bail!("command revision operation does not match entity mutation");
        }

        let result_entity_id = revision
            .changeset
            .get("entity_id")
            .and_then(Value::as_str)
            .context("replayed entity revision is missing entity_id")
            .and_then(|value| Uuid::parse_str(value).map_err(Into::into))?;

        if let Some(expected_source) = expected_source_entity_id {
            let recorded_source = if expected_operation == "DUPLICATE_ENTITY" {
                revision
                    .changeset
                    .get("source_entity_id")
                    .and_then(Value::as_str)
                    .context("duplicate revision is missing source_entity_id")
                    .and_then(|value| Uuid::parse_str(value).map_err(Into::into))?
            } else {
                result_entity_id
            };
            if recorded_source != expected_source {
                bail!("command revision belongs to a different entity");
            }
        }

        Ok(Some(EntityMutationResult {
            entity_id: result_entity_id,
            revision,
        }))
    }
}

async fn load_entity_in_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<Entity> {
    let row = sqlx::query_as::<_, EntityRow>(
        r#"
        SELECT id, world_id, semantic_class, display_name, zone_id,
               transform_json, scale_json, physical_properties_json,
               lifecycle, created_at, updated_at
        FROM entities
        WHERE id = ?
        "#,
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await?
    .context("entity does not exist")?;
    row.try_into()
}

async fn clone_geometry_representations(
    tx: &mut Transaction<'_, Sqlite>,
    source_entity_id: Uuid,
    duplicate_entity_id: Uuid,
    world_id: Uuid,
) -> Result<()> {
    let rows = sqlx::query_as::<_, GeometryRow>(
        r#"
        SELECT representation_type, artifact_id, quality_profile,
               source_kind, valid_region_json, lod_level,
               verification_state, created_at
        FROM geometry_representations
        WHERE entity_id = ? AND world_id = ?
        "#,
    )
    .bind(source_entity_id.to_string())
    .bind(world_id.to_string())
    .fetch_all(&mut **tx)
    .await?;

    for row in rows {
        sqlx::query(
            r#"
            INSERT INTO geometry_representations(
                id, world_id, entity_id, zone_id, representation_type,
                artifact_id, quality_profile, source_kind, valid_region_json,
                lod_level, verification_state, created_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(world_id.to_string())
        .bind(duplicate_entity_id.to_string())
        .bind(row.representation_type)
        .bind(row.artifact_id)
        .bind(row.quality_profile)
        .bind(row.source_kind)
        .bind(row.valid_region_json)
        .bind(row.lod_level)
        .bind(row.verification_state)
        .bind(row.created_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

fn ensure_entity_world(entity: &Entity, world_id: Uuid) -> Result<()> {
    if entity.world_id != world_id {
        bail!("entity does not belong to command world");
    }
    Ok(())
}

fn require_object(value: &Value, field: &str) -> Result<()> {
    if !value.is_object() {
        bail!("{field} must be an object");
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct EntityRow {
    id: String,
    world_id: String,
    semantic_class: String,
    display_name: Option<String>,
    zone_id: Option<String>,
    transform_json: String,
    scale_json: String,
    physical_properties_json: String,
    lifecycle: String,
    created_at: String,
    updated_at: String,
}

impl TryFrom<EntityRow> for Entity {
    type Error = anyhow::Error;

    fn try_from(row: EntityRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            semantic_class: row.semantic_class,
            display_name: row.display_name,
            zone_id: row.zone_id.as_deref().map(Uuid::parse_str).transpose()?,
            transform: from_json(&row.transform_json)?,
            scale: from_json(&row.scale_json)?,
            physical_properties: from_json(&row.physical_properties_json)?,
            lifecycle: enum_from_string(&row.lifecycle)?,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)?.with_timezone(&Utc),
            updated_at: DateTime::parse_from_rfc3339(&row.updated_at)?.with_timezone(&Utc),
        })
    }
}

#[derive(sqlx::FromRow)]
struct GeometryRow {
    representation_type: String,
    artifact_id: String,
    quality_profile: Option<String>,
    source_kind: String,
    valid_region_json: Option<String>,
    lod_level: Option<i64>,
    verification_state: String,
    created_at: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        db,
        model::{EntityLifecycle, WorldRevisionActorType},
        serde_db::enum_to_string,
        world_repository::WorldRepository,
    };

    use super::EntityService;

    async fn seed_command(
        pool: &sqlx::SqlitePool,
        command_id: uuid::Uuid,
        world_id: uuid::Uuid,
        command_type: &str,
    ) {
        sqlx::query(
            r#"
            INSERT INTO commands(
                command_id, type, world_id, payload_json, schema_version,
                caller_context_json, requested_at, status, response_json
            ) VALUES (?, ?, ?, '{}', 1, '{"actor_type":"USER"}', ?, 'ACCEPTED', NULL)
            "#,
        )
        .bind(command_id.to_string())
        .bind(command_type)
        .bind(world_id.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_entity(pool: &sqlx::SqlitePool, world_id: uuid::Uuid) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO entities(
                id, world_id, semantic_class, display_name, zone_id,
                transform_json, scale_json, physical_properties_json,
                lifecycle, created_at, updated_at
            ) VALUES (?, ?, 'chair', 'Chair', NULL, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(id.to_string())
        .bind(world_id.to_string())
        .bind(json!({"x": 0}).to_string())
        .bind(json!({"x": 1, "y": 1, "z": 1}).to_string())
        .bind(json!({}).to_string())
        .bind(enum_to_string(&EntityLifecycle::Active).unwrap())
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn stale_transform_revision_rolls_back_entity_change() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let entities = EntityService::new(pool.clone());
        let world = worlds.create("Entity World").await.unwrap();
        let entity_id = seed_entity(&pool, world.id).await;

        let first_command_id = uuid::Uuid::new_v4();
        seed_command(&pool, first_command_id, world.id, "UPDATE_ENTITY_TRANSFORM").await;
        let first = entities
            .update_transform(
                world.id,
                entity_id,
                json!({"x": 1}),
                None,
                first_command_id,
                WorldRevisionActorType::User,
            )
            .await
            .unwrap();

        let stale_command_id = uuid::Uuid::new_v4();
        seed_command(&pool, stale_command_id, world.id, "UPDATE_ENTITY_TRANSFORM").await;
        let stale = entities
            .update_transform(
                world.id,
                entity_id,
                json!({"x": 999}),
                None,
                stale_command_id,
                WorldRevisionActorType::User,
            )
            .await;
        assert!(stale.is_err());

        let entity = entities.get(entity_id).await.unwrap().unwrap();
        assert_eq!(entity.transform, json!({"x": 1}));
        assert_eq!(first.revision.parent_revision_id, None);
    }

    #[tokio::test]
    async fn duplicate_is_idempotent_and_clones_entity() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let entities = EntityService::new(pool.clone());
        let world = worlds.create("Duplicate World").await.unwrap();
        let source_id = seed_entity(&pool, world.id).await;
        let command_id = uuid::Uuid::new_v4();
        seed_command(&pool, command_id, world.id, "DUPLICATE_ENTITY").await;

        let first = entities
            .duplicate(
                world.id,
                source_id,
                Some(json!({"x": 2})),
                None,
                command_id,
                WorldRevisionActorType::User,
            )
            .await
            .unwrap();
        let second = entities
            .duplicate(
                world.id,
                source_id,
                Some(json!({"x": 2})),
                None,
                command_id,
                WorldRevisionActorType::User,
            )
            .await
            .unwrap();

        assert_eq!(first.entity_id, second.entity_id);
        let duplicate = entities.get(first.entity_id).await.unwrap().unwrap();
        assert_eq!(duplicate.transform, json!({"x": 2}));
        assert_eq!(duplicate.lifecycle, EntityLifecycle::Active);
    }

    #[tokio::test]
    async fn delete_is_soft_and_revisioned() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let entities = EntityService::new(pool.clone());
        let world = worlds.create("Delete World").await.unwrap();
        let entity_id = seed_entity(&pool, world.id).await;

        let command_id = uuid::Uuid::new_v4();
        seed_command(&pool, command_id, world.id, "DELETE_ENTITY").await;
        entities
            .delete(
                world.id,
                entity_id,
                None,
                command_id,
                WorldRevisionActorType::User,
            )
            .await
            .unwrap();

        let entity = entities.get(entity_id).await.unwrap().unwrap();
        assert_eq!(entity.lifecycle, EntityLifecycle::Deleted);
    }
}
