# AGENTS.md

## 1. 本文件的地位

本文件是 888 仓库内所有 AI Agent、自动编码工具和人工开发者开始任务前的第一入口。

目标：让项目可以长期由 AI 高比例推进，同时保持架构、数据、调用链、测试和产品目标不漂移。

任何实现与本文件或权威文档冲突时，必须先停止继续扩展，并以权威文档为准处理冲突。

## 2. 开工前必读顺序

每次任务至少按以下顺序读取：

1. `AGENTS.md`
2. `README.md`
3. 与任务直接相关的 `docs/` 权威文档
4. 目标模块现有代码
5. 相关测试 / Fixture
6. 最近与该模块相关的提交或 PR（需要时）

不得只根据历史对话、模型记忆或任务标题直接修改代码。

涉及技术栈、架构边界或基础设施决策时，还必须读取相关 ADR。

## 3. 权威文档

- `README.md`：项目总目标、最终效果、总体技术方向
- `docs/01-最终产品与功能设计.md`：用户最终能力和产品行为
- `docs/02-总体架构设计.md`：模块分层、依赖方向、核心运行架构
- `docs/03-核心技术实现方案.md`：技术栈、算法路径、具体实现方式
- `docs/04-世界模型与数据设计.md`：Canonical World State、Schema、Evidence、Hypothesis、Revision
- `docs/05-详细落地执行路线.md`：开发阶段、实施顺序、阶段验收
- `docs/06-质量验证与验收标准.md`：Fixture、指标、CI、回归和完成标准
- `docs/07-开发环境与运行手册.md`：开发环境、依赖、标准命令、运行与诊断
- `docs/08-Command与Worker通信协议.md`：Command、Worker、Progress、Error、IPC 边界
- `docs/09-任务状态机与故障恢复.md`：Job 状态机、Checkpoint、Retry、Crash Recovery
- `docs/10-Provider与模型治理.md`：Capability、Provider、模型版本、成本、Fallback、Benchmark
- `docs/12-性能预算与硬件兼容.md`：设备分级、性能预算、显存、内存、Viewer 指标
- `docs/13-构建发布与升级方案.md`：打包、Worker 分发、Migration、更新与回滚
- `docs/14-Fixture与Benchmark规范.md`：测试数据、Ground Truth、Baseline、回归标准
- `docs/15-用户交互与页面流程.md`：页面职责、用户流程、可信度与补拍交互
- `docs/adr/README.md`：已接受的关键架构决策与变更规则
- `docs/16-可行性分析与技术风险.md`：整体可行性、核心研发难点、单人 + AI 难度与风险边界
- `docs/17-联想推理与先验系统设计.md`：联想先验、Proposal、Hypothesis、联想求证与反幻觉边界

文档编号 `11` 当前有意保留，不创建对应文档；除非用户明确要求，不得因编号空缺自行补建。

若代码与文档不一致，先判断：
- 文档仍有效：修代码。
- 技术事实证明文档失效：同步修改文档与实现，不能只改代码留下两套规则。

## 3.1 文档冲突裁决顺序

若多个权威文档之间出现表述冲突，按以下顺序处理：

1. **用户最新明确要求**：最高优先级，但必须同步更新仓库权威文档，不能只依赖聊天上下文。
2. **已接受且未被取代的 ADR**：用于裁决技术栈、基础设施和架构决策。
3. **专项权威文档**：例如数据问题以 `04` 为准，Job 状态以 `09` 为准，Provider 以 `10` 为准，性能以 `12` 为准。
4. **总体架构文档 `02`**：负责跨模块边界与总体方向。
5. **README**：负责项目总览，不覆盖专项文档中的更精确规则。
6. **普通代码注释 / 示例**：不得覆盖以上权威来源。

若专项文档和 ADR 冲突，优先检查 ADR 是否已被新 ADR 取代；未取代时以 ADR 为准，并同步修正文档。

AI 不得在存在未解决文档冲突时继续扩展实现。

## 4. 项目不可破坏的核心原则

