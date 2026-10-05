use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    model::{World, WorldCoordinateSystem, WorldRevision, WorldRevisionActorType, WorldUnit},
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
};

const WORLD_SCHEMA_VERSION: i64 = 1;

#[derive(Clone)]
pub struct WorldRepository {
    pool: SqlitePool,
}

impl WorldRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create(&self, name: &str) -> Result<World> {
        let name = name.trim();
        if name.is_empty() {
            bail!("world name must not be empty");
        }

        let now = Utc::now();
        let world = World {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            schema_version: WORLD_SCHEMA_VERSION,
            active_revision_id: None,
            coordinate_system: WorldCoordinateSystem::RightHandedYUp,
            unit: WorldUnit::Meter,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            r#"
            INSERT INTO worlds(
                id, name, schema_version, active_revision_id,
                coordinate_system, unit, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
            "#,
        )
        .bind(world.id.to_string())
        .bind(&world.name)
        .bind(world.schema_version)
        .bind(enum_to_string(&world.coordinate_system)?)
        .bind(enum_to_string(&world.unit)?)
        .bind(world.created_at.to_rfc3339())
        .bind(world.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(world)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<World>> {
        let row = sqlx::query_as::<_, WorldRow>(
            r#"
            SELECT id, name, schema_version, active_revision_id,
                   coordinate_system, unit, created_at, updated_at
            FROM worlds
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn get_revision(&self, id: Uuid) -> Result<Option<WorldRevision>> {
        let row = sqlx::query_as::<_, RevisionRow>(
            r#"
            SELECT id, world_id, parent_revision_id, command_id,
                   actor_type, changeset_json, created_at
            FROM world_revisions
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn commit_revision(
        &self,
        world_id: Uuid,
        expected_parent_revision_id: Option<Uuid>,
        command_id: Option<Uuid>,
        actor_type: WorldRevisionActorType,
        changeset: Value,
    ) -> Result<WorldRevision> {
        let mut tx = self.pool.begin().await?;
        let revision = commit_revision_in_tx(
            &mut tx,
            world_id,
            expected_parent_revision_id,
            command_id,
            actor_type,
            changeset,
        )
        .await?;
        tx.commit().await?;
        Ok(revision)
    }
}

pub(crate) async fn commit_revision_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    world_id: Uuid,
    expected_parent_revision_id: Option<Uuid>,
    command_id: Option<Uuid>,
    actor_type: WorldRevisionActorType,
    changeset: Value,
) -> Result<WorldRevision> {
    let head =
        sqlx::query_as::<_, WorldHeadRow>("SELECT active_revision_id FROM worlds WHERE id = ?")
            .bind(world_id.to_string())
            .fetch_optional(&mut **tx)
            .await?
            .context("world does not exist")?;

    let active_revision_id = head
        .active_revision_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .context("invalid active revision id")?;

    if active_revision_id != expected_parent_revision_id {
        bail!(
            "stale world revision: expected {:?}, current {:?}",
            expected_parent_revision_id,
            active_revision_id
        );
    }

    let revision = WorldRevision {
        id: Uuid::new_v4(),
        world_id,
        parent_revision_id: active_revision_id,
        command_id,
        actor_type,
        changeset,
        created_at: Utc::now(),
    };

    sqlx::query(
        r#"
        INSERT INTO world_revisions(
            id, world_id, parent_revision_id, command_id,
            actor_type, changeset_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(revision.id.to_string())
    .bind(revision.world_id.to_string())
    .bind(revision.parent_revision_id.map(|value| value.to_string()))
    .bind(revision.command_id.map(|value| value.to_string()))
    .bind(enum_to_string(&revision.actor_type)?)
    .bind(to_json(&revision.changeset)?)
    .bind(revision.created_at.to_rfc3339())
    .execute(&mut **tx)
    .await?;

    let updated_at = Utc::now();
    let result = sqlx::query(
        r#"
        UPDATE worlds
        SET active_revision_id = ?, updated_at = ?
        WHERE id = ? AND (
            (active_revision_id IS NULL AND ? IS NULL)
            OR active_revision_id = ?
        )
        "#,
    )
    .bind(revision.id.to_string())
    .bind(updated_at.to_rfc3339())
    .bind(world_id.to_string())
    .bind(active_revision_id.map(|value| value.to_string()))
    .bind(active_revision_id.map(|value| value.to_string()))
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() != 1 {
        bail!("world revision changed concurrently");
    }

    Ok(revision)
}

#[derive(sqlx::FromRow)]
struct WorldHeadRow {
    active_revision_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct WorldRow {
    id: String,
    name: String,
    schema_version: i64,
    active_revision_id: Option<String>,
    coordinate_system: String,
    unit: String,
    created_at: String,
    updated_at: String,
}

impl TryFrom<WorldRow> for World {
    type Error = anyhow::Error;

    fn try_from(row: WorldRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            name: row.name,
            schema_version: row.schema_version,
            active_revision_id: row
                .active_revision_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            coordinate_system: enum_from_string(&row.coordinate_system)?,
            unit: enum_from_string(&row.unit)?,
            created_at: parse_datetime(&row.created_at, "world created_at")?,
            updated_at: parse_datetime(&row.updated_at, "world updated_at")?,
        })
    }
}

#[derive(sqlx::FromRow)]
struct RevisionRow {
    id: String,
    world_id: String,
    parent_revision_id: Option<String>,
    command_id: Option<String>,
    actor_type: String,
    changeset_json: String,
    created_at: String,
}

impl TryFrom<RevisionRow> for WorldRevision {
    type Error = anyhow::Error;

    fn try_from(row: RevisionRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            parent_revision_id: row
                .parent_revision_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()?,
            command_id: row.command_id.as_deref().map(Uuid::parse_str).transpose()?,
            actor_type: enum_from_string(&row.actor_type)?,
            changeset: from_json(&row.changeset_json)?,
            created_at: parse_datetime(&row.created_at, "revision created_at")?,
        })
    }
}

fn parse_datetime(value: &str, field: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("invalid {field}"))?
        .with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{db, model::WorldRevisionActorType};

    use super::WorldRepository;

    #[tokio::test]
    async fn world_revision_is_persistent_and_compare_and_swap_guarded() {
        let pool = db::connect_memory().await.unwrap();
        let repo = WorldRepository::new(pool);
        let world = repo.create("Demo World").await.unwrap();

        let first = repo
            .commit_revision(
                world.id,
                None,
                None,
                WorldRevisionActorType::System,
                json!({"op": "bootstrap"}),
            )
            .await
            .unwrap();

        let loaded = repo.get(world.id).await.unwrap().unwrap();
        assert_eq!(loaded.active_revision_id, Some(first.id));

        let stale = repo
            .commit_revision(
                world.id,
                None,
                None,
                WorldRevisionActorType::System,
                json!({"op": "stale"}),
            )
            .await;
        assert!(stale.is_err());

        let second = repo
            .commit_revision(
                world.id,
                Some(first.id),
                None,
                WorldRevisionActorType::User,
                json!({"op": "confirmed"}),
            )
            .await
            .unwrap();
        assert_eq!(second.parent_revision_id, Some(first.id));
    }
}
