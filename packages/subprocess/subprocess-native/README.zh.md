# @deepseek-ai/dsh-subprocess-native

基于 `ctx.nativeExecution` 的可选 `ctx.subprocess` Provider。P2a 覆盖普通进程、有界输出收集、可执行文件解析、Abort 驱动的 TERM→宽限→KILL 升级，以及整棵进程树存活检测。PTY 明确留到 P2b，不伪装成已支持。

模型可见影响：与消费 `ctx.subprocess` 的 Shell/工具一致；该 Provider 不增加 Prompt。KV Cache 影响：无。
