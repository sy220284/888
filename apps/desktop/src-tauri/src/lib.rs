use std::{io, path::PathBuf};

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;
use world888_core::{
    artifact_store::ArtifactStore,
    command_service::CommandService,
    model::{Command, CommandResponse, Observation, World},
    observation_repository::ObservationRepository,
    worker_runtime::{WorkerRuntime, WorkerSpec},
    world_repository::WorldRepository,
};

#[derive(Clone)]
struct CoreState {
    commands: CommandService,
    worlds: WorldRepository,
    observations: ObservationRepository,
    runtime: WorkerRuntime,
}

#[derive(Debug, Serialize)]
struct CoreStatus {
    status: &'static str,
    worker_protocol_version: u64,
    worker_count: usize,
}

#[tauri::command]
async fn core_status(state: State<'_, CoreState>) -> Result<CoreStatus, String> {
    Ok(CoreStatus {
        status: "ready",
        worker_protocol_version: world888_core::worker_protocol::WORKER_PROTOCOL_VERSION,
        worker_count: state.runtime.worker_count().await,
    })
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

#[tauri::command]
async fn list_worlds(state: State<'_, CoreState>) -> Result<Vec<World>, String> {
    state.worlds.list().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_observations(
    state: State<'_, CoreState>,
    world_id: String,
) -> Result<Vec<Observation>, String> {
    let world_id = Uuid::parse_str(&world_id).map_err(|_| "world_id 不是合法 UUID".to_owned())?;
    state
        .observations
        .list_for_world(world_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pick_observation_images() -> Vec<String> {
    rfd::FileDialog::new()
        .add_filter(
            "图片",
            &["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "avif", "heic"],
        )
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn worker_specs(artifact_root: &PathBuf, app_data_dir: &PathBuf) -> Vec<WorkerSpec> {
    let configured_python = std::env::var_os("WORLD888_PYTHON").map(PathBuf::from);
    let configured_worker_root = std::env::var_os("WORLD888_WORKER_ROOT").map(PathBuf::from);

    let locations = if let (Some(python), Some(worker_root)) =
        (configured_python, configured_worker_root)
    {
        Some((python, worker_root))
    } else if cfg!(debug_assertions) {
        let python = if cfg!(windows) {
            PathBuf::from("python")
        } else {
            PathBuf::from("python3")
        };
        let worker_root = std::env::var_os("WORLD888_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
        Some((python, worker_root))
    } else {
        let runtime_root = app_data_dir.join("worker-runtime");
        let worker_root = runtime_root.join("app");
        let candidates = if cfg!(windows) {
            vec![
                runtime_root.join("python").join("python.exe"),
                runtime_root.join("python.exe"),
            ]
        } else {
            vec![
                runtime_root.join("bin").join("python3"),
                runtime_root.join("bin").join("python"),
                runtime_root.join("python").join("bin").join("python3"),
            ]
        };
        candidates
            .into_iter()
            .find(|python| python.is_file() && worker_root.is_dir())
            .map(|python| (python, worker_root))
    };

    let Some((python, worker_root)) = locations else {
        eprintln!(
            "受控 Python Worker Runtime 未安装；Worker capability 暂不可用，桌面 Core 继续启动"
        );
        return Vec::new();
    };

    let python = python.to_string_lossy().into_owned();
    vec![
        WorkerSpec::python_module(
            "vision",
            python.clone(),
            "workers.vision.main",
            worker_root.clone(),
            artifact_root.clone(),
        ),
        WorkerSpec::python_module(
            "tools",
            python,
            "workers.tools.main",
            worker_root,
            artifact_root.clone(),
        ),
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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

            let runtime = tauri::async_runtime::block_on(WorkerRuntime::start(
                pool.clone(),
                artifacts.clone(),
                worker_specs(&artifact_root, &app_data_dir),
            ))
            .map_err(|error| io::Error::other(format!("初始化 Worker Runtime 失败：{error}")))?;

            app.manage(CoreState {
                commands: CommandService::with_runtime(
                    pool.clone(),
                    artifacts,
                    runtime.control_sender(),
                ),
                worlds: WorldRepository::new(pool.clone()),
                observations: ObservationRepository::new(pool),
                runtime,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_status,
            execute_command,
            get_command_response,
            list_worlds,
            list_observations,
            pick_observation_images,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build 888 desktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let runtime = app_handle.state::<CoreState>().runtime.clone();
            tauri::async_runtime::block_on(runtime.shutdown());
        }
    });
}
