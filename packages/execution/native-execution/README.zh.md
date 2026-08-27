# @deepseek-ai/dsh-native-execution

原生执行平面的服务定义。该接缝只暴露可执行文件解析和普通受管进程，明确排除 Agent、Session、模型、权限策略、Shell、PTY、文件系统与网络语义。

模型可见影响：自身没有；由上层工具决定是否向模型暴露。KV Cache 影响：无。
