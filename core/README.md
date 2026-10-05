# 888 Rust Core

Rust Core 负责 888 的正式状态、任务、Provider、Artifact、Worker 协议与事务边界。

当前已经包含两类能力：

## 1. Image Blaster Runtime 重写

| Image Blaster 旧逻辑 | 888 Rust Core |
|---|---|
| `fal-queue.mjs` | `provider/fal.rs` |
| `fal-3d-provider.mjs` | `provider/image_to_3d.rs` |
| `hunyuan-3d.mjs` | `provider/hunyuan.rs` |
| `meshy-3d.mjs` | `provider/meshy.rs` |
| `request-metadata.mjs` | `provider_run_repository.rs` + SQLite |
| `ensure-local-assets.mjs` / 下载逻辑 | `artifact_store.rs` + BLAKE3 内容寻址 |
| `project-state.mjs` 项目身份 | `project_repository.rs` + SQLite |
| GPT Image / Nano Banana Edit | `provider/image_edit.rs` |
| World Labs | `provider/world_labs.rs` |
| ElevenLabs SFX | `provider/sfx.rs` + `provider/audio.rs` |
| `generate-single-asset.mjs` | `asset_generation.rs` |

旧 `.claude` Runtime、bun、`scene.json / project.json` 状态源和目录扫描状态机均不进入 888。

## 2. 888 基础架构

### Canonical World / Revision

- `world_repository.rs`
- SQLite World / Revision 基础状态
- active revision CAS 并发保护
- Revision / Command 世界归属约束

### Candidate / Validation

- `candidate_service.rs`
- Candidate 必须引用真实 Artifact
- 最新 Validation 必须为 PASSED 才允许接受
- 接受 Candidate 会形成 World Revision

### Command

- `command_service.rs`
- command_id 幂等
- 并发首次提交只允许一个执行者
- 已支持基础 World / Candidate / Job 控制命令
- 未实现命令明确返回 REJECTED

### Observation Import

- `observation_import.rs`
- `observation_repository.rs`
- 本地图片按内容 Hash 流式进入 Artifact Store
- 重复内容只保存一份物理 Artifact，但每次输入都保留独立 Observation
- 原始图片 Artifact 显式记录 `ORIGINAL_IMAGE` 与来源元数据
- `IMPORT_OBSERVATIONS` 已接入幂等 Command
- 每条 Observation 自动创建持久化 `ANALYZE_OBSERVATION` Job
- Job 持久化输入参数，重启后不会丢失任务对象
- Vision Worker 实际执行 EXIF / Preview / Quality Analysis
- Worker 只读取 Artifact token；Preview 由 Core 验证后导入 Artifact Store
- Observation 正式分析结果只由 Core 回写 SQLite
- 固定 Fixture 验证 Observation=2 / Artifact=1 / Job=2

### Task / Job

- `job_engine.rs`
- Core-owned Job 状态机
- DAG 依赖
- required / optional dependency
- 循环依赖保护
- checkpoint / crash recovery 基础
- 非幂等任务无 checkpoint 时禁止自动重跑

### Provider

- `provider_router.rs`
- Canonical Capability 路由
- Quality Profile
- Health / cost / latency 约束
- 预算存在时，未知成本 / 时延不会被默认为满足条件

### Worker

- `worker_protocol.rs`
- stdio + JSONL 单消息边界
- 协议版本校验
- 1 MiB 消息上限
- 禁止 data URI 绕过 Artifact Store
- Job 消息必须携带 job_id

- `worker_registry.rs`
- Worker 注册
- Heartbeat
- Core-owned LOST 判定
- Worker 当前任务必须对应 Core 已知运行 Job

- `worker_runtime.rs`
- Core 持有 Python Worker 进程生命周期
- READY Job 按 capability 调度并绑定 assigned_worker_id
- stdio + JSONL 双向 JOB_DISPATCH / PROGRESS / JOB_RESULT
- PAUSE / CANCEL 控制链
- Worker 退出 / 心跳超时后的 Job 恢复
- Core 启动时执行 interrupted Job 恢复

## 3. 数据边界

- SQLite 保存正式结构化状态。
- 大文件进入本地内容寻址 Artifact Store。
- Provider 只产生 Artifact / Candidate / Proposal。
- Worker 不直接访问 SQLite。
- UI 不直接访问 SQLite / Provider 原始 API。
- Canonical World State 的正式修改必须经过 Core。
- Candidate 接受必须经过 Validation + Revision。

## 4. 当前仍未完成

阶段 1 的 Worker 生命周期与基础调度已经进入真实运行链，阶段 2 的图片 Observation 分析闭环已经落地。以下能力继续按执行路线推进：

- 视频导入 / 关键帧 Observation
- 更完整的 Retry / Backoff / Resource Queue 与硬件资源调度
- Reconstruction / SfM / MVS / Splat
- Camera / Zone / Entity 等 Canonical World Query / Mutation Service
- Associative Engine / Hypothesis Solver
- Render & Verify / Repair Planner
- World Compiler

这些能力应继续按 `docs/05-详细落地执行路线.md` 顺序推进，禁止因为已有 Provider Runtime 就跳过基础世界求解阶段。

## 5. 校验

仓库统一入口：

```bash
just architecture-check
just check
just test-fast
```

CI 会执行：

- 架构边界检查
- Schema / 三语言生成一致性
- Python 生成类型编译
- Rust format
- Clippy
- workspace tests
