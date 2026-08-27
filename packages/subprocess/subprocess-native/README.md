# @deepseek-ai/dsh-subprocess-native

Opt-in `ctx.subprocess` provider backed by `ctx.nativeExecution`. P2a covers ordinary processes, bounded collected output, executable lookup, abort-driven TERM→grace→KILL escalation, and whole-tree liveness. PTY remains intentionally unsupported until P2b.

Model-visible impact: identical to whichever shell/tool consumes `ctx.subprocess`; this provider adds no prompt content. KV-cache impact: none.
