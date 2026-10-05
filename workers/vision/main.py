from __future__ import annotations

from typing import Any

from workers.sdk.runtime import JobContext, WorkerApp


def healthcheck(context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
    context.emit_progress(0.5, "VISION_RUNTIME_READY")
    return {
        "kind": "vision-runtime",
        "status": "ok",
        "requested_parameters": payload.get("parameters", {}),
    }


def build_app() -> WorkerApp:
    return WorkerApp(
        worker_type="VISION",
        capabilities=["HEALTHCHECK"],
        handlers={"HEALTHCHECK": healthcheck},
    )


def main() -> int:
    return build_app().run()


if __name__ == "__main__":
    raise SystemExit(main())
