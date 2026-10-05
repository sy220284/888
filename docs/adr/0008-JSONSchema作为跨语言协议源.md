# ADR 0008：采用 JSON Schema Draft 2020-12 作为跨语言协议源

- 状态：已接受
- 日期：2026-10-05

## 背景

888 需要在 Rust、TypeScript、Python 三层共享 Observation、Evidence、Candidate、Task 等结构。

如果“JSON Schema / IDL”长期保持开放，会导致 AI 重新选择 Protobuf、OpenAPI 或手写类型。

## 决策

第一阶段 packages/schema/ 统一使用 **JSON Schema Draft 2020-12**。

通过 Codegen 生成：

- Rust types
- TypeScript types
- Python models

## 原因

- 与 JSONL Worker 协议天然兼容。
- 易于保存 Fixture。
- 易于做 Schema Validation。
- 人和 AI 都容易审阅。
- 可以独立于具体编程语言。

## 约束

- 正式字段必须先改 Schema。
- Breaking Change 必须升级 Schema Version。
- 三语言生成结果必须跑一致性 Fixture。
- 不允许手工维护第二套正式协议结构。