from __future__ import annotations

import os
import platform
import sys
import threading
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
    is_pause_requested: Callable[[], bool]


@dataclass(slots=True)
class _JobExecution:
    cancel_event: threading.Event
    pause_event: threading.Event
    thread: threading.Thread | None = None


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
        self._active_jobs: dict[UUID, _JobExecution] = {}
        self._state_lock = threading.RLock()
        self._output_lock = threading.Lock()

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
        if current_job_ids is None:
            with self._state_lock:
                current_job_ids = list(self._active_jobs)
        return {
            "worker_id": str(self.worker_id),
            "protocol_version": PROTOCOL_VERSION,
            "timestamp": datetime.now(UTC).isoformat(),
            "current_job_ids": [str(value) for value in current_job_ids],
            "cpu_usage": 0.0,
            "ram_mb": 0,
            "gpu_usage": None,
            "vram_mb": None,
            "health": "HEALTHY",
        }

    def run(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
        self._emit(stdout, make_message("REGISTER", self.registration_payload()))
        self._emit(stdout, make_message("HEARTBEAT", self.heartbeat_payload()))
        heartbeat_stop = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(stdout, heartbeat_stop),
            name=f"888-heartbeat-{self.worker_id}",
            daemon=True,
        )
        heartbeat_thread.start()

        try:
            for raw_line in stdin:
                if not raw_line.strip():
                    continue
                try:
                    message = decode_line(raw_line)
                    if not self._handle_message(message, stdout):
                        self._request_cancel_all()
                        return 0
                except Exception as exc:
                    self._emit_runtime_error(stdout, exc)
            return 0
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1.0)
            self._join_active()

    def _heartbeat_loop(self, stdout: TextIO, stop: threading.Event) -> None:
        raw_interval = os.environ.get("WORLD888_HEARTBEAT_INTERVAL_SECONDS", "5")
        try:
            interval = max(1.0, float(raw_interval))
        except ValueError:
            interval = 5.0
        while not stop.wait(interval):
            self._emit(stdout, make_message("HEARTBEAT", self.heartbeat_payload()))

    def _handle_message(self, message: dict[str, Any], stdout: TextIO) -> bool:
        message_type = message["message_type"]
        if message_type == "SHUTDOWN":
            return False
        if message_type == "HEARTBEAT":
            self._emit(stdout, make_message("HEARTBEAT", self.heartbeat_payload()))
            return True

        if message_type not in {"JOB_DISPATCH", "PAUSE", "CANCEL"}:
            raise ValueError(f"unexpected inbound worker message: {message_type}")

        job_id = UUID(message["job_id"])
        if message_type == "CANCEL":
            execution = self._execution(job_id)
            if execution is not None:
                execution.cancel_event.set()
            return True
        if message_type == "PAUSE":
            execution = self._execution(job_id)
            if execution is not None:
                execution.pause_event.set()
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

        execution = _JobExecution(
            cancel_event=threading.Event(),
            pause_event=threading.Event(),
        )
        with self._state_lock:
            if job_id in self._active_jobs:
                self._emit_job_failure(
                    stdout,
                    job_id,
                    "DUPLICATE_JOB",
                    "job is already running on this worker",
                )
                return True
            self._active_jobs[job_id] = execution

        thread = threading.Thread(
            target=self._run_job,
            args=(stdout, job_id, task_type, payload, handler, execution),
            name=f"888-worker-{job_id}",
            daemon=False,
        )
        execution.thread = thread
        thread.start()
        return True

    def _run_job(
        self,
        stdout: TextIO,
        job_id: UUID,
        task_type: str,
        payload: dict[str, Any],
        handler: Handler,
        execution: _JobExecution,
    ) -> None:
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
            is_cancelled=execution.cancel_event.is_set,
            is_pause_requested=execution.pause_event.is_set,
        )

        try:
            emit_progress(0.0, "JOB_STARTED")
            output = handler(context, payload)
            if context.is_cancelled():
                self._emit_job_failure(stdout, job_id, "CANCELLED", "job was cancelled")
            elif context.is_pause_requested():
                self._emit(
                    stdout,
                    make_message(
                        "JOB_RESULT",
                        {
                            "job_id": str(job_id),
                            "protocol_version": PROTOCOL_VERSION,
                            "state": "PAUSED",
                            "outputs": [output] if output else [],
                        },
                        job_id=job_id,
                    ),
                )
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
            with self._state_lock:
                self._active_jobs.pop(job_id, None)

    def _execution(self, job_id: UUID) -> _JobExecution | None:
        with self._state_lock:
            return self._active_jobs.get(job_id)

    def _request_cancel_all(self) -> None:
        with self._state_lock:
            executions = list(self._active_jobs.values())
        for execution in executions:
            execution.cancel_event.set()

    def _join_active(self) -> None:
        while True:
            with self._state_lock:
                threads = [
                    execution.thread
                    for execution in self._active_jobs.values()
                    if execution.thread is not None
                ]
            if not threads:
                return
            for thread in threads:
                thread.join()

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
        self._emit(
            stdout,
            make_message(
                "HEARTBEAT",
                {
                    **self.heartbeat_payload(),
                    "health": "DEGRADED",
                    "error": error,
                },
            ),
        )

    def _emit(self, stdout: TextIO, message: dict[str, Any]) -> None:
        with self._output_lock:
            stdout.write(encode_line(message))
            stdout.flush()
