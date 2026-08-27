# native/

English | [中文](README.zh.md)

Native source maintained with DeepSeek Harness.

- [`landlock-run/`](landlock-run/README.md) owns the Linux Landlock self-restrict-then-exec launcher and its npm packaging family.
- [`execution-core/`](execution-core/README.md) is the P2 native execution sidecar. Its first milestone owns executable lookup, ordinary process creation, Unix detached process groups, parent-death signalling on Linux, and tree-scoped signals behind a JSONL protocol.

Native build/release automation is no longer driven by repository GitHub Actions in this fork. Build and packaging commands remain source-controlled, but execution is an explicit developer/release operation.
