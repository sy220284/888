# ADR 架构决策记录

ADR（Architecture Decision Record）用于记录 888 已经确定的重要技术决策、原因、替代方案与后果。

AI 开发者不得在普通功能任务中无理由推翻“已接受”的 ADR。

若事实证明旧决策失效：

1. 新建一份 ADR。
2. 引用旧 ADR。
3. 标记旧 ADR 为“已取代”。
4. 同步修改权威文档与实现。

当前 ADR：

- [0001 三语言分层架构](0001-三语言分层架构.md)
- [0002 本地优先与本地世界状态](0002-本地优先与本地世界状态.md)
- [0003 GTSAM 第一阶段保留在 Python Worker](0003-GTSAM保留在PythonWorker.md)
- [0004 Monorepo 而非微服务拆分](0004-Monorepo而非微服务.md)
- [0005 Schema 单一真相源](0005-Schema单一真相源.md)