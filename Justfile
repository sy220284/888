set shell := ["bash", "-cu"]

schema-generate:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py

schema-check:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py --check

check: schema-check
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

test-fast: schema-check
    python -m compileall -q workers/sdk
    cargo test --workspace

test: check test-fast
