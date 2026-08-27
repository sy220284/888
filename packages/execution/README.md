# Execution

Execution-domain packages own the boundary between an agent's durable intent and effects in the outside world. They may project sandbox state, capability policy, budgets, effect receipts, and native execution capabilities, but they do not become a second source of truth for session history.

| Package | ctx key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-runtime-policy`](./runtime-policy/README.md) | `ctx.runtimePolicy` | Freezes permission, budget, world, configuration, and effect-receipt facts into canonical session state. |
| [`@deepseek-ai/dsh-native-execution`](./native-execution/README.md) | `ctx.nativeExecution` | Stable low-level seam for native executable lookup and process control. |
| [`@deepseek-ai/dsh-native-client`](./native-client/README.md) | — | Optional JSONL sidecar provider backed by `dsh-execution-core`. |

The native path remains opt-in while P2b fills PTY, sandbox/network integration, and additional platform guarantees. Existing consumers continue to depend on higher-level seams such as `ctx.subprocess` rather than the sidecar directly.
