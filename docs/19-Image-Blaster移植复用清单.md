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
| Pointer Guard | `apps/desktop/src/viewer/pointerGuards.ts` | 保留对象交互后短时抑制 Pointer Lock | 已迁 |
| Object Hover Guides | `apps/desktop/src/viewer/ObjectHoverGuides.tsx` | 保留包围框与 XYZ 方向辅助 | 已迁 |
| Origin Helper | `apps/desktop/src/viewer/OriginHelper.tsx` | 去 Debug Store，改显式 visible | 已迁 |
| Asset Materials | `apps/desktop/src/viewer/useAssetMaterials.ts` | 保留 Wireframe / Shaded 调试材质 | 已迁 |

## 3. 第二批：高价值，等新状态边界后迁

### PlacementEditor

复用 TransformControls、移动/旋转/缩放、Undo/Redo、复制删除、地面吸附、光照与尺度编辑。

必须先移除 `scene.json`、旧 `WorldSceneProject` 和 Vite 文件写入 API。

目标链路：

    Editor Intent
    → Command API
    → Core
    → WorldRevision

状态：**Entity / Revision Command 前置已完成，进入 Editor 迁移阶段。**

### 888 当前 Editor Command 基础

当前已具备：

- `UPDATE_ENTITY_TRANSFORM`：Entity Transform 与 WorldRevision 同事务提交。
- `DELETE_ENTITY`：软删除，保留历史 Revision / Geometry / Provenance。
- `DUPLICATE_ENTITY`：复制 Entity，并复用原 Geometry Artifact 引用生成新的 GeometryRepresentation。
- Command 执行租约与崩溃重放：同一 `command_id` 不重复执行副作用。
- Tauri `execute_command / get_world / list_entities / get_entity` Core Bridge。

因此旧 PlacementEditor 不再允许写 `scene.json`；迁移时只保留交互与 Undo/Redo 意图，由 Core Command 负责正式提交。

### Object Grab / Physics Interaction

复用 Rapier Joint 抓取、释放速度、Pointer Picking、刚体交互。

状态：**高优先级待迁。**

### CharacterController

复用第一人称行走、Capsule Collider、跳跃、地面检测和触摸摇杆。

状态：**待 Collider / Entity 边界稳定后迁。**

### PostProcessing

复用：

- Bloom
- Chromatic Aberration
- Motion Blur
- Tone Mapping
- React 19 下绕过 wrapEffect 循环引用的实现经验

要求：

- 去掉旧 Debug Store。
- 改为 Viewer Quality / Display Profile 显式配置。
- 真实性验证视图默认关闭会改变感知结果的视觉特效。

状态：**后置迁移。**

### Mobile Touch Controls

上游 `TouchControls.tsx` 可复用移动端左侧虚拟摇杆反馈和触摸状态管理。

需要改：

- 去掉旧 Debug Store。
- 去掉 Tailwind 强绑定。
- 与 888 Navigation Controller 统一输入协议。

状态：**待导航控制层稳定后迁。**

### Camera Focus / Dolly

上游：

- `cameraFocus.ts`
- `useCameraDollyGestures.ts`

可复用：

- 对象点击后相机自动朝向目标。
- 编辑器右键 / 双指 Dolly。

其中全局 mutable ref 形式不保留，改为 Viewer Controller 状态。

状态：**待 Editor / Selection Controller 后迁。**

### Viewer Mode Hotkeys

上游 `BottomLeftControls.tsx` 中的快捷键思路值得保留：

- World / Object 显示模式切换。
- Wireframe / Shaded / Lit。
- Quality Mode。

UI 组件本身与旧 Store、Radix、图标库耦合较高，不直接迁。

状态：**交互规则复用，UI 后续重做。**

## 4. Provider 逻辑：复用逻辑，不原样搬 Node CLI

### FAL Queue / 3D Provider

保留 submit/poll、request id、错误处理、远程文件发现下载、data URI 适配。

目标：

    Canonical Capability Request
    → Provider Adapter
    → Provider 私有请求
    → AIOutputEnvelope
    → Candidate / Artifact

状态：**Rust Core 重写完成：FAL submit / poll / result、Provider Run、Artifact 落盘均已接入。统一 Router 属于 888 平台层后续扩展，不再依赖旧 Node Runtime。**

### Hunyuan / Meshy

保留模型参数校验、默认值、Endpoint 与 PBR / 面数 / LowPoly 参数映射。

状态：**Hunyuan / Meshy Rust Adapter 已迁，参数默认值与合法性校验已保留。**

### World Labs

保留 operation poll 与 SPZ/collider/pano/thumbnail 资产映射。

禁止把 World Labs World 类型作为 888 世界模型。

状态：**已重写为 Rust `provider/world_labs.rs`，保留 operation poll 与世界资产下载，输出统一进入 Artifact / AIOutputEnvelope。**

### Image Edit / SFX

GPT Image 2、Nano Banana、ElevenLabs SFX 已重写为 Rust Provider Adapter：图像编辑统一进入 `IMAGE_EDIT`，SFX 进入 `SFX_GENERATION`；SFX 的 FFmpeg 处理改为原始音频与处理后音频两个不可变 Artifact。

### generate-single-asset

旧 `generate-single-asset.mjs` 的“参考图生成 → 3D 模型生成”核心链路已重写为 Rust `AssetGenerationService`。

新实现只编排 Artifact 与 Provider Run，不再写 `object.json`、不按目录编号恢复状态，也不把对象文件当世界真相。

状态：**Runtime 重写完成。**

### World Loader

上游 `worldLoader.ts` 中“只允许本地世界资产 URL、拒绝直接使用 Provider CDN URL”的边界值得保留。

旧 `virtual:worlds` 和 World Labs 私有类型不迁。

目标由 888 Artifact Resolver / Local Artifact Store 承担。

状态：**只吸收安全边界与测试思路。**

## 5. 只吸收思想

- Request Metadata → `AIProviderRun + Artifact Provenance`：**基础实现已完成，写入 SQLite，并剥离 data URI / base64。**
- Local-first Asset → Artifact Store + BLAKE3 + SQLite Artifact Registry：**基础实现已完成，Provider 产物下载后进入内容寻址本地存储。**

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
- **M2 Editor：Entity / Revision Command 前置已完成；PlacementEditor / Object Grab 正式进入迁移阶段。**
- **M3 Provider Runtime 重写：已完成。** FAL/Hunyuan/Meshy、World Labs、GPT Image 2、Nano Banana、ElevenLabs SFX、Provider Run、Artifact Store、单资产生成编排均已有 Rust 替代实现；统一 Router 后续按 888 平台计划继续增强。
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
