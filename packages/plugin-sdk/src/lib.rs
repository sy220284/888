use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PluginKind {
    Reconstruction,
    Provider,
    Evaluator,
    Compiler,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginDescriptor {
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginContext {
    pub world_id: Option<Uuid>,
    pub revision_id: Option<Uuid>,
    pub input_artifact_ids: Vec<Uuid>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginOutput {
    pub artifact_ids: Vec<Uuid>,
    pub payload: Value,
}

pub trait Plugin: Send + Sync {
    fn descriptor(&self) -> PluginDescriptor;
    fn execute(&self, context: &PluginContext) -> Result<PluginOutput>;
}
