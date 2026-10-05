# ADR 0007：第一阶段 Worker 使用 stdio + JSONL 通信

- 状态：已接受
- 日期：2026-10-05

## 背景

Rust Core 与 Python Worker 需要双向通信。候选包括 stdio、local socket、gRPC 等。

## 决策

第一阶段固定采用：

- stdin/stdout 双向通信
- JSON Lines（JSONL）消息 framing
- stdout 只传协议消息
- stderr 只传日志
- 大文件只传 Artifact 引用

## 原因

- 本地应用实现简单。
- 跨平台。
- AI 易于调试。
- 与 Artifact Store 结合后无需传输大二进制。
- 当前没有证据需要更复杂的 IPC。

## 重新评估条件

只有 Benchmark 证明 stdio 吞吐成为瓶颈、并发 Worker 数量导致调度问题，或需要独立进程长连接能力时，才评估 local socket 或其他传输。

## 后果

所有协议消息必须可单行 JSON 序列化，并包含 protocol_version 与请求 / Job 标识。