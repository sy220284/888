use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::model::{WorkerMessage, WorkerMessageMessageType};

pub const WORKER_PROTOCOL_VERSION: u64 = 1;
pub const MAX_JSONL_MESSAGE_BYTES: usize = 1024 * 1024;

pub fn encode_message(message: &WorkerMessage) -> Result<String> {
    validate_message(message)?;
    let encoded = serde_json::to_string(message)?;
    if encoded.len() > MAX_JSONL_MESSAGE_BYTES {
        bail!(
            "worker message exceeds {} byte JSONL limit",
            MAX_JSONL_MESSAGE_BYTES
        );
    }
    Ok(format!("{encoded}\n"))
}

pub fn decode_message(line: &str) -> Result<WorkerMessage> {
    if line.len() > MAX_JSONL_MESSAGE_BYTES {
        bail!(
            "worker message exceeds {} byte JSONL limit",
            MAX_JSONL_MESSAGE_BYTES
        );
    }

    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        bail!("worker message must not be empty");
    }
    if line.contains('\n') || line.contains('\r') {
        bail!("worker JSONL decoder accepts exactly one message per line");
    }

    let message: WorkerMessage =
        serde_json::from_str(line).context("invalid worker JSONL message")?;
    validate_message(&message)?;
    Ok(message)
}

pub fn validate_message(message: &WorkerMessage) -> Result<()> {
    if message.protocol_version != WORKER_PROTOCOL_VERSION {
        bail!(
            "worker protocol mismatch: expected {}, got {}",
            WORKER_PROTOCOL_VERSION,
            message.protocol_version
        );
    }

    match message.message_type {
        WorkerMessageMessageType::JobDispatch
        | WorkerMessageMessageType::Progress
        | WorkerMessageMessageType::JobResult
        | WorkerMessageMessageType::Pause
        | WorkerMessageMessageType::Cancel => {
            if message.job_id.is_none() {
                bail!("worker job message requires job_id");
            }
        }
        WorkerMessageMessageType::Register
        | WorkerMessageMessageType::Heartbeat
        | WorkerMessageMessageType::Shutdown => {
            if message.job_id.is_some() {
                bail!("worker lifecycle message must not include job_id");
            }
        }
    }

    reject_embedded_binary(&message.payload)?;
    Ok(())
}

fn reject_embedded_binary(value: &Value) -> Result<()> {
    match value {
        Value::String(value) => {
            if value
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
            {
                bail!("worker protocol forbids data URI payloads; use Artifact Store");
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_embedded_binary(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                reject_embedded_binary(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use crate::model::{WorkerMessage, WorkerMessageMessageType};

    use super::{decode_message, encode_message, WORKER_PROTOCOL_VERSION};

    #[test]
    fn round_trips_one_jsonl_message() {
        let job_id = Uuid::new_v4();
        let message = WorkerMessage {
            message_id: Uuid::new_v4(),
            message_type: WorkerMessageMessageType::Progress,
            protocol_version: WORKER_PROTOCOL_VERSION,
            job_id: Some(job_id),
            payload: json!({"progress": 0.5, "artifact_id": Uuid::new_v4()}),
        };

        let encoded = encode_message(&message).unwrap();
        assert!(encoded.ends_with('\n'));
        assert_eq!(decode_message(&encoded).unwrap(), message);
    }

    #[test]
    fn rejects_large_binary_bypass_and_missing_job_identity() {
        let data_uri = WorkerMessage {
            message_id: Uuid::new_v4(),
            message_type: WorkerMessageMessageType::JobResult,
            protocol_version: WORKER_PROTOCOL_VERSION,
            job_id: Some(Uuid::new_v4()),
            payload: json!({"image": "data:image/png;base64,AAAA"}),
        };
        assert!(encode_message(&data_uri).is_err());

        let missing_job = WorkerMessage {
            message_id: Uuid::new_v4(),
            message_type: WorkerMessageMessageType::Cancel,
            protocol_version: WORKER_PROTOCOL_VERSION,
            job_id: None,
            payload: json!({}),
        };
        assert!(encode_message(&missing_job).is_err());
    }

    #[test]
    fn rejects_incompatible_protocol_version() {
        let message = WorkerMessage {
            message_id: Uuid::new_v4(),
            message_type: WorkerMessageMessageType::Heartbeat,
            protocol_version: WORKER_PROTOCOL_VERSION + 1,
            job_id: None,
            payload: json!({}),
        };
        assert!(encode_message(&message).is_err());
    }
}
