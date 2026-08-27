# dsh-execution-core

Native execution sidecar for DeepSeek Harness. P2a deliberately owns only ordinary process execution, executable lookup, Unix process groups, and tree-scoped signals. It does **not** own Agent, Session, model, memory, workflow, permission policy, PTY, filesystem virtualization, or network policy.

The transport is newline-delimited JSON on stdin/stdout. Child output that must be piped is emitted as base64 protocol events so the control channel remains unambiguous.
