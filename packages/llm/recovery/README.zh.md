# dsh-recovery

模型请求失败后的跨供应方/上下文恢复接缝。供应方内部退避仍由 `dsh-llm-retry` 负责；只有下游重试明确放弃后，恢复策略才开始工作。

策略是可撤销的 Cordis Effect，按优先级执行；胜出的决策会先持久化为 `recovery/decision`，随后 Agent 才重试。该服务不建立第二套消息历史或 Agent 运行时。
