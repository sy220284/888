# Harness 2.0 Local Upgrade Status

工作副本：本目录。

原始输入：`deepseek-harness-master.zip`，保持不修改。

## 当前阶段

P3 收口：资源冲突调度与委派权限/预算单调继承已实现并完成代码级审计修复。P0/P1/P2a 已进入主线；P2b 干净版 Linux PTY 保持为下一独立阶段，不与本轮委派合同混合。

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
- fork/resume 子会话只从属于当前直属父级的 `runtime/delegation` 之后统计自身预算消费，继承 seed 中的旧 lineage 快照不能串层；
- 同进程在线祖先共享预算账本：子级 admission 同步检查整个 live lineage，通过后一次性写入子账与祖先 delegated charge，阻止并行兄弟超卖同一父余额；
- Provider usage 以持久 `step/snapshot` 区分每次模型尝试：失败请求留下的 usage 分片同样计费，同一步 retry 会重新计费，同一尝试内的累计 usage 与最终消息只记增量；在线子 Agent 的这些增量同步镜像到仍在线祖先账本；
- `step/snapshot.refs.delegation` 指向当前直属父 lineage 的权威委派事件；
- Runtime invariant 不仅校验 delegation 的 parentSession、唯一活跃快照与引用，还把 `runtime/permission.ceiling`、`runtime/budget.limits` 与权威 delegation 内容做语义绑定，拒绝回放时伪造更宽权限或预算；
- Subagent 复用现有未发布创建窗口，与 sandbox/approval 委派策略同一时点写入 runtime delegation；`dsh-runtime-policy` 为可选 peer，不建立反向核心依赖。

## 验证状态

- PR #14 ResourceScheduler 已人工补丁审查并合并；
- 本轮测试代码覆盖权限 ceiling、预算 ceiling、直属 lineage 绑定、委派持久不变量、失败 usage、最终 usage 去重与同一步多 attempt 独立计费；
- PR #15 已进行逐文件代码级复查；当前无审查线程、无审查评论；
- GitHub Actions 保持停用，不恢复旧 CI；当前提交没有自动检查结果；
- 当前环境没有 pnpm/node_modules，无法运行完整 Vitest/工作区检查；
- 当前环境无 `cargo/rustc`，P2a/P2b Rust 源码仍不能在此环境真实编译；
- 生成型持久化目录文档未手工伪造，待依赖环境可用后由官方生成器统一刷新。

## 下一步

P2b 干净版 Linux PTY → CredentialPool / ModelRegistry → Memory / Learning → AgentGraph / Team 2.0 → Workflow 2.0 → Automation / Gateway / Computer。
