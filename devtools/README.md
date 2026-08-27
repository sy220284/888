# Harness 2.0 development environment layer

This directory defines the reproducible development-tool, dependency-lock, and environment-profile layer shared by local development, CI, and release preparation.

## Entry points

Unix:

```bash
./dev setup minimal
./dev setup test
./dev setup native
./dev setup python
./dev setup full
./dev doctor --profile test
./dev deps verify
./dev check
```

Windows PowerShell:

```powershell
.\dev.ps1 setup test
.\dev.ps1 doctor --profile test
```

Profiles are declared in `profiles.json`. Tool versions are aggregated in `manifest.json`, while authoritative versions remain in `package.json`, `rust-toolchain.toml`, and `python/sdk/pyproject.toml`. Dependency reproducibility is owned by `pnpm-lock.yaml`, `native/execution-core/Cargo.lock`, and `python/sdk/uv.lock`.

Downloads must come from official sources and be verified with SHA-256. Release-generated offline bundles include `SHA256SUMS.txt`; tools whose licenses do not permit redistribution are represented by verified installer metadata rather than repackaged binaries.
