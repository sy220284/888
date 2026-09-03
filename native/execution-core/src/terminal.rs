use crate::process::{signal_number, signal_tree, write_json, Writer};
use crate::protocol::{Event, ForegroundResult};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::fs::{read_dir, read_to_string, File};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ProcessIdentity {
    pid: u32,
    starttime: u64,
}

#[derive(Clone, Copy, Debug)]
struct ProcStat {
    pid: u32,
    ppid: u32,
    pgrp: i32,
    session: i32,
    state: char,
    starttime: u64,
}

impl ProcStat {
    fn identity(self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            starttime: self.starttime,
        }
    }

    fn live(self) -> bool {
        !matches!(self.state, 'Z' | 'X' | 'x')
    }
}

pub struct ManagedTerminal {
    pub pid: u32,
    root: ProcessIdentity,
    session_id: i32,
    master: Mutex<File>,
    tracked: Mutex<HashSet<ProcessIdentity>>,
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
            self.refresh_tracked()?;
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
                input_waiting: process_group_waits_on_stdin(pgid)?,
            }))
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(None)
        }
    }

    #[cfg(target_os = "linux")]
    pub fn signal_tree(&self, signal: &str) -> Result<(), String> {
        let sig = signal_number(signal)?;
        let members = self.refresh_tracked()?;
        let mut first_error = None;
        // Descendants first: if the root exits and reparents children during
        // cleanup, every already-observed identity remains fenced and owned.
        for identity in members
            .iter()
            .copied()
            .filter(|identity| *identity != self.root)
            .chain(std::iter::once(self.root))
        {
            if let Err(error) = signal_identity(identity, sig) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(format!("signal terminal tree failed: {error}")),
            None => Ok(()),
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn signal_tree(&self, _signal: &str) -> Result<(), String> {
        Err("native terminal is currently implemented only on Linux".to_string())
    }

    #[cfg(target_os = "linux")]
    pub fn tree_alive(&self) -> Result<bool, String> {
        Ok(!self.refresh_tracked()?.is_empty())
    }

    #[cfg(not(target_os = "linux"))]
    pub fn tree_alive(&self) -> Result<bool, String> {
        Ok(false)
    }

    #[cfg(target_os = "linux")]
    fn refresh_tracked(&self) -> Result<Vec<ProcessIdentity>, String> {
        let stats = proc_stats()?;
        let by_pid: HashMap<u32, ProcStat> =
            stats.iter().copied().map(|stat| (stat.pid, stat)).collect();
        let root_current = by_pid
            .get(&self.root.pid)
            .copied()
            .filter(|stat| stat.starttime == self.root.starttime);
        let root_verified = root_current.is_some();

        let mut tracked = self
            .tracked
            .lock()
            .map_err(|_| "terminal descendant registry lock poisoned".to_string())?;
        tracked.retain(|identity| {
            by_pid
                .get(&identity.pid)
                .is_some_and(|stat| stat.starttime == identity.starttime && stat.live())
        });

        if root_verified {
            for stat in stats.iter().copied().filter(|stat| stat.live()) {
                if stat.pid == self.root.pid {
                    continue;
                }
                if stat.session == self.session_id
                    || is_descendant_of(stat.pid, self.root.pid, &by_pid)
                {
                    tracked.insert(stat.identity());
                }
            }
        }

        let mut live = tracked.iter().copied().collect::<Vec<_>>();
        if root_current.is_some_and(ProcStat::live) {
            live.push(self.root);
        }
        Ok(live)
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
    // The child is not reaped yet, so even an immediately-exited command still
    // has a /proc identity here as a zombie. Capture starttime before any wait.
    let root_stat = match read_proc_stat(pid).and_then(|stat| {
        stat.ok_or_else(|| format!("terminal root identity disappeared before publication: {pid}"))
    }) {
        Ok(stat) => stat,
        Err(error) => return fail_spawned_terminal(&mut child, pid, error),
    };
    let reader = match master.try_clone() {
        Ok(reader) => reader,
        Err(error) => {
            return fail_spawned_terminal(
                &mut child,
                pid,
                format!("clone terminal master failed: {error}"),
            )
        }
    };
    let managed = Arc::new(ManagedTerminal {
        pid,
        root: root_stat.identity(),
        session_id: root_stat.session,
        master: Mutex::new(master),
        tracked: Mutex::new(HashSet::new()),
    });
    // Prime ownership while the root identity is still known, then keep a
    // background observer adopting descendants even when they call setsid().
    if let Err(error) = managed.refresh_tracked() {
        return fail_spawned_terminal(&mut child, pid, error);
    }
    match registry.lock() {
        Ok(mut guard) => {
            guard.insert(process_id.clone(), managed.clone());
        }
        Err(_) => {
            return fail_spawned_terminal(
                &mut child,
                pid,
                "terminal registry lock poisoned".to_string(),
            )
        }
    }

    let tracker = managed.clone();
    thread::spawn(move || {
        while let Ok(true) | Err(_) = tracker.tree_alive() {
            thread::sleep(Duration::from_millis(10));
        }
    });

    stream_terminal(process_id.clone(), reader, writer.clone());
    let completion_terminal = managed.clone();
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
        // Failure to inspect /proc is fail-closed: retain ownership and retry
        // instead of declaring the tree dead without proof.
        loop {
            match completion_terminal.tree_alive() {
                Ok(false) => break,
                Ok(true) | Err(_) => thread::sleep(Duration::from_millis(15)),
            }
        }
        if let Ok(mut guard) = registry.lock() {
            guard.remove(&process_id);
        }
    });

    Ok(managed)
}

