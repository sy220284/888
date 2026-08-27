# native/

[English](README.md) | 中文

与 DeepSeek Harness 一同维护的原生源码。

- [`landlock-run/`](landlock-run/README.zh.md) 负责 Linux Landlock 自限后执行启动器及其 npm 包装家族。
- [`execution-core/`](execution-core/README.zh.md) 是 P2 原生执行侧车。第一阶段负责可执行文件解析、普通进程创建、Unix detached 进程组、Linux 父死亡信号以及通过逐行 JSON 协议暴露的整树信号。

本分支不再由仓库 GitHub Actions 驱动原生构建/发布。构建和打包命令仍保存在源码中，但执行改为开发者/发布流程显式触发。
