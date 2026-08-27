# Harness 2.0 Local Upgrade Status

工作副本：本目录。

原始输入：`deepseek-harness-master.zip`，保持不修改。

## 当前阶段

P0：架构宪法与模型请求冻结边界。

## 本轮已落地

- `scripts/print-clean-code-tree.mjs`：可重复生成干净源码树；
- `docs/HARNESS-2.0-CLEAN-ARCHITECTURE.zh.md`：六大域、三平面和依赖边界；
- `docs/HARNESS-2.0-UPGRADE-ROADMAP.zh.md`：完整升级路线；
- `step/snapshot`：每个模型请求尝试的持久冻结边界；
- Session invariant：校验 snapshot 对当前 request header/context 的引用；
- Agent Loop：请求重试使用同一 step、递增 attempt；
- 测试代码：请求重建、重试序号、snapshot 不变量。

## 验证状态

- TypeScript 语法级检查：通过（`tsc --noCheck`）；
- 干净源码树脚本：已实际运行；
- 完整 Vitest/工作区检查：当前容器没有 pnpm/node_modules，且无法联网获取依赖，因此尚未执行。

下一步：P0 `CapabilityPermission` + `GlobalBudget` + `ExecutionWorld` 合同。
