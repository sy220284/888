use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderLocation {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderHealth {
    Healthy,
    Degraded,
    Unavailable,
    RateLimited,
    AuthError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub capability: String,
    pub location: ProviderLocation,
    pub health: ProviderHealth,
    pub model_id: Option<String>,
    pub model_version: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderRequest {
    pub request_id: Uuid,
    pub capability: String,
    pub input_artifact_ids: Vec<Uuid>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderResult {
    pub artifact_ids: Vec<Uuid>,
    pub payload: Value,
    pub metadata: Value,
}

pub trait ProviderAdapter: Send + Sync {
    fn descriptor(&self) -> ProviderDescriptor;
    fn validate(&self, request: &ProviderRequest) -> Result<()>;
}

pub fn ensure_artifact_referenced_payload(value: &Value) -> Result<()> {
    match value {
        Value::String(value)
            if value
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:")) =>
        {
            bail!("provider payload must reference Artifact ids instead of data URIs");
        }
        Value::Array(values) => {
            for value in values {
                ensure_artifact_referenced_payload(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                ensure_artifact_referenced_payload(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ensure_artifact_referenced_payload;

    #[test]
    fn rejects_embedded_binary_payloads() {
        assert!(ensure_artifact_referenced_payload(&json!({
            "image": "data:image/png;base64,AAAA"
        }))
        .is_err());
        assert!(ensure_artifact_referenced_payload(&json!({
            "artifact_id": "8a1f34d6-3116-4f00-8aec-1b48d9b79131"
        }))
        .is_ok());
    }
}
