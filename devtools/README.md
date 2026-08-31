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

- `minimal`: Git + Node + pnpm + Prettier + npm workspace dependencies for ordinary TypeScript and documentation/configuration development.
- `test`: extends minimal with Rust/rustfmt/clippy/Cargo + shfmt + Taplo for the complete Harness 2.0 core check environment.
- `native`: extends test with the platform-native build chain for `native/execution-core`, PTY, sandbox, and related native work.
- `python`: extends minimal with Python + uv + Ruff for the Python SDK.
- `full`: native + python + optional PowerShell for repository-wide maintenance, formatting, testing, and release preparation.

## Project-tools workflow

`.github/workflows/project-tools.yml` builds standalone project-tool and dependency artifacts. Formatters remain owned by `devtools/manifest.json`; high-frequency development and test utilities live in `devtools/project-tools.json` so development-only tools do not enter the application runtime dependency graph.

The tools artifact currently pins:

- `rg` (ripgrep) for fast repository search.
- `fd` for fast file discovery.
- `cargo-nextest` for Rust test execution.
- `actionlint` for GitHub Actions workflow validation.
- ShellCheck is used by workflow validation but is not redistributed in the cross-platform tools bundle.

The workflow supports `test` and `full` profiles and splits artifacts by operating system and architecture:

- `dsh-project-tools-<os>-<arch>` contains ready-to-use developer utilities plus `bundle.json` and `SHA256SUMS.txt`.
- `dsh-project-dependencies-<profile>-<os>-<arch>` optionally contains lock-resolved pnpm and Cargo caches; `full` also includes the uv cache.

Changes to the project-tool definition on this branch automatically build the smaller tools artifact. Large dependency-cache artifacts are generated only by manually dispatching the workflow with `include_dependencies=yes`.

After downloading a dependency-cache artifact, it can be used for offline or constrained-network restoration:

```bash
pnpm install --offline --frozen-lockfile --store-dir /path/to/dependency-cache/pnpm
CARGO_HOME=/path/to/dependency-cache/cargo cargo fetch --offline --locked --manifest-path native/execution-core/Cargo.toml
UV_CACHE_DIR=/path/to/dependency-cache/uv uv sync --offline --frozen --project python/sdk --group test
```

On Windows, set `$env:CARGO_HOME` and `$env:UV_CACHE_DIR` in PowerShell; the pnpm arguments are unchanged.

## Formatting ownership

The repository uses language-specific formatters instead of making one formatter own every source language:

- TypeScript/TSX/JavaScript: Oxlint and the existing Stylistic rules continue to own style fixes; Prettier does not own these files.
- Markdown/MDX/JSON/YAML/CSS/HTML: Prettier.
- Rust: rustfmt.
- Python: Ruff formatter.
- Shell: shfmt.
- TOML: Taplo.

`./dev format` formats managed tracked files; `./dev format --check` checks without writing. Use `--only prettier,python,shell,toml,rust` to limit the scopes. Pre-commit hooks format only supported staged files so the toolchain can be adopted without a repository-wide legacy formatting rewrite.

The root formatter excludes `vendor/`, `native/landlock-run/`, archived Agent Notes, generated directories, and dependency lock files. Those paths remain owned by their upstream sources, generators, or lockfile tools.

## Sources of truth

- Node/pnpm: `package.json`
- Rust: `rust-toolchain.toml`
- JavaScript dependencies: `pnpm-lock.yaml`
- Rust dependencies: `native/execution-core/Cargo.lock`
- Python dependencies: `python/sdk/uv.lock`
- Profile composition: `devtools/profiles.json`
- Aggregated tools and formatter versions: `devtools/manifest.json`
- Project development/test utility versions: `devtools/project-tools.json`
- Redistributable-tool checksums: `devtools/checksums.json`

`manifest.json` is an aggregate view and must not drift independently. Development-tool declaration checks validate it against the authoritative declarations and the download-verification policy.

## Downloads and offline bundles

`dev download <profile>` prepares the redistributable tool cache for a profile. Public downloads must come from official sources and pass SHA-256 verification. Workflow-generated offline bundles include `SHA256SUMS.txt`; tools whose licenses do not permit redistribution are represented by verified installer metadata rather than repackaged binaries.

shfmt uses official GitHub Release binaries with platform-specific pinned SHA-256 digests. Taplo is installed through Cargo at a pinned version, Ruff through uv's pinned tool environment, and Prettier into the repository-ignored `.devtools/` local tool directory rather than the runtime dependency graph.

## Security constraints

- Never execute an unverified remote binary.
- Missing or drifting dependency locks must fail CI.
- Rust builds use `--locked`.
- npm workspace installation uses `--frozen-lockfile`.
- Python project installation uses `uv sync --frozen`.
- Generated project-tool bundles include SHA-256 manifests for independent verification after download.
- Formatter versions are pinned so different developer machines produce the same formatting behavior.
