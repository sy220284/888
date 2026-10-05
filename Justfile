set shell := ["bash", "-cu"]

setup:
    command -v pnpm >/dev/null
    command -v cargo >/dev/null
    command -v uv >/dev/null
    pnpm install --no-frozen-lockfile
    cargo fetch
    uv python find >/dev/null

architecture-check:
    python tools/check_architecture.py

schema-generate:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py

schema-check:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py --check

python-check:
    python -m compileall -q workers tools tests/python
    python -m unittest discover -s tests/python

fixture-check:
    python tools/benchmark.py --verify-only

check: architecture-check schema-check python-check fixture-check
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

test-fast: architecture-check schema-check python-check fixture-check
    cargo test --workspace

test: check test-fast

test-world:
    python tools/benchmark.py smoke-empty --verify-only

benchmark fixture="":
    if [ -n "{{fixture}}" ]; then python tools/benchmark.py "{{fixture}}"; else python tools/benchmark.py; fi
