# 888 Schema

`packages/schema/` 是 888 跨语言正式协议的唯一真相源，固定使用 JSON Schema Draft 2020-12。

任何正式跨进程 / 跨语言结构都必须先修改这里，再生成 Rust、TypeScript、Python 类型；禁止在三种语言中各自维护同义协议。

## 当前协议分层

### Command

- Command
- CommandResponse

### World / Canonical State

- World
- Observation
- Evidence
- AssociativeProposal
- Hypothesis
- Zone
- Anchor
- Portal
- Entity
- GeometryRepresentation
- Candidate
- ValidationResult
- WorldRevision

### Task / Job

- Task
- Job（持久化 input，保证任务恢复后仍能定位执行对象）

### Worker

- WorkerRegistration
- WorkerHeartbeat
- WorkerMessage
- JobDispatch
- ProgressEvent
- JobResult

### Provider / AI Compatibility

- Artifact（包含 logical_type 与 source provenance）
- Project
- CanonicalCapabilityRequest
- ProviderCapability
- AIProviderRun
- AIOutputEnvelope
- AIModelProfile
- CalibrationProfile
- CreativityProfile
- ToolIntent

### Compiler

- CompilerTarget

## 生成流程

```bash
python tools/validate_schemas.py
python tools/generate_schema_types.py
python tools/generate_schema_types.py --check
```

生成位置：

- Rust：`core/src/model/generated.rs`
- TypeScript：`apps/desktop/src/generated/schema.ts`
- Python：`workers/sdk/generated_models.py`

CI 同时校验：

1. Schema 基础合法性。
2. 三语言生成物是否与权威 Schema 一致。
3. Python 生成类型可编译。
4. Rust 编译、Clippy 与单测。
5. 架构边界是否被破坏。

## 变更规则

正式协议修改顺序固定为：

```text
修改 packages/schema
→ 重新生成三语言类型
→ Migration（涉及持久化时）
→ Fixture / 单元测试
→ Core / Worker / UI 编译与回归
```

Provider 私有返回结构、缓存结构、Worker 内部临时结构不得提升成第二套正式世界协议。
