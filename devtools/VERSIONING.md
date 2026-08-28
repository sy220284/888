# Development tool versioning

Tool versions change only in focused infrastructure changes. A tool bump must update its authoritative declaration first, then `devtools/manifest.json`, regenerate affected locks, and pass clean-environment smoke tests.

Do not combine broad dependency upgrades with Harness runtime behavior changes. Node/pnpm, Rust, and uv upgrades should be reviewed independently so failures can be attributed to either toolchain drift or application code changes.
