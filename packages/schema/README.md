# 888 Schema

跨语言协议唯一真相源。第一阶段固定使用 JSON Schema Draft 2020-12。

本次 Image Blaster Runtime 重写先补齐 Provider / Artifact / Project 相关 Schema，Rust Core 不接收旧 `.mjs` 的私有状态结构。

当前 Schema：

- `provider/artifact.schema.json`
- `provider/canonical-capability-request.schema.json`
- `provider/ai-output-envelope.schema.json`
- `provider/ai-provider-run.schema.json`
- `provider/project.schema.json`

已建立统一 codegen：

```bash
python tools/generate_schema_types.py
python tools/generate_schema_types.py --check
```

生成位置：

- Rust：`core/src/model/generated.rs`
- TypeScript：`apps/desktop/src/generated/schema.ts`
- Python：`workers/sdk/generated_models.py`

CI 会校验生成物与 Schema 完全一致。正式字段必须先改 Schema，再重新生成三语言类型；不得手写第二套同义协议结构，也不得把 Provider 私有响应结构提升为正式 Schema。
