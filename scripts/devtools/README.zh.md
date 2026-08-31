# 开发环境脚本

[English](README.md) | 中文

`dev.mjs` 是 Node 可用后的统一命令路由。`bootstrap.sh` 与 `bootstrap.ps1` 保持低依赖，负责在 Node 尚未安装时下载并校验固定版本 Node，然后进入统一命令层。

开发工具获取与摘要校验由 bootstrap 层负责；项目依赖仍分别由 pnpm、Cargo、uv 按已提交锁文件安装；项目质量检查由 `run-checks`、Rust 检查和 Python 检查负责。
