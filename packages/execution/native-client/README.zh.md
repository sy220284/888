# @deepseek-ai/dsh-native-client

Cordis Provider：不经过 Shell 启动 `dsh-execution-core`，并把其逐行 JSON 协议投影为 `ctx.nativeExecution`。该包默认不启用，也不会单独替换 `ctx.subprocess`。

模型可见影响：无。Token 影响：无。KV Cache 影响：无。
