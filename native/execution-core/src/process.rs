use crate::protocol::{Event, OutputMode, StdinMode};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

pub type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct ManagedProcess {
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
}

impl ManagedProcess {
    pub fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "stdin lock poisoned".to_string())?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "stdin is not piped or is already closed".to_string())?;
        stdin
            .write_all(bytes)
            .map_err(|e| format!("write stdin failed: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("flush stdin failed: {e}"))
    }

    pub fn close_stdin(&self) -> Result<(), String> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "stdin lock poisoned".to_string())?;
        guard.take();
        Ok(())
    }
}

pub fn resolve_executable(command: &str, env: &HashMap<String, String>) -> Result<PathBuf, String> {
    if command.is_empty() {
        return Err("executable name must be non-empty".to_string());
    }
    let path = Path::new(command);
    if path.is_absolute() {
        return verify_executable(path).map(PathBuf::from);
    }
    if command.contains('/') || command.contains('\\') {
        return Err(format!(
            "relative executable paths are not allowed: {command:?}"
        ));
    }
    let path_value = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for dir in std::env::split_paths(&path_value) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(command);
        if verify_executable(&candidate).is_ok() {
            return candidate
                .canonicalize()
                .map_err(|e| format!("canonicalize executable failed: {e}"));
        }
    }
    Err(format!("executable not found in PATH: {command}"))
}

fn verify_executable(path: &Path) -> Result<&Path, String> {
    let metadata = path
        .metadata()
        .map_err(|e| format!("executable is not accessible: {e}"))?;
    if !metadata.is_file() {
        return Err("executable path is not a file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("executable path is not executable".to_string());
        }
    }
    Ok(path)
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_process(
    process_id: String,
    argv: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    stdin_mode: StdinMode,
    stdin_data: Option<Vec<u8>>,
    stdout_mode: OutputMode,
    stderr_mode: OutputMode,
    writer: Writer,
    registry: Arc<Mutex<HashMap<String, Arc<ManagedProcess>>>>,
) -> Result<Arc<ManagedProcess>, String> {
    let program = argv
        .first()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "argv[0] must be non-empty".to_string())?;
    let mut command = Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(&cwd)
        .env_clear()
        .envs(env);
    command.stdin(match stdin_mode {
        StdinMode::Ignore => Stdio::null(),
        StdinMode::Pipe | StdinMode::Data => Stdio::piped(),
    });
    command.stdout(match stdout_mode {
        OutputMode::Pipe => Stdio::piped(),
        OutputMode::Ignore => Stdio::null(),
    });
    command.stderr(match stderr_mode {
        OutputMode::Pipe => Stdio::piped(),
        OutputMode::Ignore => Stdio::null(),
    });

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    libc::_exit(125);
                }
            }
            Ok(())
        });
    }

    let mut child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.id();
    let mut child_stdin = child.stdin.take();
    if matches!(stdin_mode, StdinMode::Data) {
        let write_result = (|| -> Result<(), String> {
            if let Some(data) = stdin_data {
                if let Some(stdin) = child_stdin.as_mut() {
                    stdin
                        .write_all(&data)
                        .map_err(|e| format!("initial stdin write failed: {e}"))?;
                    stdin
                        .flush()
                        .map_err(|e| format!("initial stdin flush failed: {e}"))?;
                }
            }
            Ok(())
        })();
        child_stdin.take();
        if let Err(error) = write_result {
            #[cfg(unix)]
            {
                let _ = signal_tree(pid, "SIGKILL");
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
            return Err(error);
        }
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let managed = Arc::new(ManagedProcess {
        pid,
        stdin: Mutex::new(child_stdin),
    });
    match registry.lock() {
        Ok(mut guard) => {
            guard.insert(process_id.clone(), managed.clone());
        }
        Err(_) => {
            #[cfg(unix)]
            {
                let _ = signal_tree(pid, "SIGKILL");
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
            return Err("process registry lock poisoned".to_string());
        }
    }

    if let Some(stdout) = stdout {
        stream_output(process_id.clone(), "stdout", stdout, writer.clone());
    }
    if let Some(stderr) = stderr {
        stream_output(process_id.clone(), "stderr", stderr, writer.clone());
    }

    thread::spawn(move || {
        let status = child.wait();
        let (exit_code, signal) = match status {
            Ok(status) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (
                        status.code(),
                        status.signal().and_then(signal_name).map(str::to_string),
                    )
                }
                #[cfg(not(unix))]
                {
                    (status.code(), None)
                }
            }
            Err(_) => (None, None),
        };
        if let Some(process) = registry
            .lock()
            .ok()
            .and_then(|guard| guard.get(&process_id).cloned())
        {
            let _ = process.close_stdin();
        }
        let event = Event::Exit {
            process_id: process_id.clone(),
            exit_code,
            signal,
        };
        let _ = write_json(&writer, &event);
        // Keep the process identity after the leader exits so callers can still
        // observe helpers in the detached group. Remove it only after the group
        // itself is proven gone.
        while tree_alive(pid) {
            thread::sleep(std::time::Duration::from_millis(15));
        }
        if let Ok(mut guard) = registry.lock() {
            guard.remove(&process_id);
        }
    });

    Ok(managed)
}

