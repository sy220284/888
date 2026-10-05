from __future__ import annotations

import io
import json
import time
import unittest
from uuid import uuid4

from workers.sdk.protocol import decode_line, encode_line, make_message
from workers.sdk.runtime import JobContext, WorkerApp


class WorkerProtocolTests(unittest.TestCase):
    def test_round_trip_and_binary_guard(self) -> None:
        job_id = uuid4()
        message = make_message("PROGRESS", {"progress": 0.5}, job_id=job_id)
        self.assertEqual(decode_line(encode_line(message)), message)

        with self.assertRaises(ValueError):
            make_message(
                "JOB_RESULT",
                {"image": "data:image/png;base64,AAAA"},
                job_id=job_id,
            )

    def test_worker_dispatches_job_and_emits_result(self) -> None:
        job_id = uuid4()

        def handler(context: JobContext, payload: dict[str, object]) -> dict[str, object]:
            context.emit_progress(0.5, "HALFWAY")
            return {"ok": True, "echo": payload.get("parameters")}

        app = WorkerApp(
            worker_type="VISION",
            capabilities=["HEALTHCHECK"],
            handlers={"HEALTHCHECK": handler},
            worker_id=uuid4(),
        )
        dispatch = make_message(
            "JOB_DISPATCH",
            {
                "job_id": str(job_id),
                "protocol_version": 1,
                "type": "HEALTHCHECK",
                "input_refs": [],
                "parameters": {"value": 1},
                "artifact_ids": [],
            },
            job_id=job_id,
        )
        stdin = io.StringIO(encode_line(dispatch))
        stdout = io.StringIO()

        self.assertEqual(app.run(stdin, stdout), 0)
        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        result = [item for item in messages if item["message_type"] == "JOB_RESULT"][-1]
        self.assertEqual(result["payload"]["state"], "COMPLETED")
        self.assertTrue(result["payload"]["outputs"][0]["ok"])

    def test_worker_accepts_cancel_while_job_is_running(self) -> None:
        job_id = uuid4()

        def handler(context: JobContext, payload: dict[str, object]) -> dict[str, object]:
            del payload
            for _ in range(200):
                if context.is_cancelled():
                    return {"cancel_seen": True}
                time.sleep(0.001)
            return {"cancel_seen": False}

        app = WorkerApp(
            worker_type="VISION",
            capabilities=["LONG_JOB"],
            handlers={"LONG_JOB": handler},
            worker_id=uuid4(),
        )
        dispatch = make_message(
            "JOB_DISPATCH",
            {
                "job_id": str(job_id),
                "protocol_version": 1,
                "type": "LONG_JOB",
                "input_refs": [],
                "parameters": {},
                "artifact_ids": [],
            },
            job_id=job_id,
        )
        cancel = make_message("CANCEL", {}, job_id=job_id)
        stdout = io.StringIO()

        self.assertEqual(
            app.run(io.StringIO(encode_line(dispatch) + encode_line(cancel)), stdout),
            0,
        )
        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        result = [item for item in messages if item["message_type"] == "JOB_RESULT"][-1]
        self.assertEqual(result["payload"]["state"], "FAILED")
        self.assertEqual(result["payload"]["error"]["code"], "CANCELLED")

    def test_worker_accepts_pause_while_job_is_running(self) -> None:
        job_id = uuid4()

        def handler(context: JobContext, payload: dict[str, object]) -> dict[str, object]:
            del payload
            for _ in range(200):
                if context.is_pause_requested():
                    return {"checkpoint_artifact_id": str(uuid4())}
                time.sleep(0.001)
            return {}

        app = WorkerApp(
            worker_type="VISION",
            capabilities=["CHECKPOINT_JOB"],
            handlers={"CHECKPOINT_JOB": handler},
            worker_id=uuid4(),
        )
        dispatch = make_message(
            "JOB_DISPATCH",
            {
                "job_id": str(job_id),
                "protocol_version": 1,
                "type": "CHECKPOINT_JOB",
                "input_refs": [],
                "parameters": {},
                "artifact_ids": [],
            },
            job_id=job_id,
        )
        pause = make_message("PAUSE", {}, job_id=job_id)
        stdout = io.StringIO()

        self.assertEqual(
            app.run(io.StringIO(encode_line(dispatch) + encode_line(pause)), stdout),
            0,
        )
        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        result = [item for item in messages if item["message_type"] == "JOB_RESULT"][-1]
        self.assertEqual(result["payload"]["state"], "PAUSED")
        self.assertIn("checkpoint_artifact_id", result["payload"]["outputs"][0])


if __name__ == "__main__":
    unittest.main()
