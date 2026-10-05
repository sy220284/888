use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    model::{Anchor, GeometryRepresentation, Portal, Zone},
    serde_db::{enum_from_string, from_json},
};

#[derive(Clone)]
pub struct WorldQueryService {
    pool: SqlitePool,
}

impl WorldQueryService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list_geometry(&self, world_id: Uuid) -> Result<Vec<GeometryRepresentation>> {
        let rows = sqlx::query_as::<_, GeometryRow>(
            r#"
            SELECT id, world_id, entity_id, zone_id, representation_type,
                   artifact_id, quality_profile, source_kind, valid_region_json,
                   lod_level, verification_state, created_at
            FROM geometry_representations
            WHERE world_id = ?
            ORDER BY created_at, id
            "#,
        )
        .bind(world_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn list_zones(&self, world_id: Uuid) -> Result<Vec<Zone>> {
        let rows = sqlx::query_as::<_, ZoneRow>(
            r#"
            SELECT id, world_id, zone_type, display_name, local_transform_json,
                   confidence, created_at, updated_at
            FROM zones
            WHERE world_id = ?
            ORDER BY created_at, id
            "#,
        )
        .bind(world_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn list_anchors(&self, world_id: Uuid) -> Result<Vec<Anchor>> {
        let rows = sqlx::query_as::<_, AnchorRow>(
            r#"
            SELECT id, world_id, anchor_type, zone_id, local_pose_json,
                   confidence, created_at, updated_at
            FROM anchors
            WHERE world_id = ?
            ORDER BY created_at, id
            "#,
        )
        .bind(world_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn list_portals(&self, world_id: Uuid) -> Result<Vec<Portal>> {
        let rows = sqlx::query_as::<_, PortalRow>(
            r#"
            SELECT id, world_id, from_zone_id, to_zone_id, anchor_id,
                   transform_json, passable, confidence, created_at, updated_at
            FROM portals
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

#[derive(sqlx::FromRow)]
struct GeometryRow {
    id: String,
    world_id: String,
    entity_id: Option<String>,
    zone_id: Option<String>,
    representation_type: String,
    artifact_id: String,
    quality_profile: Option<String>,
    source_kind: String,
    valid_region_json: Option<String>,
    lod_level: Option<i64>,
    verification_state: String,
    created_at: String,
}

impl TryFrom<GeometryRow> for GeometryRepresentation {
    type Error = anyhow::Error;

    fn try_from(row: GeometryRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            entity_id: row.entity_id.as_deref().map(Uuid::parse_str).transpose()?,
            zone_id: row.zone_id.as_deref().map(Uuid::parse_str).transpose()?,
            representation_type: enum_from_string(&row.representation_type)?,
            artifact_id: Uuid::parse_str(&row.artifact_id)?,
            quality_profile: row.quality_profile,
            source_kind: enum_from_string(&row.source_kind)?,
            valid_region: row
                .valid_region_json
                .as_deref()
                .map(from_json)
                .transpose()?,
            lod_level: row
                .lod_level
                .map(u64::try_from)
                .transpose()
                .context("negative geometry lod_level")?,
            verification_state: enum_from_string(&row.verification_state)?,
            created_at: parse_datetime(&row.created_at, "geometry created_at")?,
        })
    }
}

#[derive(sqlx::FromRow)]
struct ZoneRow {
    id: String,
    world_id: String,
    zone_type: String,
    display_name: Option<String>,
    local_transform_json: String,
    confidence: Option<f64>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<ZoneRow> for Zone {
    type Error = anyhow::Error;

    fn try_from(row: ZoneRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            zone_type: enum_from_string(&row.zone_type)?,
            display_name: row.display_name,
            local_transform: from_json(&row.local_transform_json)?,
            confidence: row.confidence,
            created_at: parse_datetime(&row.created_at, "zone created_at")?,
            updated_at: parse_datetime(&row.updated_at, "zone updated_at")?,
        })
    }
}

#[derive(sqlx::FromRow)]
struct AnchorRow {
    id: String,
    world_id: String,
    anchor_type: String,
    zone_id: Option<String>,
    local_pose_json: String,
    confidence: Option<f64>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<AnchorRow> for Anchor {
    type Error = anyhow::Error;

    fn try_from(row: AnchorRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            anchor_type: enum_from_string(&row.anchor_type)?,
            zone_id: row.zone_id.as_deref().map(Uuid::parse_str).transpose()?,
            local_pose: from_json(&row.local_pose_json)?,
            confidence: row.confidence,
            created_at: parse_datetime(&row.created_at, "anchor created_at")?,
            updated_at: parse_datetime(&row.updated_at, "anchor updated_at")?,
        })
    }
}

#[derive(sqlx::FromRow)]
struct PortalRow {
    id: String,
    world_id: String,
    from_zone_id: String,
    to_zone_id: Option<String>,
    anchor_id: Option<String>,
    transform_json: String,
    passable: bool,
    confidence: f64,
    created_at: String,
    updated_at: String,
}

impl TryFrom<PortalRow> for Portal {
    type Error = anyhow::Error;

    fn try_from(row: PortalRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            world_id: Uuid::parse_str(&row.world_id)?,
            from_zone_id: Uuid::parse_str(&row.from_zone_id)?,
            to_zone_id: row.to_zone_id.as_deref().map(Uuid::parse_str).transpose()?,
            anchor_id: row.anchor_id.as_deref().map(Uuid::parse_str).transpose()?,
            transform: from_json(&row.transform_json)?,
            passable: row.passable,
            confidence: row.confidence,
            created_at: parse_datetime(&row.created_at, "portal created_at")?,
            updated_at: parse_datetime(&row.updated_at, "portal updated_at")?,
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
    use uuid::Uuid;

    use crate::{
        db,
        model::{
            GeometryRepresentationRepresentationType, GeometryRepresentationSourceKind,
            GeometryRepresentationVerificationState,
        },
        serde_db::enum_to_string,
        world_repository::WorldRepository,
    };

    use super::WorldQueryService;

    #[tokio::test]
    async fn returns_canonical_geometry_for_world() {
        let pool = db::connect_memory().await.unwrap();
        let worlds = WorldRepository::new(pool.clone());
        let query = WorldQueryService::new(pool.clone());
        let world = worlds.create("Query World").await.unwrap();

        let artifact_id = Uuid::new_v4();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO artifacts(
                id, content_hash, mime, size_bytes, relative_path, source_url, created_at
            ) VALUES (?, ?, 'model/gltf-binary', 1, ?, NULL, ?)
            "#,
        )
        .bind(artifact_id.to_string())
        .bind("a".repeat(64))
        .bind(format!("aa/{artifact_id}"))
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let zone_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO zones(
                id, world_id, zone_type, display_name, local_transform_json,
                confidence, created_at, updated_at
            ) VALUES (?, ?, 'ROOM', 'Query Zone', '{}', 1.0, ?, ?)
            "#,
        )
        .bind(zone_id.to_string())
        .bind(world.id.to_string())
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let geometry_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO geometry_representations(
                id, world_id, entity_id, zone_id, representation_type,
                artifact_id, quality_profile, source_kind, valid_region_json,
                lod_level, verification_state, created_at
            ) VALUES (?, ?, NULL, ?, ?, ?, 'BALANCED', ?, ?, 0, ?, ?)
            "#,
        )
        .bind(geometry_id.to_string())
        .bind(world.id.to_string())
        .bind(zone_id.to_string())
        .bind(enum_to_string(&GeometryRepresentationRepresentationType::Mesh).unwrap())
        .bind(artifact_id.to_string())
        .bind(enum_to_string(&GeometryRepresentationSourceKind::Verified).unwrap())
        .bind(json!({"kind": "all"}).to_string())
        .bind(enum_to_string(&GeometryRepresentationVerificationState::Verified).unwrap())
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let geometry = query.list_geometry(world.id).await.unwrap();
        assert_eq!(geometry.len(), 1);
        assert_eq!(geometry[0].id, geometry_id);
        assert_eq!(geometry[0].artifact_id, artifact_id);
    }
}