#[cfg(target_os = "linux")]
fn fail_spawned_terminal<T>(child: &mut Child, pid: u32, error: String) -> Result<T, String> {
    let _ = signal_tree(pid, "SIGKILL");
    let _ = child.kill();
    let _ = child.wait();
    Err(error)
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
fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let pid = text[..open].trim().parse::<u32>().ok()?;
    let rest: Vec<&str> = text[close + 1..].split_whitespace().collect();
    let state = rest.first()?.chars().next()?;
    let ppid = rest.get(1)?.parse::<u32>().ok()?;
    let pgrp = rest.get(2)?.parse::<i32>().ok()?;
    let session = rest.get(3)?.parse::<i32>().ok()?;
    let starttime = rest.get(19)?.parse::<u64>().ok()?;
    Some(ProcStat {
        pid,
        ppid,
        pgrp,
        session,
        state,
        starttime,
    })
}

#[cfg(target_os = "linux")]
fn read_proc_stat(pid: u32) -> Result<Option<ProcStat>, String> {
    match read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => parse_proc_stat(&text)
            .map(Some)
            .ok_or_else(|| format!("invalid /proc/{pid}/stat")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read /proc/{pid}/stat failed: {error}")),
    }
}

#[cfg(target_os = "linux")]
fn proc_stats() -> Result<Vec<ProcStat>, String> {
    let entries = read_dir("/proc").map_err(|error| format!("read /proc failed: {error}"))?;
    let mut stats = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("iterate /proc failed: {error}"))?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some(stat) = read_proc_stat(pid)? {
            stats.push(stat);
        }
    }
    Ok(stats)
}

#[cfg(target_os = "linux")]
fn is_descendant_of(pid: u32, root_pid: u32, by_pid: &HashMap<u32, ProcStat>) -> bool {
    let mut current = pid;
    let mut seen = HashSet::new();
    while current != 0 && seen.insert(current) {
        let Some(stat) = by_pid.get(&current) else {
            return false;
        };
        if stat.ppid == root_pid {
            return true;
        }
        current = stat.ppid;
    }
    false
}

#[cfg(target_os = "linux")]
fn signal_identity(identity: ProcessIdentity, signal: i32) -> Result<(), String> {
    let Some(current) = read_proc_stat(identity.pid)? else {
        return Ok(());
    };
    if current.starttime != identity.starttime || !current.live() {
        return Ok(());
    }
    if unsafe { libc::kill(identity.pid as i32, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.to_string())
    }
}

#[cfg(target_os = "linux")]
fn process_group_waits_on_stdin(pgid: i32) -> Result<bool, String> {
    for stat in proc_stats()?.into_iter().filter(|stat| stat.pgrp == pgid) {
        let tasks = match read_dir(format!("/proc/{}/task", stat.pid)) {
            Ok(tasks) => tasks,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("read /proc/{}/task failed: {error}", stat.pid));
            }
        };
        for task in tasks {
            let task = task.map_err(|error| format!("iterate process tasks failed: {error}"))?;
            let tid = task.file_name().to_string_lossy().into_owned();
            let syscall = match read_to_string(format!("/proc/{}/task/{tid}/syscall", stat.pid)) {
                Ok(syscall) => syscall,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "read /proc/{}/task/{tid}/syscall failed: {error}",
                        stat.pid
                    ));
                }
            };
            if syscall_waits_on_stdin(&syscall) {
                return Ok(true);
            }
        }
    }
    Ok(false)
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
    use super::{is_descendant_of, parse_proc_stat, syscall_waits_on_stdin, ProcStat};
    #[cfg(target_os = "linux")]
    use std::collections::HashMap;

    #[test]
    #[cfg(target_os = "linux")]
    fn parses_linux_proc_stat_with_parenthesized_name_and_identity() {
        let padding = vec!["0"; 15].join(" ");
        let text = format!("42 (a tricky) S 1 77 42 {padding} 999");
        let stat = parse_proc_stat(&text).unwrap();
        assert_eq!(stat.pid, 42);
        assert_eq!(stat.ppid, 1);
        assert_eq!(stat.pgrp, 77);
        assert_eq!(stat.session, 42);
        assert_eq!(stat.starttime, 999);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn follows_descendants_across_session_changes() {
        let root = ProcStat {
            pid: 10,
            ppid: 1,
            pgrp: 10,
            session: 10,
            state: 'S',
            starttime: 1,
        };
        let child = ProcStat {
            pid: 11,
            ppid: 10,
            pgrp: 11,
            session: 11,
            state: 'S',
            starttime: 2,
        };
        let grandchild = ProcStat {
            pid: 12,
            ppid: 11,
            pgrp: 12,
            session: 12,
            state: 'S',
            starttime: 3,
        };
        let map = [root, child, grandchild]
            .into_iter()
            .map(|stat| (stat.pid, stat))
            .collect::<HashMap<_, _>>();
        assert!(is_descendant_of(11, 10, &map));
        assert!(is_descendant_of(12, 10, &map));
    }

    #[test]
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn recognizes_x64_read_on_stdin() {
        assert!(syscall_waits_on_stdin("0 0x0 0x7fff 0x100 0 0 0 0 0"));
        assert!(!syscall_waits_on_stdin("0 0x1 0x7fff 0x100 0 0 0 0 0"));
    }
}
