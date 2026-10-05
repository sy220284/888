#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = ROOT / "packages" / "schema"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def main() -> None:
    files = sorted(SCHEMA_ROOT.rglob("*.schema.json"))
    if not files:
        raise SystemExit("没有找到 Schema 文件")

    ids: set[str] = set()
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("$schema") != DRAFT:
            raise SystemExit(f"{path}: $schema 必须是 Draft 2020-12")
        schema_id = data.get("$id")
        if not isinstance(schema_id, str) or not schema_id:
            raise SystemExit(f"{path}: 缺少 $id")
        if schema_id in ids:
            raise SystemExit(f"{path}: 重复 $id {schema_id}")
        ids.add(schema_id)
        if not data.get("title"):
            raise SystemExit(f"{path}: 缺少 title")

    print(f"Schema 基础校验通过：{len(files)} 个文件")


if __name__ == "__main__":
    main()
