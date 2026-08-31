# Harness 2.0 开发环境工具层

本目录定义项目开发工具、依赖锁与环境组合包。目标是让本地开发、持续集成与发布环境走同一套入口，避免“某台机器能跑、另一台机器不能跑”。

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

## 组合包

- `minimal`：Git + Node + pnpm + Prettier + npm 工作区依赖；用于普通 TypeScript 与文档/配置开发。
- `test`：在 minimal 上增加 Rust/rustfmt/clippy/Cargo + shfmt + Taplo；用于 Harness 2.0 核心完整检查。
- `native`：在 test 上增加平台原生编译链；用于 `native/execution-core`、PTY、沙箱等开发。
- `python`：在 minimal 上增加 Python + uv + Ruff；用于 Python SDK。
- `full`：native + python + 可选 PowerShell；用于全仓维护、格式化、测试和发布准备。

## 项目工具工作流

`.github/workflows/project-tools.yml` 提供独立的项目工具与依赖产物。格式化工具继续由 `devtools/manifest.json` 管理；高频开发/测试辅助工具放在 `devtools/project-tools.json`，避免把仅供开发者使用的工具塞进应用运行时依赖。

当前工具包固定包含：

- `rg`（ripgrep）：全仓高速搜索。
- `fd`：高速文件发现。
- `cargo-nextest`：Rust 测试执行器。
- `actionlint`：GitHub Actions 工作流静态校验。
- ShellCheck：在工作流中检查 Shell 脚本；不作为跨平台公开工具包的一部分。

工作流支持 `test` / `full` 两种环境，产物按操作系统与架构拆分：

- `dsh-project-tools-<os>-<arch>`：可直接解压到本地工具目录并加入 `PATH` 的开发工具包，附 `bundle.json` 与 `SHA256SUMS.txt`。
- `dsh-project-dependencies-<profile>-<os>-<arch>`：可选的锁定依赖缓存，包含 pnpm、Cargo；`full` 额外包含 uv 缓存。

分支上的项目工具定义变更会自动构建工具包；大体积依赖缓存只在手动运行工作流并选择 `include_dependencies=yes` 时生成，避免每次提交重复上传大产物。

下载依赖缓存后可按需离线/弱网恢复：

```bash
pnpm install --offline --frozen-lockfile --store-dir /path/to/dependency-cache/pnpm
CARGO_HOME=/path/to/dependency-cache/cargo cargo fetch --offline --locked --manifest-path native/execution-core/Cargo.toml
UV_CACHE_DIR=/path/to/dependency-cache/uv uv sync --offline --frozen --project python/sdk --group test
```

Windows 对应使用 PowerShell 设置 `$env:CARGO_HOME` / `$env:UV_CACHE_DIR`，pnpm 参数保持一致。

## 格式化分工

仓库按语言使用专用工具，不用单个格式化器强行接管所有源码：

- TypeScript/TSX/JavaScript：继续由 Oxlint 与现有 Stylistic 规则负责样式修复；Prettier 不接管这些文件。
- Markdown/MDX/JSON/YAML/CSS/HTML：Prettier。
- Rust：rustfmt。
- Python：Ruff formatter。
- Shell：shfmt。
- TOML：Taplo。

`./dev format` 格式化当前仓库受管理文件；`./dev format --check` 只检查，不写入。也可以用 `--only prettier,python,shell,toml,rust` 缩小范围。提交钩子只格式化本次暂存的受支持文件，避免一次性重写历史文件形成大面积无关差异。

根格式化流程不改写 `vendor/`、`native/landlock-run/`、归档 Agent Notes、生成目录和依赖锁文件；这些目录或文件由各自上游、生成器或锁文件工具负责。

## 事实源

- Node/pnpm：`package.json`
- Rust：`rust-toolchain.toml`
- JavaScript 依赖：`pnpm-lock.yaml`
- Rust 依赖：`native/execution-core/Cargo.lock`
- Python 依赖：`python/sdk/uv.lock`
- 组合关系：`devtools/profiles.json`
- 聚合工具与格式化器版本：`devtools/manifest.json`
- 项目开发/测试辅助工具版本：`devtools/project-tools.json`
- 可再分发工具校验值：`devtools/checksums.json`

`manifest.json` 是聚合视图，不允许独立漂移。开发工具声明检查会验证它与权威声明及下载校验策略保持一致。

## 下载与离线包

`dev download <profile>` 用于准备指定组合所需的可再分发工具缓存。公开下载必须来自官方来源并通过 SHA-256 校验。工作流生成的离线包附带 `SHA256SUMS.txt`。许可证不允许再分发的工具只记录官方下载安装元数据，不进入公开离线包。

shfmt 使用官方 GitHub Release 二进制并按平台校验固定 SHA-256；Taplo 通过锁定版本的 Cargo 安装；Ruff 通过锁定版本的 uv 工具环境安装；Prettier 安装到仓库忽略的 `.devtools/` 本地工具目录，不进入运行时依赖图。

## 安全约束

- 禁止未校验的远程二进制直接执行。
- 锁文件缺失或与声明漂移时，持续集成必须失败。
- Rust 构建必须使用 `--locked`。
- npm 工作区安装必须使用 `--frozen-lockfile`。
- Python 项目安装必须使用 `uv sync --frozen`。
- 项目工具包生成后写入 SHA-256 清单，下载后可独立复核。
- 格式化工具固定版本，避免开发机之间产生格式差异。
