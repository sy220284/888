# 888 Tests

- `tests/python/`：Worker SDK、Fixture/Benchmark 等无外部依赖基础测试。
- Rust 单元与集成测试优先放在对应 crate 内或 crate 的 `tests/`。
- Desktop 使用 Vitest。
- 真实世界效果测试由 `testdata/` + `tools/benchmark.py` 驱动。
