use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RequestKind {
    Hello,
    ResolveExecutable {
        command: String,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Spawn {
        process_id: String,
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: HashMap<String, String>,
        stdin_mode: StdinMode,
        #[serde(default)]
        stdin_data_b64: Option<String>,
        stdout_mode: OutputMode,
        stderr_mode: OutputMode,
    },
    WriteStdin { process_id: String, data_b64: String },
    CloseStdin { process_id: String },
    SignalTree { process_id: String, signal: String },
    TreeAlive { process_id: String },
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub kind: RequestKind,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StdinMode {
    Ignore,
    Pipe,
    Data,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    Pipe,
    Ignore,
}

#[derive(Debug, Serialize)]
pub struct Response<T: Serialize> {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T: Serialize> Response<T> {
    pub fn success(id: u64, result: T) -> Self {
        Self { id, ok: true, result: Some(result), error: None }
    }
}

impl Response<serde_json::Value> {
    pub fn failure(id: u64, error: impl Into<String>) -> Self {
        Self { id, ok: false, result: None, error: Some(error.into()) }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Stdout { process_id: String, data_b64: String },
    Stderr { process_id: String, data_b64: String },
    StreamClosed { process_id: String, stream: &'static str },
    Exit {
        process_id: String,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct HelloResult {
    pub protocol: u32,
    pub platform: &'static str,
    pub capabilities: Capabilities,
}

#[derive(Debug, Serialize)]
pub struct Capabilities {
    pub process_tree: bool,
    pub terminal: bool,
    pub filesystem: bool,
    pub network_policy: bool,
}

#[derive(Debug, Serialize)]
pub struct SpawnResult {
    pub process_id: String,
    pub pid: u32,
}

#[derive(Debug, Serialize)]
pub struct ExecutableResult {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct AliveResult {
    pub alive: bool,
}
