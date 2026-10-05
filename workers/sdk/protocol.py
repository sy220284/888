from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

PROTOCOL_VERSION = 1
JOB_MESSAGE_TYPES = {"JOB_DISPATCH", "PROGRESS", "JOB_RESULT", "PAUSE", "CANCEL"}
LIFECYCLE_MESSAGE_TYPES = {"REGISTER", "HEARTBEAT", "SHUTDOWN"}
MESSAGE_TYPES = JOB_MESSAGE_TYPES | LIFECYCLE_MESSAGE_TYPES


def _json_default(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return asdict(value)
    raise TypeError(f"unsupported JSON value: {type(value)!r}")


def make_message(
    message_type: str,
    payload: dict[str, Any],
    *,
    job_id: UUID | str | None = None,
) -> dict[str, Any]:
    message = {
        "message_id": str(uuid4()),
        "message_type": message_type,
        "protocol_version": PROTOCOL_VERSION,
        "payload": payload,
    }
    if job_id is not None:
        message["job_id"] = str(job_id)
    validate_message(message)
    return message


def validate_message(message: dict[str, Any]) -> None:
    message_type = message.get("message_type")
    if message_type not in MESSAGE_TYPES:
        raise ValueError(f"unsupported worker message type: {message_type!r}")
    if message.get("protocol_version") != PROTOCOL_VERSION:
        raise ValueError(
            f"worker protocol mismatch: expected {PROTOCOL_VERSION}, "
            f"got {message.get('protocol_version')!r}"
        )
    if not isinstance(message.get("payload"), dict):
        raise ValueError("worker payload must be an object")

    has_job_id = bool(message.get("job_id"))
    if message_type in JOB_MESSAGE_TYPES and not has_job_id:
        raise ValueError(f"{message_type} requires job_id")
    if message_type in LIFECYCLE_MESSAGE_TYPES and has_job_id:
        raise ValueError(f"{message_type} must not contain job_id")

    _reject_embedded_binary(message["payload"])


def _reject_embedded_binary(value: Any) -> None:
    if isinstance(value, str) and value[:5].lower() == "data:":
        raise ValueError("worker protocol forbids data URI payloads; use Artifact Store")
    if isinstance(value, list):
        for item in value:
            _reject_embedded_binary(item)
    if isinstance(value, dict):
        for item in value.values():
            _reject_embedded_binary(item)


def encode_line(message: dict[str, Any]) -> str:
    validate_message(message)
    return json.dumps(
        message,
        ensure_ascii=False,
        separators=(",", ":"),
        default=_json_default,
    ) + "\n"


def decode_line(line: str) -> dict[str, Any]:
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("worker JSONL message must be an object")
    validate_message(message)
    return message
