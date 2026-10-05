use std::io;

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;
use world888_core::{
    artifact_store::ArtifactStore,
    command_service::CommandService,
    model::{Command, CommandResponse},
};

struct CoreState {
    commands: CommandService,
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
    let command_id =
        Uuid::parse_str(&command_id).map_err(|_| "command_id 不是合法 UUID".to_owned())?;
    state
        .commands
        .get_response(command_id)
        .await
        .map_err(|error| error.to_string())
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
                commands: CommandService::with_artifact_store(pool, artifacts),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_status,
            execute_command,
            get_command_response
        ])
        .run(tauri::generate_context!())
        .expect("failed to run 888 desktop");
}
