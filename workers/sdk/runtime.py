from __future__ import annotations

import os
import platform
import sys
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Callable, TextIO
from uuid import UUID, uuid4

from .protocol import PROTOCOL_VERSION, decode_line, encode_line, make_message

Handler = Callable[["JobContext", dict[str, Any]], dict[str, Any]]


@dataclass(slots=True)
class JobContext:
    worker_id: UUID
    job_id: UUID
    emit_progress: Callable[[float, str, dict[str, Any] | None], None]
    is_cancelled: Callable[[], bool]


class WorkerApp:
    def __init__(
        self,
        worker_type: str,
        capabilities: list[str],
        handlers: dict[str, Handler],
        *,
        worker_id: UUID | None = None,
    ) -> None:
        self.worker_type = worker_type
        self.capabilities = capabilities
        self.handlers = handlers
        self.worker_id = worker_id or UUID(os.environ.get("WORLD888_WORKER_ID", str(uuid4())))
        self._cancelled_jobs: set[UUID] = set()

    def registration_payload(self) -> dict[str, Any]:
        return {
            "worker_id": str(self.worker_id),
            "worker_type": self.worker_type,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": self.capabilities,
            "device": {
                "platform": platform.system().lower(),
                "machine": platform.machine(),
            },
            "software": {
                "python": platform.python_version(),
                "worker_version": "0.1.0",
            },
        }

    def heartbeat_payload(self, current_job_ids: list[UUID] | None = None) -> dict[str, Any]:
        return {
            "worker_id": str(self.worker_id),
            "protocol_version": PROTOCOL_VERSION,
            "timestamp": datetime.now(UTC).isoformat(),
            "current_job_ids": [str(value) for value in current_job_ids or []],
            "cpu_usage": 0.0,
            "ram_mb": 0,
            "gpu_usage": None,
            "vram_mb": None,
            "health": "HEALTHY",
        }

    def run(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
        self._emit(stdout, make_message("REGISTER", self.registration_payload()))
        self._emit(stdout, make_message("HEARTBEAT", self.heartbeat_payload()))

        for raw_line in stdin:
            if not raw_line.strip():
                continue
            try:
                message = decode_line(raw_line)
                if not self._handle_message(message, stdout):
                    return 0
            except Exception as exc:
                self._emit_runtime_error(stdout, exc)
        return 0

    def _handle_message(self, message: dict[str, Any], stdout: TextIO) -> bool:
        message_type = message["message_type"]
        if message_type == "SHUTDOWN":
            return False
        if message_type == "HEARTBEAT":
            self._emit(stdout, make_message("HEARTBEAT", self.heartbeat_payload()))
            return True

        job_id = UUID(message["job_id"])
        if message_type == "CANCEL":
            self._cancelled_jobs.add(job_id)
            return True
        if message_type == "PAUSE":
            self._emit(
                stdout,
                make_message(
                    "JOB_RESULT",
                    {
                        "job_id": str(job_id),
                        "protocol_version": PROTOCOL_VERSION,
                        "state": "PAUSED",
                        "outputs": [],
                    },
                    job_id=job_id,
                ),
            )
            return True
        if message_type != "JOB_DISPATCH":
            return True

        payload = message["payload"]
        task_type = payload.get("type")
        if not isinstance(task_type, str) or not task_type:
            self._emit_job_failure(stdout, job_id, "INVALID_JOB", "job payload.type is required")
            return True

        handler = self.handlers.get(task_type)
        if handler is None:
            self._emit_job_failure(
                stdout,
                job_id,
                "UNSUPPORTED_JOB_TYPE",
                f"worker does not support job type {task_type}",
            )
            return True

        def emit_progress(
            progress: float,
            message_code: str,
            metrics: dict[str, Any] | None = None,
        ) -> None:
            self._emit(
                stdout,
                make_message(
                    "PROGRESS",
                    {
                        "job_id": str(job_id),
                        "protocol_version": PROTOCOL_VERSION,
                        "stage": task_type,
                        "progress": max(0.0, min(1.0, progress)),
                        "message_code": message_code,
                        "metrics": metrics or {},
                    },
                    job_id=job_id,
                ),
            )

        context = JobContext(
            worker_id=self.worker_id,
            job_id=job_id,
            emit_progress=emit_progress,
            is_cancelled=lambda: job_id in self._cancelled_jobs,
        )

        try:
            emit_progress(0.0, "JOB_STARTED")
            output = handler(context, payload)
            if context.is_cancelled():
                self._emit_job_failure(stdout, job_id, "CANCELLED", "job was cancelled")
            else:
                emit_progress(1.0, "JOB_COMPLETED")
                self._emit(
                    stdout,
                    make_message(
                        "JOB_RESULT",
                        {
                            "job_id": str(job_id),
                            "protocol_version": PROTOCOL_VERSION,
                            "state": "COMPLETED",
                            "outputs": [output],
                        },
                        job_id=job_id,
                    ),
                )
        except Exception as exc:
            self._emit_job_failure(stdout, job_id, "WORKER_ERROR", str(exc))
        finally:
            self._cancelled_jobs.discard(job_id)
        return True

    def _emit_job_failure(
        self,
        stdout: TextIO,
        job_id: UUID,
        code: str,
        message: str,
    ) -> None:
        self._emit(
            stdout,
            make_message(
                "JOB_RESULT",
                {
                    "job_id": str(job_id),
                    "protocol_version": PROTOCOL_VERSION,
                    "state": "FAILED",
                    "outputs": [],
                    "error": {"code": code, "message": message},
                },
                job_id=job_id,
            ),
        )

    def _emit_runtime_error(self, stdout: TextIO, exc: Exception) -> None:
        error = {
            "code": "WORKER_PROTOCOL_ERROR",
            "message": str(exc),
        }
        if os.environ.get("WORLD888_WORKER_DEBUG") == "1":
            error["traceback"] = traceback.format_exc()
        self._emit(stdout, make_message("HEARTBEAT", {
            **self.heartbeat_payload(),
            "health": "DEGRADED",
            "error": error,
        }))

    @staticmethod
    def _emit(stdout: TextIO, message: dict[str, Any]) -> None:
        stdout.write(encode_line(message))
        stdout.flush()