1. 重建优先，生成兜底。
2. 证据优先，不确定性显式存在。
3. 联想只能提出 Prior / Proposal，不能直接生成 Observed 或 Verified。
4. 多假设可以并存，新证据推动收敛。
5. Canonical World State 是唯一正式世界状态。
6. Provider 只产生 Candidate，不直接写正式世界。
7. Candidate 经过 Validation 后才能进入 Revision。
8. 原始 Observation 不被生成内容覆盖。
9. 模型、Agent、渲染表示都必须可替换。
10. 生成成功不等于结果正确。
11. 能局部修复就不全量重做。
12. 联想无法覆盖强真实 Evidence；新真实证据与联想冲突时，以真实证据为准。

## 5. 固定技术栈

除非权威文档明确修改，否则不要自行替换主技术栈。

### UI / Desktop
- Tauri 2
- React
- TypeScript
- Vite
- Zustand
- TanStack Query

### 3D
- Three.js
- React Three Fiber
- Drei
- Rapier
- WebGPU 优先，WebGL 回退

### Core
- Rust
- tokio
- serde
- sqlx（SQLite 数据访问与 Migration）
- petgraph
- tracing
- uuid
- blake3
- reqwest

### Vision / AI Worker
- Python
- PyTorch
- PyCOLMAP / COLMAP
- OpenCV
- Open3D
- GTSAM
- gsplat
- Nerfstudio（实验 / 参考路径）
- trimesh

### 数据与工具链
- SQLite
- 本地内容寻址 Artifact Store
- 前端包管理：pnpm
- Python 包管理：uv
- Rust：cargo
- 跨语言统一命令：just

不要同时引入 npm / yarn / bun 等第二套前端包管理器，也不要为同一目的重复建立脚本体系。

## 6. Monorepo 原则

保持单仓库。模块化不等于微服务化。

推荐目录：

    888/
    ├─ apps/
    │  └─ desktop/
    ├─ core/
    ├─ workers/
    │  ├─ vision/
    │  └─ tools/
    ├─ packages/
    │  ├─ schema/
    │  └─ provider-sdk/
    ├─ docs/
    ├─ testdata/
    ├─ tools/
    └─ AGENTS.md

默认不要新增 Kafka、Redis、Kubernetes、独立网络服务或新仓库，除非有明确数据证明现有本地架构无法满足需求。

## 7. Schema 单一真相源

`packages/schema/` 是跨语言协议唯一真相源。第一阶段权威格式固定为 **JSON Schema Draft 2020-12**。

必须由它生成：
- Rust types
- TypeScript types
- Python models

禁止：
- 在三种语言中各自手写同义结构。
- Worker 私自扩展正式 Schema。
- UI 保存第二套 World State。
- Provider 响应直接成为正式世界数据。

跨语言 Schema 变更顺序：

    修改 Schema
    → 生成类型
    → Migration
    → 跨语言 Fixture
    → 编译
    → 集成测试

## 8. 模块依赖硬边界

允许：

    UI
    ↓
    Command API
    ↓
    Core Service / Job Engine
    ↓
    Worker SDK
    ↓
    Worker

    Provider → Candidate
    Canonical World State → Compiler

禁止：

    UI → SQLite
    UI → Provider 原始 API
    Worker → SQLite
    Worker → 正式 World State
    Provider → 正式 World State
    Agent → Provider 原始 API
    Compiler → 修改 Canonical World State

如果实现必须越过这些边界，不要直接绕过；先重新评估设计。

## 9. Core / Worker 职责

### Rust Core 负责
- World State
- SQLite
- Revision
- Artifact Registry
- Task Graph
- Job Engine
- Provider Router
- Worker 生命周期
- Crash Recovery
- 事务
- IPC
- 权限与正式状态提交

### Python Worker 负责
- CV
- SfM / MVS
- PyCOLMAP
- GTSAM
- 深度
- 分割
- Embedding
- Matching
- Open3D
- Splat / NeRF
- AI 推理

Python Worker 返回标准 Candidate / Evidence / ValidationResult，不直接修改正式世界。

GTSAM 第一阶段留在 Python Worker；算法稳定且有性能证据后再讨论下沉。

## 10. 进程通信规则

Core 与 Worker 只传结构化小数据和 Artifact 引用。

传：Job ID、Schema 数据、Artifact ID / Hash、进度、结构化结果、结构化错误。

不传：大图片二进制、Mesh 大文件、Splat 大文件、视频大文件。大文件统一进入 Artifact Store。

