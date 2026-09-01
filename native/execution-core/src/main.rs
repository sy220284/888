mod process;
mod protocol;
mod terminal;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use process::{ManagedProcess, Writer};
use protocol::{
    AliveResult, Capabilities, ExecutableResult, HelloResult, InspectTerminalResult, Request,
    RequestKind, Response, SignalForegroundResult, SpawnResult,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};
use terminal::ManagedTerminal;

fn main() {
    let writer: Writer = Arc::new(Mutex::new(Box::new(io::stdout())));
    let processes: Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminals: Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>> =
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
        let result = handle(
            request,
            writer.clone(),
            processes.clone(),
            terminals.clone(),
        );
        match result {
            Ok(value) => {
                let _ = process::write_json(&writer, &Response::success(id, value));
            }
            Err(error) => {
                let _ = process::write_json(&writer, &Response::<Value>::failure(id, error));
            }
        }
    }
    if let Ok(registry) = processes.lock() {
        for process in registry.values() {
            let _ = process::signal_tree(process.pid, "SIGKILL");
        }
    }
    if let Ok(registry) = terminals.lock() {
        for terminal in registry.values() {
            let _ = terminal::signal_session(terminal.pid, "SIGKILL");
        }
    };
}

fn handle(
    request: Request,
    writer: Writer,
    processes: Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>>,
    terminals: Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
) -> Result<Value, String> {
    match request.kind {
        RequestKind::Hello => serde_json::to_value(HelloResult {
            protocol: 1,
            platform: std::env::consts::OS,
            capabilities: Capabilities {
                process_tree: cfg!(unix),
                terminal: cfg!(target_os = "linux"),
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
            ensure_unused(&process_id, &processes, &terminals)?;
            let stdin_data = stdin_data_b64
                .map(|value| {
                    BASE64
                        .decode(value)
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
                processes,
            )?;
            serde_json::to_value(SpawnResult {
                process_id,
                pid: managed.pid,
            })
            .map_err(|e| e.to_string())
        }
        RequestKind::SpawnTerminal {
            process_id,
            argv,
            cwd,
            env,
            rows,
            cols,
        } => {
            ensure_unused(&process_id, &processes, &terminals)?;
            let managed = terminal::spawn_terminal(
                process_id.clone(),
                argv,
                cwd,
                env,
                rows,
                cols,
                writer,
                terminals,
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
            let process = lookup_process(&processes, &process_id)?;
            process.write_stdin(&data)?;
            Ok(json!({}))
        }
        RequestKind::CloseStdin { process_id } => {
            if let Ok(process) = lookup_process(&processes, &process_id) {
                process.close_stdin()?;
            }
            Ok(json!({}))
        }
        RequestKind::WriteTerminal {
            process_id,
            data_b64,
        } => {
            let data = BASE64
                .decode(data_b64)
                .map_err(|e| format!("invalid terminal base64: {e}"))?;
            lookup_terminal(&terminals, &process_id)?.write(&data)?;
            Ok(json!({}))
        }
        RequestKind::InspectTerminal { process_id } => {
            let foreground = lookup_terminal(&terminals, &process_id)?.foreground()?;
            serde_json::to_value(InspectTerminalResult { foreground }).map_err(|e| e.to_string())
        }
        RequestKind::SignalForeground { process_id, signal } => {
            let terminal = lookup_terminal(&terminals, &process_id)?;
            let process_group_id = terminal::signal_foreground(&terminal, &signal)?;
            serde_json::to_value(SignalForegroundResult { process_group_id })
                .map_err(|e| e.to_string())
        }
        RequestKind::SignalTree { process_id, signal } => {
            if let Ok(process) = lookup_process(&processes, &process_id) {
                process::signal_tree(process.pid, &signal)?;
            } else if let Ok(terminal) = lookup_terminal(&terminals, &process_id) {
                terminal::signal_session(terminal.pid, &signal)?;
            }
            Ok(json!({}))
        }
        RequestKind::TreeAlive { process_id } => {
            let alive = if let Ok(process) = lookup_process(&processes, &process_id) {
                process::tree_alive(process.pid)
            } else if let Ok(terminal) = lookup_terminal(&terminals, &process_id) {
                terminal::session_alive(terminal.pid)
            } else {
                false
            };
            serde_json::to_value(AliveResult { alive }).map_err(|e| e.to_string())
        }
    }
}

fn ensure_unused(
    process_id: &str,
    processes: &Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>>,
    terminals: &Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
) -> Result<(), String> {
    if processes
        .lock()
        .map_err(|_| "process registry lock poisoned".to_string())?
        .contains_key(process_id)
        || terminals
            .lock()
            .map_err(|_| "terminal registry lock poisoned".to_string())?
            .contains_key(process_id)
    {
        return Err(format!("duplicate process id: {process_id}"));
    }
    Ok(())
}

fn lookup_process(
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

fn lookup_terminal(
    registry: &Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
    process_id: &str,
) -> Result<Arc<ManagedTerminal>, String> {
    registry
        .lock()
        .map_err(|_| "terminal registry lock poisoned".to_string())?
        .get(process_id)
        .cloned()
        .ok_or_else(|| format!("unknown terminal id: {process_id}"))
}
