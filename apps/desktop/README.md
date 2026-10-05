# 888 Desktop 前端骨架

这是从 `neilsonnn/image-blaster` 中筛选并按 888 架构改造后的第一批可复用 Viewer 能力。

当前已落地：

- Provider 无关 `WorldViewModel`
- Gaussian Splat 渲染
- GLB / Mesh Collider
- Fly Camera
- 鼠标、触控板、触摸手势
- 环境全景贴图
- 环境音频
- Rapier Ground Plane
- 可选资产加载失败隔离

开发：

```bash
pnpm install
pnpm dev:desktop
```

可以用查询参数快速挂载开发服务器可访问的资产：

```text
?splat=/demo/world.spz&collider=/demo/world.glb&pano=/demo/pano.jpg&scale=1&ground=0&flipY=false
```

正式世界数据后续必须由 Core / Schema DTO 适配进入，不能把 Provider 原始响应直接传到 UI。
