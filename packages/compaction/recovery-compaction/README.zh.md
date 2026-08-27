# dsh-recovery-compaction

处理 `CONTEXT_WINDOW_EXCEEDED` 的恢复策略。它调用当前压缩服务执行安全的强制压缩；只有模型可见上下文确实发生了有效缩减时才重新请求。
