# Development environment scripts

English | [中文](README.zh.md)

`dev.mjs` is the shared command router after Node becomes available. `bootstrap.sh` and `bootstrap.ps1` stay dependency-light: they download and verify the pinned Node version when Node is unavailable, then enter the shared command layer.

The bootstrap layer owns development-tool acquisition and digest verification. pnpm, Cargo, and uv continue to install project dependencies from committed lockfiles. `run-checks`, the Rust checks, and the Python checks provide explicitly requested project validation.
