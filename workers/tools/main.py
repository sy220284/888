from __future__ import annotations

import shutil
from typing import Any

from workers.sdk.runtime import JobContext, WorkerApp

TOOLS = ("ffmpeg", "ffprobe", "blender", "colmap")


def discover_tools(context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
    found: dict[str, str | None] = {}
    for index, tool in enumerate(TOOLS, start=1):
        if context.is_cancelled():
            break
        found[tool] = shutil.which(tool)
        context.emit_progress(index / len(TOOLS), "TOOL_DISCOVERY", {"tool": tool})
    return {
        "kind": "tool-discovery",
        "tools": found,
        "requested_parameters": payload.get("parameters", {}),
    }


def build_app() -> WorkerApp:
    return WorkerApp(
        worker_type="TOOL",
        capabilities=["DISCOVER_TOOLS"],
        handlers={"DISCOVER_TOOLS": discover_tools},
    )


def main() -> int:
    return build_app().run()


if __name__ == "__main__":
    raise SystemExit(main())
