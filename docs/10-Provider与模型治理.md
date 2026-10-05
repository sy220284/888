# 10 Provider 与模型治理

## 1. 目标

Provider Router 负责把“需要什么能力”映射到具体模型或服务。

业务层永远使用 Capability，不依赖供应商名称。

## 2. Capability Registry

第一阶段：

- IMAGE_EDIT
- OBJECT_3D
- WORLD_COMPLETION
- DEPTH
- SEGMENTATION
- IMAGE_EMBEDDING
- FEATURE_MATCHING
- TEXTURE
- AUDIO
- ASSOCIATIVE_REASONING
- SCENE_HYPOTHESIS
- VERIFICATION_QUESTION

后续：

- CHARACTER
- MOTION
- RELIGHTING

每种 Capability 有固定输入 / 输出 Schema。

## 3. Provider Adapter

Provider 必须实现：

- capabilities
- validate
- estimate
- execute
- poll（如异步）
- cancel（如支持）
- health

Provider 只能返回 Candidate / Artifact，不直接修改 World State。

## 4. Provider 元数据

每个 Provider 记录：

- provider_id
- display_name
- capability
- local / remote
- model_id
- model_version
- input limits
- output formats
- average latency
- estimated cost
- current health
- license metadata
- data handling metadata
- supported devices

## 5. 模型版本固定

生产路径不得使用无法追踪的“latest”。

需要记录：

- model name
- revision
- checkpoint hash（本地）
- API model version（远程）
- adapter version

升级模型必须走 Benchmark。

## 6. Router 选择维度

Router 依据：

- Capability
- 目标质量
- 输入类型
- 时延预算
- 成本预算
- 可用硬件
- 当前健康状态
- 输出格式
- 用户固定偏好
- 数据处理约束
- 历史 Benchmark

## 7. Quality Profile

统一档位：

### FAST

- 预览优先
- 成本低
- 低延迟

### BALANCED

- 默认用户路径
- 质量与成本平衡

### HIGH

- 高分辨率
- 更高迭代次数
- 可接受更长耗时

### MAX

- 只用于最终导出或指定区域
- 必须提示高成本

业务层传 Profile，不传厂商参数。

## 8. Fallback

示例：

```text
首选 Provider A
↓ 失败
同模型本地实现（若存在）
↓
Provider B
↓
能力降级
↓
返回明确不可用
```

Fallback 不允许悄悄改变结果语义。

例如高精度 Mesh 不能无提示降为 2D 图。

## 9. 成本治理

远程 Provider 请求前必须支持 estimate。

保存：

- estimated cost
- actual cost
- currency
- usage unit
- world_id
- job_id

支持：

- 单任务预算
- 单世界预算
- Provider 月度 / 会话预算

超过预算时进入 WAITING_USER / BLOCKED，不自动继续烧费用。

## 10. 健康状态

Provider Health：

- HEALTHY
- DEGRADED
- UNAVAILABLE
- RATE_LIMITED
- AUTH_ERROR

Router 不把新任务发送到 UNAVAILABLE。

## 11. Benchmark

模型升级需在固定 Benchmark 上对比：

- 质量
- 成功率
- 延迟
- 显存
- 成本
- 输出稳定性

结果进入 Provider Registry 的性能档案。

## 12. 本地模型

本地模型额外记录：

- 模型 Hash
- 权重来源
- 磁盘大小
- VRAM 要求
- 支持 GPU
- 量化类型

## 13. 远程模型

远程 Provider 额外记录：

- API version
- request id
- rate limit
- timeout
- retry policy
- async polling

## 14. 能力替换测试

任何 Provider 替换后必须保证：

- Schema 不变。
- World State 不变。
- UI 不变。
- Candidate / Validation 链不变。
- 相关 Fixture 继续通过。

## 15. 模型退役

退役模型：

1. 标记 DEPRECATED。
2. 禁止新任务默认选择。
3. 保留旧 Provenance 可读。
4. 不删除旧 Artifact。
5. 提供可选重算路径。

## 16. Provider 清单维护

仓库后续新增机器可读文件：

`packages/provider-registry/providers.yaml`

由 CI 校验：

- Capability 合法。
- 版本存在。
- Adapter 存在。
- Benchmark 元数据完整。

## 17. 联想类 Capability 约束

联想类 Capability 的输出必须是结构化 Associative Proposal，不得返回“直接修改世界”的指令。

适用：

- ASSOCIATIVE_REASONING：提出对象、空间、拓扑候选关系。
- SCENE_HYPOTHESIS：提出多个可比较的世界解释。
- VERIFICATION_QUESTION：把未决假设转换为可验证问题和所需证据。

联想 Provider 必须记录：

- model / version
- source observations
- supporting evidence
- proposal score
- uncertainty
- token / monetary cost

Router 不允许把联想输出绕过 Hypothesis / Validation 链直接提交 Revision。