fn stream_output<R: Read + Send + 'static>(
    process_id: String,
    stream_name: &'static str,
    mut stream: R,
    writer: Writer,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            let data_b64 = BASE64.encode(&buffer[..read]);
            let event = if stream_name == "stdout" {
                Event::Stdout {
                    process_id: process_id.clone(),
                    data_b64,
                }
            } else {
                Event::Stderr {
                    process_id: process_id.clone(),
                    data_b64,
                }
            };
            if write_json(&writer, &event).is_err() {
                break;
            }
        }
        let _ = write_json(
            &writer,
            &Event::StreamClosed {
                process_id,
                stream: stream_name,
            },
        );
    });
}

#[cfg(unix)]
pub(crate) fn signal_name(signal: i32) -> Option<&'static str> {
    match signal {
        libc::SIGTERM => Some("SIGTERM"),
        libc::SIGKILL => Some("SIGKILL"),
        libc::SIGINT => Some("SIGINT"),
        libc::SIGHUP => Some("SIGHUP"),
        libc::SIGTSTP => Some("SIGTSTP"),
        _ => None,
    }
}

pub fn write_json<T: serde::Serialize>(writer: &Writer, value: &T) -> Result<(), String> {
    let mut guard = writer
        .lock()
        .map_err(|_| "protocol writer lock poisoned".to_string())?;
    serde_json::to_writer(&mut *guard, value)
        .map_err(|e| format!("serialize response failed: {e}"))?;
    guard
        .write_all(b"\n")
        .map_err(|e| format!("write response failed: {e}"))?;
    guard
        .flush()
        .map_err(|e| format!("flush response failed: {e}"))
}

#[cfg(unix)]
pub(crate) fn signal_number(signal: &str) -> Result<i32, String> {
    match signal {
        "SIGTERM" => Ok(libc::SIGTERM),
        "SIGKILL" => Ok(libc::SIGKILL),
        "SIGINT" => Ok(libc::SIGINT),
        "SIGHUP" => Ok(libc::SIGHUP),
        "SIGTSTP" => Ok(libc::SIGTSTP),
        other => Err(format!("unsupported signal: {other}")),
    }
}

#[cfg(not(unix))]
pub(crate) fn signal_number(signal: &str) -> Result<i32, String> {
    Err(format!(
        "native signals are not implemented on this platform: {signal}"
    ))
}

#[cfg(unix)]
pub fn signal_tree(pid: u32, signal: &str) -> Result<(), String> {
    let sig = signal_number(signal)?;
    let result = unsafe { libc::kill(-(pid as i32), sig) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("signal process group failed: {error}"))
    }
}

#[cfg(not(unix))]
pub fn signal_tree(_pid: u32, _signal: &str) -> Result<(), String> {
    Err("native process-tree signalling is not implemented on this platform".to_string())
}

#[cfg(unix)]
pub fn tree_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(-(pid as i32), 0) };
    if result == 0 {
        return true;
    }
    let error = std::io::Error::last_os_error();
    error.raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn tree_alive(_pid: u32) -> bool {
    false
}
