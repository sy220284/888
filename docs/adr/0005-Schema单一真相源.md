# ADR 0005：跨语言 Schema 采用单一真相源

- 状态：已接受
- 日期：2026-10-05

## 背景

Rust、TypeScript、Python 都需要读取 Observation、Evidence、Candidate、Job 等核心结构。

人工维护三套类型会随着 AI 高频开发迅速漂移。

## 决策

packages/schema/ 成为跨语言协议唯一权威定义。

通过 codegen 生成 Rust types、TypeScript types、Python models。

## 规则

Schema → Codegen → Migration → 跨语言 Fixture → Compile → Test。

禁止先修改某一种语言再人工补另外两种。

## 原因

- 防止字段漂移。
- AI 更容易判断权威来源。
- Schema 兼容可以自动检查。
- Breaking Change 可明确版本化。

## 后果

阶段 0 必须优先完成 Schema 工具链与生成器，否则不进入大规模功能开发。