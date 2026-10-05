# 888 Rust Core（首批 Runtime 重写）

本目录承接原 `neilsonnn/image-blaster` 中不应继续留在 Node `.mjs` Runtime 的能力。

本次已重写：

| Image Blaster 旧逻辑 | 888 Rust Core |
|---|---|
| `fal-queue.mjs` | `provider/fal.rs` |
| `fal-3d-provider.mjs` | `provider/image_to_3d.rs` |
| `hunyuan-3d.mjs` | `provider/hunyuan.rs` |
| `meshy-3d.mjs` | `provider/meshy.rs` |
| `request-metadata.mjs` | `provider_run_repository.rs` + SQLite |
| `ensure-local-assets.mjs` | `artifact_store.rs` + BLAKE3 内容寻址 |
| `project-state.mjs` 项目身份部分 | `project_repository.rs` + SQLite |

`project-state.mjs` 中通过扫描目录推断 `has_world / has_scene / object_counts` 的行为没有迁移。888 后续由 Canonical World State 与 Job State 提供这些事实，禁止重新引入“扫文件猜状态”。

## 关键边界

- Provider 私有结构止步于 Adapter。
- Provider 输出只进入 Artifact / Candidate / Proposal 链。
- 大型产物下载后立即进入本地 Artifact Store。
- Provider Run 元数据进入 SQLite，base64 / data URI 不写入数据库。
- 项目身份进入 SQLite；世界状态不从目录结构反推。
- 正式跨语言协议以 `packages/schema/` 为唯一来源。

## 校验

仓库统一入口：

```bash
just check
just test-fast
```

CI 还会执行 Rust format、Clippy 和完整 workspace test。
