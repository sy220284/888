# Harness 2.0 development environment layer

This directory owns local development tools, formatters, dependency locks, and environment profiles. The repository does not restore the removed legacy gates or Git hooks; GitHub Actions is limited to the project-tools/dependency-artifact workflow.

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
./dev format
./dev format --check
```

Windows PowerShell:

```powershell
.\dev.ps1 setup test
.\dev.ps1 doctor --profile test
.\dev.ps1 format
.\dev.ps1 format --check
```

## Profiles

- `minimal`: Git + Node + pnpm + Prettier + npm workspace dependencies.
- `test`: minimal plus Rust/rustfmt/clippy/Cargo + shfmt + Taplo for core development and testing.
- `native`: test plus the platform-native build chain.
- `python`: minimal plus Python + uv + Ruff.
- `full`: native + python + optional PowerShell for repository-wide maintenance and release preparation.

## Formatting ownership

- TypeScript/TSX/JavaScript: Oxlint and the existing style rules remain authoritative; Prettier does not own these files.
- Markdown/MDX/JSON/YAML/CSS/HTML: Prettier.
- Rust: rustfmt.
- Python: Ruff formatter.
- Shell: shfmt.
- TOML: Taplo.

`./dev format` writes formatting changes; `./dev format --check` checks without writing. Use `--only prettier,python,shell,toml,rust` to limit scopes. The repository does not install an automatic pre-commit hook; formatting is run explicitly by developers or validation commands.

The root formatter skips `vendor/`, `native/landlock-run/`, `.agents/notes/`, generated directories, and dependency lock files so upstream code, historical design records, symlinks, generated output, and lock files keep their own ownership.

## Project-tools workflow

`.github/workflows/project-tools.yml` is the GitHub Actions workflow retained by this tooling layer. It:

- validates tool declarations, download policy, Shell entry points, and Actions syntax;
- builds developer-tool bundles for Linux x64, macOS ARM64, and Windows x64;
- can manually generate lock-resolved pnpm, Cargo, and uv dependency caches;
- can manually run the selected `test` or `full` development checks.

The portable tools bundle pins:

- `rg` (ripgrep) for fast text search;
- `fd` for fast file discovery;
- `cargo-nextest` for Rust test execution;
- `actionlint` for GitHub Actions validation.

ShellCheck runs at a pinned version with SHA-256 verification but is not redistributed in the cross-platform tools bundle.

Artifact names:

- `dsh-project-tools-<os>-<arch>`: executables plus `bundle.json` and `SHA256SUMS.txt`.
- `dsh-project-dependencies-<profile>-<os>-<arch>`: optional pnpm/Cargo/uv dependency caches.

Dependency caches can be used for offline or constrained-network restoration:

```bash
pnpm install --offline --frozen-lockfile --store-dir /path/to/dependency-cache/pnpm
CARGO_HOME=/path/to/dependency-cache/cargo cargo fetch --offline --locked --manifest-path native/execution-core/Cargo.toml
UV_CACHE_DIR=/path/to/dependency-cache/uv uv sync --offline --frozen --project python/sdk --group test
```

## Sources of truth

- Node/pnpm: `package.json`
- Rust: `rust-toolchain.toml`
- JavaScript dependencies: `pnpm-lock.yaml`
- Rust dependencies: `native/execution-core/Cargo.lock`
- Python dependencies: `python/sdk/uv.lock`
- Profile composition: `devtools/profiles.json`
- Tool and formatter versions: `devtools/manifest.json`
- Project development/test utilities: `devtools/project-tools.json`
- Redistributable-tool checksums: `devtools/checksums.json`

## Security constraints

- Never execute an unverified remote binary.
- Explicit validation fails when tool versions drift from authoritative declarations.
- Rust uses `--locked`.
- npm workspace installation uses `--frozen-lockfile`.
- Python uses `uv sync --frozen`.
- Actions artifacts carry SHA-256 manifests; dependency-cache artifacts preserve hidden metadata required for restoration.
