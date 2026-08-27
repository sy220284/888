# Harness 2.0 Local Upgrade Status

工作副本：本目录。

原始输入：`deepseek-harness-master.zip`，保持不修改。

## 当前阶段

P2a：Rust 原生普通进程执行平面。P0/P1 已进入主线；当前以可选 Provider 方式接入原生执行侧车，不替换默认 TypeScript Provider。

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

P2a 新增：

- `native/execution-core`：逐行 JSON 原生侧车协议、可执行文件解析、Unix `setsid` 进程组、Linux 父死亡信号与整树信号；
- `@deepseek-ai/dsh-native-execution`：稳定原生执行能力接缝；
- `@deepseek-ai/dsh-native-client`：不经过 Shell 的侧车客户端 Provider，默认不启用；
- `@deepseek-ai/dsh-subprocess-native`：复用现有 `ctx.subprocess` 合同，支持普通进程、环境清理、有界输出/spill、TERM→grace→KILL、整树存活检测；
- Base Bundle 使用 `DSH_EXECUTION_PROVIDER=native` 显式切换，默认继续使用 `subprocess-local`；
- P2a 明确拒绝 PTY，不把尚未实现的终端能力伪装为可用。

当前环境无 `cargo/rustc`，因此 Rust 源码尚未真实编译；TypeScript 新增源码已通过语法解析，完整 Vitest 仍受缺少依赖限制。

下一步：P2b PTY / Sandbox / Network Policy / Windows Job Object 与 Rust↔TypeScript Provider 契约差分测试；随后补 CredentialPool 与更完整 ModelRegistry。
