use anyhow::{bail, Context, Result};
use reqwest::{Client, Url};

const FAL_QUEUE_BASE_URL: &str = "https://queue.fal.run";
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FalSubmission {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FalStatusSnapshot {
    pub status: String,
    pub raw: Value,
}

impl FalStatusSnapshot {
    pub fn is_completed(&self) -> bool {
        self.status.eq_ignore_ascii_case("COMPLETED")
    }

    pub fn is_failed(&self) -> bool {
        matches!(
            self.status.to_ascii_uppercase().as_str(),
            "FAILED" | "ERROR" | "CANCELLED" | "CANCELED"
        )
    }

    pub fn error_message(&self) -> Option<String> {
        self.raw.get("error").and_then(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Null => None,
            other => Some(other.to_string()),
        })
    }
}

#[derive(Clone)]
pub struct FalQueueClient {
    http: Client,
    api_key: String,
}

impl FalQueueClient {
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            bail!("FAL API key must not be empty");
        }
        Ok(Self {
            http: Client::new(),
            api_key,
        })
    }

    pub async fn submit(&self, endpoint: &str, input: &Value) -> Result<FalSubmission> {
        validate_endpoint(endpoint)?;
        let url = format!("{FAL_QUEUE_BASE_URL}/{}", endpoint.trim_start_matches('/'));
        let response = self
            .http
            .post(url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Key {}", self.api_key),
            )
            .json(input)
            .send()
            .await
            .context("FAL submit request failed")?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("FAL submit failed ({status}): {}", compact_error(&body));
        }

        let request_id = body
            .get("request_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .context("FAL submit response did not include request_id")?;

        Ok(FalSubmission {
            request_id: request_id.to_owned(),
        })
    }

    pub async fn status(
        &self,
        endpoint: &str,
        submission: &FalSubmission,
        include_logs: bool,
    ) -> Result<FalStatusSnapshot> {
        validate_endpoint(endpoint)?;
        let default = format!(
            "{}/{}/requests/{}/status",
            FAL_QUEUE_BASE_URL,
            endpoint.trim_start_matches('/'),
            submission.request_id
        );
        let mut url = Url::parse(&default).context("invalid FAL status URL")?;
        if include_logs {
            url.query_pairs_mut().append_pair("logs", "1");
        }

        let response = self
            .http
            .get(url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Key {}", self.api_key),
            )
            .send()
            .await
            .context("FAL status request failed")?;
        let status_code = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status_code.is_success() {
            bail!(
                "FAL status failed ({status_code}): {}",
                compact_error(&body)
            );
        }
        let status = body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_owned();
        Ok(FalStatusSnapshot { status, raw: body })
    }

    pub async fn result(&self, endpoint: &str, submission: &FalSubmission) -> Result<Value> {
        validate_endpoint(endpoint)?;
        let default = format!(
            "{}/{}/requests/{}",
            FAL_QUEUE_BASE_URL,
            endpoint.trim_start_matches('/'),
            submission.request_id
        );
        let response = self
            .http
            .get(default)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Key {}", self.api_key),
            )
            .send()
            .await
            .context("FAL result request failed")?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("FAL result failed ({status}): {}", compact_error(&body));
        }
        Ok(body)
    }

}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    let endpoint = endpoint.trim_matches('/');
    if endpoint.is_empty()
        || endpoint.contains("..")
        || endpoint.starts_with("http://")
        || endpoint.starts_with("https://")
    {
        bail!("FAL endpoint must be a relative provider endpoint");
    }
    Ok(())
}

fn compact_error(body: &Value) -> String {
    let value = body
        .get("detail")
        .or_else(|| body.get("error"))
        .unwrap_or(body);
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{compact_error, validate_endpoint, FalStatusSnapshot};

    #[test]
    fn rejects_absolute_or_parent_endpoints() {
        assert!(validate_endpoint("fal-ai/model").is_ok());
        assert!(validate_endpoint("https://evil.example/model").is_err());
        assert!(validate_endpoint("../model").is_err());
    }

    #[test]
    fn understands_terminal_queue_states() {
        let completed = FalStatusSnapshot {
            status: "COMPLETED".into(),
            raw: json!({"status": "COMPLETED"}),
        };
        let failed = FalStatusSnapshot {
            status: "FAILED".into(),
            raw: json!({"status": "FAILED", "error": "boom"}),
        };
        assert!(completed.is_completed());
        assert!(failed.is_failed());
        assert_eq!(failed.error_message().as_deref(), Some("boom"));
        assert_eq!(compact_error(&json!({"detail": "bad"})), "bad");
    }
}
