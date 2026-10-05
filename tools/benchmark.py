#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import platform
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TESTDATA = ROOT / "testdata"
REQUIRED_MANIFEST_KEYS = {
    "fixture_id",
    "version",
    "category",
    "source",
    "license",
    "observation_count",
    "expected_capabilities",
    "ground_truth_available",
    "required_gpu",
    "notes",
}


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.isdigit():
        return int(value)
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip("'\"") for item in inner.split(",")]
    return value.strip("'\"")


def load_manifest(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            raise ValueError(f"{path}: invalid manifest line: {line!r}")
        key, value = stripped.split(":", 1)
        data[key.strip()] = parse_scalar(value)
    missing = REQUIRED_MANIFEST_KEYS - data.keys()
    if missing:
        raise ValueError(f"{path}: missing keys: {sorted(missing)}")
    return data


def git_commit() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def validate_fixture(path: Path) -> dict[str, Any]:
    manifest_path = path / "manifest.yaml"
    if not manifest_path.is_file():
        raise ValueError(f"{path}: missing manifest.yaml")
    for required in ("observations", "ground_truth", "expected"):
        if not (path / required).is_dir():
            raise ValueError(f"{path}: missing {required}/")

    manifest = load_manifest(manifest_path)
    observation_files = [
        item
        for item in (path / "observations").iterdir()
        if item.is_file() and item.name != ".gitkeep"
    ]
    if len(observation_files) != manifest["observation_count"]:
        raise ValueError(
            f"{path}: observation_count={manifest['observation_count']} "
            f"but found {len(observation_files)} files"
        )

    return {
        "fixture_id": manifest["fixture_id"],
        "fixture_version": manifest["version"],
        "commit": git_commit(),
        "device_profile": platform.machine() or "unknown",
        "metrics": {
            "observation_count": len(observation_files),
            "ground_truth_available": manifest["ground_truth_available"],
            "required_gpu": manifest["required_gpu"],
            "infrastructure_valid": True,
        },
    }


def fixture_paths(name: str | None) -> list[Path]:
    if name:
        path = TESTDATA / name
        if not path.is_dir():
            raise ValueError(f"fixture does not exist: {name}")
        return [path]
    return sorted(
        path
        for path in TESTDATA.iterdir()
        if path.is_dir() and (path / "manifest.yaml").is_file()
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", nargs="?")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    results = [validate_fixture(path) for path in fixture_paths(args.fixture)]
    if args.verify_only:
        print(f"Fixture 校验通过：{len(results)} 个")
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
