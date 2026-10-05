# 19 Image Blaster 移植复用清单

## 1. 定位

本清单固定 `neilsonnn/image-blaster` 到 888 的复用边界。

上游审计基线：

- 仓库：`neilsonnn/image-blaster`
- 快照：`4acb43ba126a12358f71838d1b1a05e856b10eaf`
- 许可证：MIT

原则：**复用成熟能力，淘汰旧架构边界。**

## 2. 第一批已完成迁移

| 上游能力 | 888 位置 | 处理 | 状态 |
|---|---|---|---|
| SplatRenderer | `apps/desktop/src/viewer/SplatRenderer.tsx` | 去旧 Debug Store，保留 Spark/SPZ、LOD、尺度与翻转 | 已迁 |
| WorldCollider | `apps/desktop/src/viewer/WorldCollider.tsx` | 去 RenderMode/DropTarget 耦合，保留 GLB + Rapier | 已迁 |
| GroundPlane | `apps/desktop/src/viewer/GroundPlane.tsx` | 简化为基础物理地面与安全网 | 已迁 |
| Camera Gesture | `apps/desktop/src/viewer/useCameraGestures.ts` | 保留鼠标、触控板、双指手势 | 已迁 |
| FlyController | `apps/desktop/src/viewer/FlyController.tsx` | 去旧 Store/Focus 全局状态 | 已迁 |
| EnvironmentMap | `apps/desktop/src/viewer/EnvironmentMap.tsx` | 保留全景环境与强度控制 | 已迁 |
| AudioManager | `apps/desktop/src/viewer/AudioManager.tsx` | 去 Zustand，改显式 muted | 已迁 |
| Optional Asset Boundary | `apps/desktop/src/viewer/OptionalAssetBoundary.tsx` | 保留资产失败隔离 | 已迁 |
| WorldViewer 组合 | `apps/desktop/src/viewer/WorldViewer.tsx` | 改成 Provider 无关 Viewer | 已迁 |
| 原 World 类型入口 | `apps/desktop/src/viewer/worldViewModel.ts` | 替换 World Labs 私有类型 | 已迁 |
| 前端工程骨架 | `apps/desktop` | bun 改为 pnpm workspace | 已完成 |

## 3. 第二批：高价值，等新状态边界后迁

### PlacementEditor

复用 TransformControls、移动/旋转/缩放、Undo/Redo、复制删除、地面吸附、光照与尺度编辑。

必须先移除 `scene.json`、旧 `WorldSceneProject` 和 Vite 文件写入 API。

目标链路：

    Editor Intent
    → Command API
    → Core
    → WorldRevision

状态：**待 Entity / Revision Command Schema 后迁。**

### Object Grab / Physics Interaction

复用 Rapier Joint 抓取、释放速度、Pointer Picking、刚体交互。

状态：**高优先级待迁。**

### CharacterController

复用第一人称行走、Capsule Collider、跳跃、地面检测和触摸摇杆。

状态：**待 Collider / Entity 边界稳定后迁。**

### PostProcessing

复用后处理参数与视觉质量能力；不能影响真实性验证默认渲染。

状态：**后置迁移。**

## 4. Provider 逻辑：复用逻辑，不原样搬 Node CLI

### FAL Queue / 3D Provider

保留 submit/poll、request id、错误处理、远程文件发现下载、data URI 适配。

目标：

    Canonical Capability Request
    → Provider Adapter
    → Provider 私有请求
    → AIOutputEnvelope
    → Candidate / Artifact

状态：**待 Provider SDK / Core 接口后重写迁移。**

### Hunyuan / Meshy

保留模型参数校验、默认值、Endpoint 与 PBR / 面数 / LowPoly 参数映射。

状态：**待迁。**

### World Labs

保留 operation poll 与 SPZ/collider/pano/thumbnail 资产映射。

禁止把 World Labs World 类型作为 888 世界模型。

状态：**作为 WORLD_GENERATION Provider 待迁。**

### Image Edit / SFX

GPT Image Edit、Nano Banana、ElevenLabs SFX 映射到 Capability 后迁。

## 5. 只吸收思想

- Request Metadata → `AIProviderRun + Artifact Provenance`。
- Local-first Asset → Artifact Store + BLAKE3 + SQLite Artifact Registry。

## 6. 明确不迁

| 原实现 | 决策 |
|---|---|
| `.claude/agents/*` | 不进入 Runtime |
| `.claude/skills/*` | 不进入 Runtime |
| Claude 固定执行顺序 | Task Graph / Job Engine 替代 |
| `project-state.mjs` 文件扫描状态机 | SQLite / Job State 替代 |
| `scene.json` 世界真相 | Revision / Canonical World State 替代 |
| 原 `world.ts` Provider 私有类型 | 不迁 |
| bun workspace | 不迁 |
| Butterfly Demo | 仅可作为后续 Fixture |

## 7. 迁移顺序

- **M1 Viewer 基础：已完成。**
- **M2 Editor：等待 Entity / Revision Command Schema。**
- **M3 Provider Adapter：等待 Provider SDK / CanonicalCapabilityRequest。**
- **M4 PostProcessing / Character / Demo Fixture：后置。**

## 8. 每个迁移模块验收

1. 无 `.claude` Runtime 依赖。
2. 无 bun 依赖。
3. 无 Provider 私有类型渗透 UI/Core。
4. 不直接写 World State。
5. 符合 888 Schema 方向。
6. 保留 MIT 声明。
7. 有最小 Test/Fixture。
8. 迁移后能力不低于对应上游核心行为。
