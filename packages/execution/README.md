# Execution

Execution-domain packages own the boundary between an agent's durable intent and effects in the outside world. They may project sandbox state, capability policy, budgets, and effect receipts, but they do not become a second source of truth for session history.

The first package in this group is [`@deepseek-ai/dsh-runtime-policy`](./runtime-policy/README.md), which freezes execution facts into canonical session events and references them from the core Step Snapshot boundary.
