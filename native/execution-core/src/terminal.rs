use crate::process::{signal_number, write_json, Writer};
use crate::protocol::{Event, ForegroundResult};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use std::fs::{read_dir, read_to_string, File};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct ManagedTerminal {
    pub pid: u32,
    master: Mutex<File>,
}

impl ManagedTerminal {
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self
            .master
            .lock()
            .map_err(|_| "terminal master lock poisoned".to_string())?;
        guard
            .write_all(bytes)
            .map_err(|e| format!("terminal write failed: {e}"))?;
        guard
            .flush()
            .map_err(|e| format!("terminal flush failed: {e}"))
    }

    pub fn foreground(&self) -> Result<Option<ForegroundResult>, String> {
        #[cfg(target_os = "linux")]
        {
            let guard = self
                .master
                .lock()
                .map_err(|_| "terminal master lock poisoned".to_string())?;
            let pgid = unsafe { libc::tcgetpgrp(guard.as_raw_fd()) };
            if pgid < 1 {
                let error = std::io::Error::last_os_error();
                if matches!(error.raw_os_error(), Some(libc::ENOTTY) | Some(libc::ESRCH)) {
                    return Ok(None);
                }
                return Err(format!("terminal foreground query failed: {error}"));
            }
            Ok(Some(ForegroundResult {
                process_group_id: pgid,
                input_waiting: process_group_waits_on_stdin(pgid),
            }))
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(None)
        }
    }
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    process_id: String,
    argv: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    rows: u16,
    cols: u16,
    writer: Writer,
    registry: Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
) -> Result<Arc<ManagedTerminal>, String> {
    if rows == 0 || cols == 0 {
        return Err("terminal rows and cols must be positive".to_string());
    }
    let program = argv
        .first()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "argv[0] must be non-empty".to_string())?;

    let (master, slave) = open_pty(rows, cols)?;
    let stdin = slave
        .try_clone()
        .map_err(|e| format!("clone terminal slave failed: {e}"))?;
    let stdout = slave
        .try_clone()
        .map_err(|e| format!("clone terminal slave failed: {e}"))?;
    let stderr = slave
        .try_clone()
        .map_err(|e| format!("clone terminal slave failed: {e}"))?;

    let mut command = Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            for signal in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            let empty: libc::sigset_t = std::mem::zeroed();
            if libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() == 1 {
                libc::_exit(125);
            }
            Ok(())
        });
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("terminal spawn failed: {e}"))?;
    drop(slave);
    let pid = child.id();
    let reader = master
        .try_clone()
        .map_err(|e| format!("clone terminal master failed: {e}"))?;
    let managed = Arc::new(ManagedTerminal {
        pid,
        master: Mutex::new(master),
    });
    registry
        .lock()
        .map_err(|_| "terminal registry lock poisoned".to_string())?
        .insert(process_id.clone(), managed.clone());

    stream_terminal(process_id.clone(), reader, writer.clone());
    thread::spawn(move || {
        let status = child.wait();
        let (exit_code, signal) = match status {
            Ok(status) => {
                use std::os::unix::process::ExitStatusExt;
                (
                    status.code(),
                    status
                        .signal()
                        .and_then(super::process::signal_name)
                        .map(str::to_string),
                )
            }
            Err(_) => (None, None),
        };
        let _ = write_json(
            &writer,
            &Event::Exit {
                process_id: process_id.clone(),
                exit_code,
                signal,
            },
        );
        while session_alive(pid) {
            thread::sleep(Duration::from_millis(15));
        }
        if let Ok(mut guard) = registry.lock() {
            guard.remove(&process_id);
        }
    });

    Ok(managed)
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    _process_id: String,
    _argv: Vec<String>,
    _cwd: String,
    _env: HashMap<String, String>,
    _rows: u16,
    _cols: u16,
    _writer: Writer,
    _registry: Arc<Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
) -> Result<Arc<ManagedTerminal>, String> {
    Err("native terminal is currently implemented only on Linux".to_string())
}

#[cfg(target_os = "linux")]
fn open_pty(rows: u16, cols: u16) -> Result<(File, File), String> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &size,
        )
    };
    if result != 0 {
        return Err(format!(
            "openpty failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if let Err(error) = set_cloexec(master).and_then(|_| set_cloexec(slave)) {
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        return Err(format!("configure PTY descriptors failed: {error}"));
    }
    Ok(unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) })
}

#[cfg(target_os = "linux")]
fn set_cloexec(fd: RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn stream_terminal(process_id: String, mut reader: File, writer: Writer) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                Err(_) => break,
            };
            if write_json(
                &writer,
                &Event::TerminalOutput {
                    process_id: process_id.clone(),
                    data_b64: BASE64.encode(&buffer[..count]),
                },
            )
            .is_err()
            {
                break;
            }
        }
        let _ = write_json(&writer, &Event::TerminalClosed { process_id });
    });
}

