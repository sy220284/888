set shell := ["bash", "-cu"]

architecture-check:
    python tools/check_architecture.py

schema-generate:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py

schema-check:
    python tools/validate_schemas.py
    python tools/generate_schema_types.py --check

check: architecture-check schema-check
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

test-fast: architecture-check schema-check
    python -m compileall -q workers/sdk
    cargo test --workspace

test: check test-fast
