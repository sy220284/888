# 08 Command 与 Worker 通信协议

## 1. 目标

本协议冻结 UI、Core、Worker、Provider 之间的通信边界。

核心原则：

- UI 只表达用户意图。
- Core 负责正式状态与调度。
- Worker 只执行计算任务。
- 大文件走 Artifact Store。
- 所有跨进程数据使用权威 Schema。

## 2. Command 模型

所有 UI / Agent 操作最终进入 Command API。

基础结构：

```json
{
  "command_id": "uuid",
  "type": "IMPORT_OBSERVATIONS",
  "world_id": "uuid",
  "payload": {},
  "requested_at": "..."
}
```

Command 必须具备：

- command_id
- type
- target world
- payload
- schema_version
- caller context

## 3. Command 分类

第一阶段至少支持：

- CREATE_WORLD
- OPEN_WORLD
- IMPORT_OBSERVATIONS
- DELETE_OBSERVATION
- RECONSTRUCT_ZONE
- ANALYZE_RELATIONS
- GENERATE_ASSOCIATIVE_PROPOSALS
- VERIFY_HYPOTHESIS
- SUGGEST_NEXT_OBSERVATION
- GENERATE_COMPLETION
- VALIDATE_CANDIDATE
- ACCEPT_CANDIDATE
- REJECT_CANDIDATE
- EXPORT_WORLD
- PAUSE_JOB
- RESUME_JOB
- CANCEL_JOB

Agent 只能调用公开 Command，不能绕过 Core 调 Worker / Provider。

## 4. Command Response

```json
{
  "command_id": "uuid",
  "status": "ACCEPTED",
  "job_ids": ["uuid"],
  "result": null,
  "error": null
}
```

同步 Command 可直接返回结果。

耗时任务只返回 Job ID。

## 5. Worker 注册

Worker 启动后向 Core 注册：

```json
{
  "worker_id": "uuid",
  "worker_type": "VISION",
  "protocol_version": 1,
  "capabilities": [],
  "device": {},
  "software": {}
}
```

软件信息至少包括：

- Worker 版本
- Python 版本
- 模型 / 算法插件版本
- CUDA / MPS 信息

## 6. Heartbeat

Worker 定期发送：

- worker_id
- timestamp
- current_jobs
- CPU
- RAM
- GPU
- VRAM
- health

Core 超过阈值未收到 Heartbeat 后，将 Worker 标记为 LOST。

## 7. Job Dispatch

Core 向 Worker 发送：

```json
{
  "job_id": "uuid",
  "type": "RUN_RECONSTRUCTION",
  "inputs": [],
  "parameters": {},
  "artifact_refs": [],
  "checkpoint": null
}
```

Worker 不接收数据库连接信息。

## 8. Progress

统一进度事件：

```json
{
  "job_id": "uuid",
  "stage": "FEATURE_MATCHING",
  "progress": 0.42,
  "message_code": "MATCHING_IMAGE_PAIRS",
  "metrics": {
    "completed": 42,
    "total": 100
  }
}
```

UI 展示文案由 UI 层根据 message_code 本地化。

Worker 不输出模板式“正在处理中”作为唯一进度。

## 9. Job Result

成功：

```json
{
  "job_id": "uuid",
  "state": "COMPLETED",
  "outputs": [
    {
      "type": "GEOMETRY_CANDIDATE",
      "schema_ref": "...",
      "artifact_ids": []
    }
  ]
}
```

失败：

```json
{
  "job_id": "uuid",
  "state": "FAILED",
  "error": {
    "code": "RESOURCE_EXHAUSTED",
    "retryable": true,
    "details": {}
  }
}
```

## 10. 错误码

基础错误码：

- INVALID_INPUT
- UNSUPPORTED_FORMAT
- SCHEMA_MISMATCH
- RESOURCE_EXHAUSTED
- DEVICE_UNAVAILABLE
- MODEL_UNAVAILABLE
- PROVIDER_TIMEOUT
- PROVIDER_RATE_LIMIT
- PROVIDER_INVALID_RESPONSE
- ARTIFACT_MISSING
- ARTIFACT_CORRUPTED
- JOB_CANCELLED
- WORKER_LOST
- INTERNAL_ERROR

错误必须标记：

- retryable
- user_action_required
- safe_to_resume

## 11. Pause / Resume / Cancel

暂停请求必须由 Core 记录。

Worker 支持时：

- 进入安全 Checkpoint。
- 返回 PAUSED。

不支持时：

- 标记 pause_not_supported。
- UI 明确显示。

Cancel 必须可幂等重复调用。

## 12. Artifact 引用

跨进程只传：

- artifact_id
- content_hash
- logical_type
- authorized_path_token（需要时）

禁止直接把任意系统路径作为可信输入。

## 13. 协议版本

每个消息必须包含 protocol_version 或绑定 Schema Version。

兼容策略：

- 同 Major：允许兼容扩展。
- Major 不同：Worker 不注册为 Ready。
- Breaking Change 必须升级版本。

## 14. 幂等

关键 Command 必须定义幂等语义。

例如同一 command_id 重放：

- 不重复创建 World。
- 不重复导入同一逻辑操作。
- 不重复提交 Revision。

## 15. 传输实现

第一阶段固定：

- **stdio + JSON Lines（JSONL）**
- stdin/stdout 只传协议消息
- stderr 只输出日志与诊断
- 每行一个完整 JSON 消息
- 消息必须包含 protocol_version 与 request/job 标识

local socket 保留为未来性能优化候选，只有 Benchmark 证明 stdio 成为瓶颈时才切换。

禁止过早引入：

- Kafka
- Redis
- 分布式消息总线

协议独立于具体传输，未来可替换。

## 16. 测试要求

必须有：

- Command Schema 测试
- Worker 注册测试
- Heartbeat 丢失测试
- Progress 顺序测试
- Cancel 幂等测试
- Worker 崩溃恢复测试
- Schema Version 不兼容测试
- 大文件不经 RPC 检查

## 17. 联想类 Command

### GENERATE_ASSOCIATIVE_PROPOSALS

输入：

- world_id
- target zone / entity / hypothesis
- source observation ids
- proposal types
- top_k
- budget profile

输出：

- AssociativeProposal[]
- supporting evidence refs
- contradicting evidence refs
- uncertainty

### VERIFY_HYPOTHESIS

根据现有 Evidence、Constraint 与指定 Hypothesis 生成验证任务，不直接修改世界。

### SUGGEST_NEXT_OBSERVATION

把未决 Hypothesis 转换成下一最佳观测建议，输出：

- target uncertainty
- suggested viewpoint / zone
- required anchors
- expected information gain

联想类 Command 的结果仍由 Core 写入 Prior / Hypothesis 状态，Worker / Provider 不直接提交 Revision。

## 18. AI Capability 执行消息

Core 与 AI Worker / Provider Adapter 之间只传 Canonical Capability Request，不传业务层临时 Prompt。

请求至少包含：

- request_id
- capability
- input artifact refs
- context refs
- output schema
- quality profile
- creativity profile
- evidence policy
- cost / latency budget

返回必须是 AIOutputEnvelope。

### ToolIntent

无原生 Tool Calling 的模型可以返回 ToolIntent，但执行前必须经过：

1. Schema Validation。
2. Tool Allowlist。
3. 参数 Validation。
4. World / Evidence 权限边界检查。

AI 生成的 ToolIntent 本身没有执行权限。

### Provider 私有字段

厂商 request id、finish reason、token usage 等私有字段进入 provider_metadata，不得扩散到业务 Schema。
