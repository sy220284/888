# ADR 0006：Core 使用 SQLx 访问 SQLite

- 状态：已接受
- 日期：2026-10-05

## 背景

888 的 Rust Core 需要负责 SQLite、事务、Migration、Job Engine 与 World State。早期文档曾保留 SQLx / rusqlite 两种候选，这会让 AI 开发产生重复实现路径。

## 决策

第一阶段统一使用 **SQLx + SQLite**。

## 原因

- 与 Tokio 异步 Core 结构一致。
- 具备 Migration 与连接池能力。
- 适合统一事务边界。
- 能减少数据库访问层的技术分叉。

## 放弃方案

### rusqlite

本身成熟可靠，但如果同时保留会形成两套数据库访问范式。

## 约束

- Worker 不直接访问 SQLite。
- UI 不直接访问 SQLite。
- 所有正式数据写入通过 Core Service。
- Migration 由 Core 统一管理。