# 888

888 是以源码、测试和仓库工程工具为核心维护的智能体运行时仓库。

## 仓库基线

- `packages/`、`apps/`、`python/`、`native/`、`vendor/`：产品与运行时源码。
- 各级 `tests/`、`fixtures/`、`snapshots/`：测试与回归资产。
- `scripts/`、`devtools/`、`.agents/skills/`、`.github/workflows/`：开发、检查、构建和自动化工具。
- `package.json`、`pnpm-workspace.yaml`、锁文件、TypeScript/Vitest/Oxlint 配置：工程定义。

旧项目的文档治理、双语镜像、Agent Note 决策档案和文档站不再属于当前仓库基线。当前行为以源码、测试和实际工程配置为准。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check:all
```

GitHub Actions 使用同一套安装、代码检查、类型检查、测试和构建命令验证提交与拉取请求。
