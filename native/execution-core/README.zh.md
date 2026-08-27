# dsh-execution-core

DeepSeek Harness 的原生执行侧车。P2a 只负责普通进程执行、可执行文件解析、Unix 进程组和整树信号；**不**接管 Agent、Session、模型、记忆、工作流、权限策略、PTY、文件系统虚拟化或网络策略。

传输协议为 stdin/stdout 上的逐行 JSON。需要管道传输的子进程输出会以 base64 协议事件发送，避免与控制通道混淆。
