## 目标

<!-- 说明本 PR 解决什么问题，以及为什么现在需要做。 -->

## 影响范围

<!-- 列出涉及的模块、Schema、Migration、Runtime、UI 或 Worker。 -->

## 实现说明

<!-- 说明关键设计、调用链和边界变化。 -->

## 验证

- [ ] 已运行相关 Schema / Codegen 校验
- [ ] 已运行 Rust / TypeScript / Python 相关测试
- [ ] 已验证 Migration / 持久化结构
- [ ] 已验证实际调用链没有断
- [ ] 已检查回归与边界条件
- [ ] CI 全绿

## 架构边界

- [ ] 没有 UI → SQLite / Provider 原始 API
- [ ] 没有 Worker → SQLite / Canonical World State
- [ ] 没有 Provider → Canonical World State
- [ ] 没有恢复 `.claude` Runtime、bun、`scene.json / project.json` 状态源
- [ ] 跨语言正式结构先修改 `packages/schema`，再生成 Rust / TypeScript / Python 类型
- [ ] Candidate / Proposal 未绕过 Validation / Revision 进入正式世界

## 已知限制

<!-- 无则写“无”。不要把未验证事项描述为已完成。 -->
