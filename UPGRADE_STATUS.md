# Harness 2.0 Local Upgrade Status

工作副本：本目录。

原始输入：`deepseek-harness-master.zip`，保持不修改。

## 当前阶段

P1/P4：模型请求恢复与路由。P0 已完成；RecoveryService、上下文压缩恢复和 ModelRouter/Fallback 已落地，准备进入 Rust 执行平面。

## 本轮已落地

- `scripts/print-clean-code-tree.mjs`：可重复生成干净源码树；
- `docs/HARNESS-2.0-CLEAN-ARCHITECTURE.zh.md`：六大域、三平面和依赖边界；
- `docs/HARNESS-2.0-UPGRADE-ROADMAP.zh.md`：完整升级路线；
- `step/snapshot`：每个模型请求尝试的持久冻结边界；
- Session invariant：校验 snapshot 对当前 request header/context 的引用；
- Agent Loop：请求重试使用同一 step、递增 attempt；
- 测试代码：请求重建、重试序号、snapshot 不变量；
- `@deepseek-ai/dsh-runtime-policy`：统一 CapabilityPermission / GlobalBudget / ExecutionWorld / AgentKind；
- `agent/step-snapshot` waterfall：Core 只提供冻结扩展点，执行域持久化运行时事实再合并引用；
- `WorldEffectReceipt`：副作用开始前写 start，结算后写 receipt；崩溃留下 `result-unknown`；
- Runtime invariant：权限/预算/世界/配置引用、预算结构、effect start/receipt 配对与 step 关闭条件；
- Base Bundle、TypeScript 工程引用与持久化事件词汇均已接入新包。
- `pnpm-lock.yaml` 与持久化目录文档属于生成物：当前环境缺少 pnpm/node_modules 且无法联网，留待依赖环境恢复后由官方生成器统一再生，避免手工伪造生成物。

## 验证状态

- TypeScript 语法级解析与 `git diff --check`：通过；
- 干净源码树脚本：已实际运行；
- 完整 Vitest/工作区检查：当前容器没有 pnpm/node_modules，且无法联网获取依赖，因此尚未执行。

新增完成：`@deepseek-ai/dsh-recovery`、`@deepseek-ai/dsh-model-router`、`@deepseek-ai/dsh-recovery-compaction`；Provider 本地重试耗尽后才进入跨路由/压缩恢复，所有决策持久化。

下一步：P2 Rust Execution Provider（Protocol / Process / Shell / PTY / Filesystem / Sandbox / Network / Cancellation），随后补 CredentialPool 与更完整 ModelRegistry。
