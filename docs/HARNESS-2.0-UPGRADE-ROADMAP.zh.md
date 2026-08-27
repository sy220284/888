# DeepSeek Harness 2.0 本地升级路线

## 总原则

采用“拆、抽、融、替”而非仓库拼接：

- **拆**：从 Codex、Hermes、cc-haha 中拆出独立能力；
- **抽**：保留成熟算法、错误恢复策略和边界情况；
- **融**：按 Harness 的 Context / Service / Scope / Effect / Event 重新接入；
- **替**：旧 Provider 与新 Provider 双轨运行，经过契约测试和差分测试后再替换默认实现。

Claude Code 主要做规范与交互兼容，不复制闭源核心。

## P0：架构宪法

状态：P0 合同已完成，进入 P1/P2 实装准备。

### 已完成

- [x] 建立独立本地工作副本，原 ZIP 不修改；
- [x] 提供可重复生成的干净源码树脚本；
- [x] 明确六大逻辑域与三平面结构；
- [x] 保留 Harness 为唯一 Session/Agent 事实源；
- [x] 新增 `step/snapshot` 权威模型请求冻结边界；
- [x] 请求重试在同一 Step 内记录递增 `attempt`；
- [x] Session invariant 校验 Step Snapshot 对最新 Header/Context 的引用；
- [x] 增加相关回归测试代码。

### 下一批 P0 合同

- [x] `CapabilityPermission`：能力 + 资源的细粒度权限；
- [x] `GlobalBudget`：Token / 成本 / 时间 / 工具 / Agent / 风险预算；
- [x] `ExecutionWorld`：FS / Process / Network / Browser / Computer 的统一世界；
- [x] `WorldEffectReceipt`：所有真实副作用的可审计回执；
- [x] `AgentKind`：SubAgent / ForkAgent / TeamMember / BackgroundSessionAgent；
- [x] Canonical Event 与 Internal Signal 分层：持久事实写 Session Event，`agent/step-snapshot` 仅作内部 waterfall 接缝；
- [x] Step Snapshot 扩展 Permission / Budget / World / Config 引用。

## P1：Harness Core 收束

- [ ] Session 格式升级与迁移机制实装；
- [ ] 冷 Session 恢复/分叉强化；
- [ ] Step 生命周期与崩溃修复；
- [x] RecoveryService 接缝；
- [ ] App Server 权威控制面边界。

## P2：Codex 执行平面

仅吸收执行能力，不引入 Codex Thread/Agent：

- [x] Rust Native Protocol（P2a JSONL v1，真实编译待 Rust 工具链）；
- [x] Process / Process Tree（Unix `setsid` + Linux 父死亡信号 + 整树信号）；
- [ ] PTY；
- [x] Shell（继续复用现有 Shell 层，经 `ctx.subprocess` 切换到原生 Provider）；
- [ ] Filesystem；
- [ ] Sandbox；
- [ ] Network Policy；
- [x] Cancellation 收敛（普通进程 TERM→grace→KILL；PTY/Windows 继续在 P2b）；
- [ ] Rust Provider 与现有 TypeScript Provider 双轨契约测试（已补原生 Provider 契约测试代码，待依赖/Rust 工具链执行）。

## P3：权限与资源调度

- [x] `Allow / Ask / Deny` 权限核心；
- [x] 子 Agent 权限单调收紧；
- [x] Tool 资源声明；
- [x] 资源冲突图调度；
- [ ] Remote Approval；
- [x] WorldEffectReceipt。

## P4：Hermes 模型与恢复能力

- [ ] ModelRegistry；
- [x] ModelRouter；
- [ ] CredentialPool；
- [x] Provider/Model Fallback；
- [x] RecoveryService；
- [x] ContextOverflow 压缩恢复；
- [ ] OutputLimit / Credential rotation / 更完整 Retry / Backoff 策略。

## P5：Claude Code 生态兼容

- [ ] SKILL.md；
- [ ] Agent Template；
- [ ] Claude Hooks 完整语义；
- [ ] 项目规则兼容；
- [ ] 渐进式 Skill 加载；
- [ ] 权限交互预设。

## P6：Memory + Learning

融合 Harness Event、Hermes Learning、cc-haha Memory：

- [ ] Working Memory；
- [ ] Episodic Memory；
- [ ] Semantic Memory；
- [ ] Procedural Memory；
- [ ] MemoryExtractor；
- [ ] MemoryConsolidator；
- [ ] SkillProposal / Test / Evaluate / Promote。

## P7：Agent Graph + Team 2.0

- [ ] 统一 AgentGraph；
- [ ] Fork Context；
- [ ] Team Roster；
- [ ] Task DAG；
- [ ] 跨进程 Mailbox；
- [ ] 幂等投递 / Ack；
- [ ] Team Budget；
- [ ] Shared Artifact / Memory。

## P8：Workflow 2.0

融合 Harness + cc-haha：

- [ ] WorkflowIR；
- [ ] Compiler；
- [ ] Journal；
- [ ] Resume；
- [ ] Saved / Nested / Background Workflow；
- [ ] Workflow Budget；
- [ ] 受限运行时，停止把 Node `vm` 当安全边界。

## P9：Automation 2.0

融合 Harness Schedule/Jobs 与 Hermes Cron：

- [ ] Once / Cron / Interval / Event / Condition / GoalCheck；
- [ ] 冷 Session 唤醒；
- [ ] Preflight；
- [ ] Notepad；
- [ ] Monitor change detection；
- [ ] Execution ledger；
- [ ] Delivery。

## P10：Gateway / Computer / Product Control Plane

- [ ] GatewayService；
- [ ] Telegram / Discord / Slack / WhatsApp / 飞书 / 钉钉等 Adapter；
- [ ] DesktopWorld；
- [ ] Screen / Window / Pointer / Keyboard / Clipboard；
- [ ] Frame Lease；
- [ ] Desktop / Web / TUI / IDE / H5 统一走 App Server；
- [ ] Why Inspector；
- [ ] Replay / Fork / Effect Review UI。

## 强制不变量

1. 模型看到过的持久状态必须可重建；
2. Tool 副作用开始前必须已有权威 ToolCall；
3. 一个 ToolCall 只有一个权威 ToolResult；
4. 自动权限只能收紧；
5. 子 Agent 权限、预算均不得突破父边界；
6. Workflow 不得突破调用者能力；
7. 插件卸载必须撤销所有 RuntimeEffect；
8. 真实世界副作用必须生成 WorldEffectReceipt；
9. 取消最终必须收敛到所有子进程/子任务；
10. 并发执行允许乱序，模型观察顺序必须确定；
11. Step 开始后，模型、工具、权限、World、配置必须冻结；
12. 客户端不能成为业务权威状态源；
13. Memory 必须具有来源和版本；
14. 自动 Skill 升级必须经过验证；
15. 崩溃后必须能区分“未执行 / 已执行 / 执行中 / 结果未知”。