## 11. AI 标准工作流程

每个任务必须执行：

    任务识别
    → 读取权威文件
    → 检查现状
    → 分析影响范围
    → 制定最小完整方案
    → 实现
    → 单元测试
    → Fixture
    → 集成测试
    → 自审
    → 独立 Review
    → 修复
    → 回归
    → 检查实际文件 / diff
    → 才能声明完成

不要在任务开始时重复研究已冻结的技术选择。

如果发现更优方案，可以提出；原方案可执行时不得擅自改道。若确需调整，先同步权威文档。

## 12. 任务拆分原则

优先垂直闭环，不优先“先铺一堆接口”。

合格示例：导入 10 张图片，其中 2 张内容重复；最终 Observation=10，Physical Asset=8；重启应用后状态一致；Fixture 通过。

不合格示例：完善导入系统。

一个任务尽量只跨必要模块，不要在普通任务中同时大改 Schema、Job Engine、Viewer、Provider、Reconstruction、Compiler。

## 13. 测试要求

### 快速测试
- 格式、Lint、Type Check
- Schema
- Rust unit
- Python unit
- TypeScript unit
- Migration
- 小 Fixture

### 完整测试
- 集成链路
- 世界状态
- 真实 Fixture
- 导出

### 重型测试
- COLMAP
- MVS
- Splat 训练
- GPU Benchmark
- 大场景性能

重型测试可进入 Nightly / Milestone，但与当前改动直接相关的 Fixture 不能省。

## 14. Fixture 是长期资产

`testdata/` 是项目能力的一部分，不是临时测试文件。

至少长期覆盖：连续房间、跳跃视角、多房间、室内 + 室外、无共同视觉区域的室内外、多楼层、单图、视频、差素材。

每修一个真实 Bug：复现 → 最小 Fixture / Test → 修复 → 回归 → 永久保留。

## 15. 架构守卫

CI / 工具脚本应自动阻止：
- 非法依赖方向
- 重复协议定义
- 未迁移 Schema
- Worker 直接访问正式数据库
- UI 直接访问数据库
- Provider 直接更新 World State
- Compiler 反向写世界状态

能机器检测的规则必须机器检测，不能只依赖文档提醒。

## 16. 统一命令入口

最终统一：

    just setup
    just check
    just test-fast
    just test
    just test-world
    just benchmark

AI 在执行前优先使用这些命令。如果命令不存在，当前基础设施阶段负责建立。

## 17. 日志与诊断

核心任务使用结构化日志，至少包含：trace_id、world_id、job_id、stage、provider、artifact_id、duration、resource_usage、result_state。

AI 故障分析优先读取结构化状态，再读取文本日志。

## 18. PR 与提交规则

- PR 标题使用中文。
- PR 描述使用中文。
- Commit message 优先中文且描述实际变化。
- 一个阶段性目标优先一个清晰 PR，不为同一小目标制造多个相互依赖 PR。
- PR 必须说明：做了什么、为什么、影响范围、验证方式、已知限制。

不得把“AI 生成代码”作为降低审查标准的理由。

## 19. 完成标准

执行了工具、写了文件、调用 API 成功、测试命令退出 0，都不自动等于完成。

完成必须满足：

    实现
    → 检查实际结果
    → 发现问题
    → 修复
    → 再验证
    → 相关回归
    → 确认闭环

声明完成前至少确认：用户要求全部落实、修改实际存在于目标分支、必须测试实际运行、Fixture 实际通过、数据 / Migration 正确、调用链没有断、没有相关回归。

无法验证的项目必须明确写“未验证”，不能推断成功。

## 20. 优先级

当多个问题同时出现：
1. 会导致数据错误 / 世界真相污染的问题。
2. 会破坏核心调用链的问题。
3. 会造成错误世界关系的问题。
4. 会造成回归的问题。
5. 性能问题。
6. UI / 体验细节。

始终围绕当前任务主线推进，不擅自扩大范围。

## 21. 最终目标

AI 的职责不是“尽快生成更多代码”。

888 的目标是：通过可追溯的证据、明确的不确定性、稳定的世界状态、可替换的算法能力和自动验证闭环，持续收敛出一个可信的数字世界。

任何技术捷径如果破坏这一目标，都不接受。
