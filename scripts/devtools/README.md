# Development environment scripts

`dev.mjs` is the post-bootstrap command router. `bootstrap.sh` and `bootstrap.ps1` are intentionally dependency-light and can install the pinned Node toolchain before Node is available. The root `dev` / `dev.ps1` entrypoints delegate here.

The bootstrap layer owns tool acquisition and checksum verification. Project dependency installation stays with pnpm, Cargo, and uv using committed lock files. Project quality checks stay with the existing gate runner plus the Rust gate scripts exposed from the root package manifest.
