# 888 Schema

跨语言协议唯一真相源。第一阶段固定使用 JSON Schema Draft 2020-12。

本次 Image Blaster Runtime 重写先补齐 Provider / Artifact / Project 相关 Schema，Rust Core 不接收旧 `.mjs` 的私有状态结构。

当前 Schema：

- `provider/artifact.schema.json`
- `provider/canonical-capability-request.schema.json`
- `provider/ai-output-envelope.schema.json`
- `provider/ai-provider-run.schema.json`
- `provider/project.schema.json`

后续 codegen 必须从这里生成 Rust / TypeScript / Python 正式协议类型；不得把 Provider 私有响应结构提升为正式 Schema。
