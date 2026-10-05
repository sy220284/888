set shell := ["bash", "-cu"]

check:
    python tools/validate_schemas.py
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

test-fast:
    python tools/validate_schemas.py
    cargo test --workspace

test: check test-fast
