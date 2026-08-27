# Harness 2.0 Local Upgrade Status

工作副本：本目录。

原始输入：`deepseek-harness-master.zip`，保持不修改。

## 当前阶段

P3：资源冲突调度与委派权限/预算单调继承。P0/P1/P2a 已进入主线；P2b Linux PTY 保持为后续独立阶段，不与本轮委派合同混合。

## 已落地主线

- `scripts/print-clean-code-tree.mjs`：可重复生成干净源码树；
- `docs/HARNESS-2.0-CLEAN-ARCHITECTURE.zh.md`：六大域、三平面和依赖边界；
- `docs/HARNESS-2.0-UPGRADE-ROADMAP.zh.md`：完整升级路线；
- `step/snapshot`：每个模型请求尝试的持久冻结边界；
- `@deepseek-ai/dsh-runtime-policy`：统一 CapabilityPermission / GlobalBudget / ExecutionWorld / AgentKind；
- `WorldEffectReceipt`：副作用开始前写 start，结算后写 receipt；崩溃留下 `result-unknown`；
- `@deepseek-ai/dsh-recovery`、`@deepseek-ai/dsh-model-router`、`@deepseek-ai/dsh-recovery-compaction`：Provider 本地重试耗尽后进入跨路由/压缩恢复，所有决策持久化；
- P2a Rust 普通进程执行平面：`native/execution-core`、`dsh-native-execution`、`dsh-native-client`、`dsh-subprocess-native`，默认仍保持 TypeScript Provider；
- P3 Tool Resource Contract：工具需求可注册，未知工具 fail-closed；
- P3 ResourceScheduler：读/读共享，写/执行/控制排他；冲突资源 FIFO，无关资源可绕行；审批、锁、预算与 WorldEffect 共用同一冻结需求快照。

## 本轮：委派权限/预算

- 新增持久 `runtime/delegation`：在子 Agent 发布前捕获 `parentSession`、父有效权限 ceiling 与父剩余预算 ceiling；
- `CapabilityPermissionSnapshot.ceiling`：逐层收紧父/祖先权限，不扁平化独立 source layer，保证 `ChildPermission ⊆ ParentPermission`；
- 子预算上限取部署限制与委派 ceiling 的逐维最小值；
- fork/resume 子会话只从最新 `runtime/delegation` 之后统计自身预算消费，避免继承 seed 被重复扣账；
- 同进程在线祖先共享预算账本：子级 admission 同步检查整个 live lineage，通过后一次性写入子账与祖先 delegated charge，阻止并行兄弟超卖同一父余额；
- 子 Agent 最终 token usage 镜像计入仍在线祖先账本；
- `step/snapshot.refs.delegation` 指向当前子 lineage 的权威委派事件；
- Runtime invariant 校验 delegation 的 parentSession、permission/budget ceiling、唯一活跃快照以及 Step Snapshot 引用；
- Subagent 复用现有未发布创建窗口，与 sandbox/approval 委派策略同一时点写入 runtime delegation；`dsh-runtime-policy` 为可选 peer，不建立反向核心依赖。

## 验证状态

- PR #14 ResourceScheduler 已人工补丁审查并合并；
- 本轮新增权限 ceiling、预算 ceiling、委派持久不变量测试代码；
- GitHub Actions 保持停用，不恢复旧 CI；
- 当前环境没有 pnpm/node_modules，无法运行完整 Vitest/工作区检查；
- 当前环境无 `cargo/rustc`，P2a/P2b Rust 源码仍不能在此环境真实编译；
- 生成型持久化目录文档未手工伪造，待依赖环境可用后由官方生成器统一刷新。

## 下一步

P2b 干净版 Linux PTY → CredentialPool / ModelRegistry → Memory / Learning → AgentGraph / Team 2.0 → Workflow 2.0 → Automation / Gateway / Computer。
