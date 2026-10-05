use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_status])
        .run(tauri::generate_context!())
        .expect("failed to run 888 desktop");
}
