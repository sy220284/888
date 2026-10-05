# ADR 0003：GTSAM 第一阶段保留在 Python Worker

- 状态：已接受
- 日期：2026-10-05

## 背景

空间约束与多假设求解需要 Factor Graph。GTSAM 可以从 C++ / Python 使用，也可以尝试与 Rust 深度绑定。

## 决策

第一阶段通过 Python Worker 使用 GTSAM，不优先开发 Rust ↔ C++ FFI。

## 原因

- 与 PyCOLMAP、Open3D、PyTorch 位于同一算法环境。
- 数据调试方便。
- AI 开发时上下文更集中。
- 避免过早承担复杂 Native 构建。
- 当前瓶颈在算法质量，尚无证据表明 Python 调用层是性能瓶颈。

## 何时重新评估

- 实测 Python 调度成为主要性能瓶颈。
- Solver 需要与 Rust Core 高频低延迟交互。
- GTSAM 逻辑已经稳定且长期不再快速变化。

## 后果

Core 只接收标准 Constraint / Solver Result，不感知 GTSAM 内部类型。