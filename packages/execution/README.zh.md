# 执行域

执行域包负责连接 Agent 的持久化意图与外部世界中的真实副作用。它可以投影沙箱状态、能力权限、预算和副作用回执，但不会成为 Session 历史之外的第二真相源。

本组首个包是 [`@deepseek-ai/dsh-runtime-policy`](./runtime-policy/README.zh.md)：它把执行事实冻结为规范 Session 事件，并由 Core 的 Step Snapshot 边界引用这些事件。
