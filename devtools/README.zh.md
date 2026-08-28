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
```

Windows PowerShell：

```powershell
.\dev.ps1 setup test
.\dev.ps1 doctor --profile test
```

## 组合包

- `minimal`：Git + Node + pnpm + npm 工作区依赖；用于普通 TypeScript 开发。
- `test`：在 minimal 上增加 Rust/rustfmt/clippy/Cargo；用于 Harness 2.0 核心完整检查。
- `native`：在 test 上增加平台原生编译链；用于 `native/execution-core`、PTY、沙箱等开发。
- `python`：在 minimal 上增加 Python + uv；用于 Python SDK。
- `full`：native + python + 可选 PowerShell；用于全仓维护和发布准备。

## 事实源

- Node/pnpm：`package.json`
- Rust：`rust-toolchain.toml`
- JavaScript 依赖：`pnpm-lock.yaml`
- Rust 依赖：`native/execution-core/Cargo.lock`
- Python 依赖：`python/sdk/uv.lock`
- 组合关系：`devtools/profiles.json`
- 聚合工具清单：`devtools/manifest.json`

`manifest.json` 是聚合视图，不允许独立漂移。`devtools-verify` 会检查它与上述权威声明是否一致。

## 下载与离线包

`dev download <profile>` 用于准备指定组合所需的可再分发工具缓存。公开下载必须来自官方来源并通过 SHA-256 校验。工作流生成的离线包附带 `SHA256SUMS.txt`。许可证不允许再分发的工具只记录官方下载安装元数据，不进入公开离线包。

## 安全约束

- 禁止未校验的远程二进制直接执行。
- 锁文件缺失或与声明漂移时，持续集成必须失败。
- Rust 构建必须使用 `--locked`。
- npm 安装必须使用 `--frozen-lockfile`。
- Python 安装必须使用 `uv sync --frozen`。
