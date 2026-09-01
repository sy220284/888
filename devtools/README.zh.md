# Harness 2.0 开发环境工具层

本目录统一管理本地开发工具、格式化器、依赖锁和环境组合。仓库不恢复旧门禁与提交钩子；GitHub Actions 仅保留项目工具/依赖产物工作流。

## 快速入口

Linux/macOS：

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

Windows PowerShell：

```powershell
.\dev.ps1 setup test
.\dev.ps1 doctor --profile test
.\dev.ps1 format
.\dev.ps1 format --check
```

## 环境组合

- `minimal`：Git + Node + pnpm + Prettier + npm 工作区依赖。
- `test`：在 minimal 上增加 Rust/rustfmt/clippy/Cargo + shfmt + Taplo，用于核心开发与测试。
- `native`：在 test 上增加平台原生编译链。
- `python`：在 minimal 上增加 Python + uv + Ruff。
- `full`：native + python + 可选 PowerShell，用于全仓维护与发布准备。

## 格式化分工

- TypeScript/TSX/JavaScript：继续由 Oxlint 与现有样式规则处理；Prettier 不接管。
- Markdown/MDX/JSON/YAML/CSS/HTML：Prettier。
- Rust：rustfmt。
- Python：Ruff formatter。
- Shell：shfmt。
- TOML：Taplo。

`./dev format` 写入格式化结果；`./dev format --check` 只检查。可用 `--only prettier,python,shell,toml,rust` 限定范围。仓库不自动安装提交钩子，是否执行格式化由开发者或显式检查命令决定。

默认跳过 `vendor/`、`native/landlock-run/`、归档 Agent Notes、生成目录和依赖锁文件，避免改写上游代码、生成物及锁文件。

## 项目工具工作流

`.github/workflows/project-tools.yml` 是本工具层保留的 GitHub Actions 工作流。它负责：

- 校验工具声明、下载策略、Shell 脚本与 Actions 工作流。
- 在 Linux x64、macOS ARM64、Windows x64 构建开发工具包。
- 手动运行时按需生成 pnpm、Cargo、uv 锁定依赖缓存。
- 手动运行时可选择执行 `test` 或 `full` 开发检查。

开发工具包固定包含：

- `rg`（ripgrep）：高速文本搜索。
- `fd`：高速文件发现。
- `cargo-nextest`：Rust 测试执行器。
- `actionlint`：GitHub Actions 静态校验。

ShellCheck 使用固定版本和 SHA-256 校验执行工作流检查，但不进入跨平台工具包。

产物命名：

- `dsh-project-tools-<os>-<arch>`：可执行工具 + `bundle.json` + `SHA256SUMS.txt`。
- `dsh-project-dependencies-<profile>-<os>-<arch>`：按需生成的 pnpm/Cargo/uv 依赖缓存。

依赖缓存可用于离线或弱网恢复：

```bash
pnpm install --offline --frozen-lockfile --store-dir /path/to/dependency-cache/pnpm
CARGO_HOME=/path/to/dependency-cache/cargo cargo fetch --offline --locked --manifest-path native/execution-core/Cargo.toml
UV_CACHE_DIR=/path/to/dependency-cache/uv uv sync --offline --frozen --project python/sdk --group test
```

## 事实源

- Node/pnpm：`package.json`
- Rust：`rust-toolchain.toml`
- JavaScript 依赖：`pnpm-lock.yaml`
- Rust 依赖：`native/execution-core/Cargo.lock`
- Python 依赖：`python/sdk/uv.lock`
- 环境组合：`devtools/profiles.json`
- 工具与格式化器版本：`devtools/manifest.json`
- 项目开发/测试工具：`devtools/project-tools.json`
- 可再分发工具校验值：`devtools/checksums.json`

## 安全约束

- 禁止执行未校验的远程二进制。
- 工具版本与权威声明漂移时显式校验必须失败。
- Rust 使用 `--locked`。
- npm 工作区使用 `--frozen-lockfile`。
- Python 使用 `uv sync --frozen`。
- Actions 产物附带 SHA-256 清单；依赖缓存保留恢复所需隐藏元数据。
