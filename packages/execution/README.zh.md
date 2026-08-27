# 执行域

执行域包负责连接 Agent 的持久化意图与外部世界中的真实副作用。它可以投影沙箱状态、能力权限、预算、副作用回执和原生执行能力，但不会成为 Session 历史之外的第二真相源。

| 包 | ctx 键 | 角色 |
|---|---|---|
| [`@deepseek-ai/dsh-runtime-policy`](./runtime-policy/README.zh.md) | `ctx.runtimePolicy` | 把权限、预算、执行世界、配置与副作用回执冻结成规范 Session 状态。 |
| [`@deepseek-ai/dsh-native-execution`](./native-execution/README.zh.md) | `ctx.nativeExecution` | 原生可执行文件解析与进程控制的稳定底层接缝。 |
| [`@deepseek-ai/dsh-native-client`](./native-client/README.zh.md) | 无 | 基于 `dsh-execution-core` 的可选逐行 JSON 侧车 Provider。 |

在 P2b 补齐 PTY、沙箱/网络集成与更多平台保证之前，原生路径保持可选。现有消费方仍然依赖 `ctx.subprocess` 等更高层接缝，不直接依赖侧车。