#[cfg(target_os = "linux")]
pub fn signal_foreground(terminal: &ManagedTerminal, signal: &str) -> Result<i32, String> {
    let foreground = terminal.foreground()?.ok_or_else(|| {
        format!(
            "cannot resolve foreground process group for terminal {}",
            terminal.pid
        )
    })?;
    if signal == "SIGKILL" && foreground.process_group_id == terminal.pid as i32 {
        return Err(
            "refusing to SIGKILL the terminal shell; terminate the terminal session instead"
                .to_string(),
        );
    }
    let sig = signal_number(signal)?;
    let result = unsafe { libc::kill(-foreground.process_group_id, sig) };
    if result == 0 {
        Ok(foreground.process_group_id)
    } else {
        Err(format!(
            "signal terminal foreground failed: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(target_os = "linux"))]
pub fn signal_foreground(_terminal: &ManagedTerminal, _signal: &str) -> Result<i32, String> {
    Err("native terminal is currently implemented only on Linux".to_string())
}

#[cfg(target_os = "linux")]
pub fn signal_session(pid: u32, signal: &str) -> Result<(), String> {
    let sig = signal_number(signal)?;
    let members = session_members(pid);
    if members.is_empty() {
        return Ok(());
    }
    let mut first_error = None;
    for member in members {
        if unsafe { libc::kill(member as i32, sig) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) && first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(format!("signal terminal session failed: {error}")),
        None => Ok(()),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn signal_session(_pid: u32, _signal: &str) -> Result<(), String> {
    Err("native terminal is currently implemented only on Linux".to_string())
}

#[cfg(target_os = "linux")]
pub fn session_alive(pid: u32) -> bool {
    !session_members(pid).is_empty()
}

#[cfg(not(target_os = "linux"))]
pub fn session_alive(_pid: u32) -> bool {
    false
}

#[derive(Clone, Copy)]
struct ProcStat {
    pid: u32,
    pgrp: i32,
    session: i32,
    state: char,
}

#[cfg(target_os = "linux")]
fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let pid = text[..open].trim().parse::<u32>().ok()?;
    let rest: Vec<&str> = text[close + 1..].split_whitespace().collect();
    let state = rest.first()?.chars().next()?;
    let pgrp = rest.get(2)?.parse::<i32>().ok()?;
    let session = rest.get(3)?.parse::<i32>().ok()?;
    Some(ProcStat {
        pid,
        pgrp,
        session,
        state,
    })
}

#[cfg(target_os = "linux")]
fn proc_stats() -> Vec<ProcStat> {
    let Ok(entries) = read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .filter_map(|pid| read_to_string(format!("/proc/{pid}/stat")).ok())
        .filter_map(|text| parse_proc_stat(&text))
        .collect()
}

#[cfg(target_os = "linux")]
fn session_members(session_id: u32) -> Vec<u32> {
    proc_stats()
        .into_iter()
        .filter(|stat| stat.session == session_id as i32 && !matches!(stat.state, 'Z' | 'X' | 'x'))
        .map(|stat| stat.pid)
        .collect()
}

#[cfg(target_os = "linux")]
fn process_group_waits_on_stdin(pgid: i32) -> bool {
    for stat in proc_stats().into_iter().filter(|stat| stat.pgrp == pgid) {
        let Ok(tasks) = read_dir(format!("/proc/{}/task", stat.pid)) else {
            continue;
        };
        for task in tasks.flatten() {
            let tid = task.file_name().to_string_lossy().into_owned();
            let Ok(syscall) = read_to_string(format!("/proc/{}/task/{tid}/syscall", stat.pid))
            else {
                continue;
            };
            if syscall_waits_on_stdin(&syscall) {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn syscall_waits_on_stdin(text: &str) -> bool {
    let mut fields = text.split_whitespace();
    let Ok(number) = fields.next().unwrap_or_default().parse::<i64>() else {
        return false;
    };
    let arg0 = fields
        .next()
        .and_then(|value| i64::from_str_radix(value.trim_start_matches("0x"), 16).ok())
        .unwrap_or(-1);
    #[cfg(target_arch = "x86_64")]
    const READ_SYSCALL: i64 = 0;
    #[cfg(target_arch = "aarch64")]
    const READ_SYSCALL: i64 = 63;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    const READ_SYSCALL: i64 = -2;
    number == READ_SYSCALL && arg0 == 0
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::{parse_proc_stat, syscall_waits_on_stdin};

    #[test]
    #[cfg(target_os = "linux")]
    fn parses_linux_proc_stat_with_parenthesized_name() {
        let stat =
            parse_proc_stat("42 (a tricky) S 1 77 42 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 1 0 999 0")
                .unwrap();
        assert_eq!(stat.pid, 42);
        assert_eq!(stat.pgrp, 77);
        assert_eq!(stat.session, 42);
    }

    #[test]
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn recognizes_x64_read_on_stdin() {
        assert!(syscall_waits_on_stdin("0 0x0 0x7fff 0x100 0 0 0 0 0"));
        assert!(!syscall_waits_on_stdin("0 0x1 0x7fff 0x100 0 0 0 0 0"));
    }
}
