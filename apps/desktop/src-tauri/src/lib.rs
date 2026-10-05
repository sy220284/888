use std::io;

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;
use world888_core::{
    artifact_store::ArtifactStore,
    command_service::CommandService,
    entity_service::EntityService,
    model::{
        Anchor, Command, CommandResponse, Entity, GeometryRepresentation, Portal, World, Zone,
    },
    world_query::WorldQueryService,
    world_repository::WorldRepository,
};

struct CoreState {
    commands: CommandService,
    worlds: WorldRepository,
    entities: EntityService,
    query: WorldQueryService,
}

#[derive(Debug, Serialize)]
struct CoreStatus {
    status: &'static str,
    worker_protocol_version: u64,
}

#[tauri::command]
fn core_status() -> CoreStatus {
    CoreStatus {
        status: "ready",
        worker_protocol_version: world888_core::worker_protocol::WORKER_PROTOCOL_VERSION,
    }
}

#[tauri::command]
async fn execute_command(
    state: State<'_, CoreState>,
    command: Command,
) -> Result<CommandResponse, String> {
    state
        .commands
        .execute(&command)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_command_response(
    state: State<'_, CoreState>,
    command_id: String,
) -> Result<Option<CommandResponse>, String> {
    let command_id = parse_uuid(&command_id, "command_id")?;
    state
        .commands
        .get_response(command_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_world(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Option<World>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .worlds
        .get(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_entities(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<Entity>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .entities
        .list(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_geometry(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<GeometryRepresentation>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .query
        .list_geometry(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_zones(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<Zone>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .query
        .list_zones(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_anchors(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<Anchor>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .query
        .list_anchors(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_portals(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<Portal>, String> {
    let world_id = parse_uuid(&world_id, "world_id")?;
    state
        .query
        .list_portals(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_entity(
    state: State<'_, CoreState>,
    entity_id: String,
) -> Result<Option<Entity>, String> {
    let entity_id = parse_uuid(&entity_id, "entity_id")?;
    state
        .entities
        .get(entity_id)
        .await
        .map_err(|error| error.to_string())
}

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| format!("{field} 不是合法 UUID"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let database_path = app_data_dir.join("world888.sqlite3");
            let artifact_root = app_data_dir.join("artifacts");
            let pool = tauri::async_runtime::block_on(world888_core::db::connect_path(
                &database_path,
            ))
            .map_err(|error| {
                io::Error::other(format!(
                    "初始化 888 Core 数据库失败（{}）：{error}",
                    database_path.display()
                ))
            })?;

            let artifacts = tauri::async_runtime::block_on(ArtifactStore::new(
                &artifact_root,
                pool.clone(),
            ))
            .map_err(|error| {
                io::Error::other(format!(
                    "初始化 888 Artifact Store 失败（{}）：{error}",
                    artifact_root.display()
                ))
            })?;

            app.manage(CoreState {
                commands: CommandService::with_artifact_store(pool.clone(), artifacts),
                worlds: WorldRepository::new(pool.clone()),
                entities: EntityService::new(pool.clone()),
                query: WorldQueryService::new(pool),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_status,
            execute_command,
            get_command_response,
            get_world,
            list_entities,
            list_geometry,
            list_zones,
            list_anchors,
            list_portals,
            get_entity
        ])
        .run(tauri::generate_context!())
        .expect("failed to run 888 desktop");
}
