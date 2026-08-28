mod process;
mod protocol;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use process::{ManagedProcess, Writer};
use protocol::{
    AliveResult, Capabilities, ExecutableResult, HelloResult, Request, RequestKind, Response,
    SpawnResult,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};

fn main() {
    let writer: Writer = Arc::new(Mutex::new(Box::new(io::stdout())));
    let registry: Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = process::write_json(
                    &writer,
                    &Response::<Value>::failure(0, format!("invalid request: {error}")),
                );
                continue;
            }
        };
        let id = request.id;
        let result = handle(request, writer.clone(), registry.clone());
        match result {
            Ok(value) => {
                let _ = process::write_json(&writer, &Response::success(id, value));
            }
            Err(error) => {
                let _ = process::write_json(&writer, &Response::<Value>::failure(id, error));
            }
        }
    }
    if let Ok(processes) = registry.lock() {
        for process in processes.values() {
            let _ = process::signal_tree(process.pid, "SIGKILL");
        }
    };
}

fn handle(
    request: Request,
    writer: Writer,
    registry: Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>>,
) -> Result<Value, String> {
    match request.kind {
        RequestKind::Hello => serde_json::to_value(HelloResult {
            protocol: 1,
            platform: std::env::consts::OS,
            capabilities: Capabilities {
                process_tree: cfg!(unix),
                terminal: false,
                filesystem: false,
                network_policy: false,
            },
        })
        .map_err(|e| e.to_string()),
        RequestKind::ResolveExecutable { command, env } => {
            let path = process::resolve_executable(&command, &env)?;
            serde_json::to_value(ExecutableResult {
                path: path.to_string_lossy().into_owned(),
            })
            .map_err(|e| e.to_string())
        }
        RequestKind::Spawn {
            process_id,
            argv,
            cwd,
            env,
            stdin_mode,
            stdin_data_b64,
            stdout_mode,
            stderr_mode,
        } => {
            if registry
                .lock()
                .map_err(|_| "process registry lock poisoned".to_string())?
                .contains_key(&process_id)
            {
                return Err(format!("duplicate process id: {process_id}"));
            }
            let stdin_data = stdin_data_b64
                .map(|v| {
                    BASE64
                        .decode(v)
                        .map_err(|e| format!("invalid stdin base64: {e}"))
                })
                .transpose()?;
            let managed = process::spawn_process(
                process_id.clone(),
                argv,
                cwd,
                env,
                stdin_mode,
                stdin_data,
                stdout_mode,
                stderr_mode,
                writer,
                registry,
            )?;
            serde_json::to_value(SpawnResult {
                process_id,
                pid: managed.pid,
            })
            .map_err(|e| e.to_string())
        }
        RequestKind::WriteStdin {
            process_id,
            data_b64,
        } => {
            let data = BASE64
                .decode(data_b64)
                .map_err(|e| format!("invalid stdin base64: {e}"))?;
            let process = lookup(&registry, &process_id)?;
            process.write_stdin(&data)?;
            Ok(json!({}))
        }
        RequestKind::CloseStdin { process_id } => {
            if let Ok(process) = lookup(&registry, &process_id) {
                process.close_stdin()?;
            }
            Ok(json!({}))
        }
        RequestKind::SignalTree { process_id, signal } => {
            if let Ok(process) = lookup(&registry, &process_id) {
                process::signal_tree(process.pid, &signal)?;
            }
            Ok(json!({}))
        }
        RequestKind::TreeAlive { process_id } => {
            let pid = lookup(&registry, &process_id)
                .map(|p| p.pid)
                .unwrap_or_else(|_| 0);
            serde_json::to_value(AliveResult {
                alive: process::tree_alive(pid),
            })
            .map_err(|e| e.to_string())
        }
    }
}

fn lookup(
    registry: &Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>>,
    process_id: &str,
) -> Result<Arc<ManagedProcess>, String> {
    registry
        .lock()
        .map_err(|_| "process registry lock poisoned".to_string())?
        .get(process_id)
        .cloned()
        .ok_or_else(|| format!("unknown process id: {process_id}"))
}
