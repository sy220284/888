# DeepSeek Harness 2.0：干净代码结构与领域边界

> 本文用于升级期的架构导航。第一阶段不大规模移动现有目录；先收束依赖方向，再逐步迁移物理路径。

## 1. 当前仓库的干净物理骨架

运行：

```bash
node scripts/print-clean-code-tree.mjs
```

可得到过滤 `node_modules`、构建产物、测试、快照与缓存后的源码树。当前真正的产品代码由以下部分组成：

```text
deepseek-harness/
├── apps/
│   ├── cli/
│   └── web/
├── packages/
│   ├── core/           # Agent / Session / Tool / Scope / System Prompt
│   ├── llm/            # 模型运行时、供应商、重试、计量
│   ├── context/        # 动态上下文来源
│   ├── compaction/     # 上下文压缩
│   ├── goal/           # 目标
│   ├── plan/           # 计划模式
│   ├── workflow/       # 工作流与工作线程
│   ├── subagent/       # 子代理与外部代理兼容
│   ├── experimental/   # Agent Team 等实验能力
│   ├── schedule/       # 会话内调度
│   ├── jobs/           # 后台任务
│   ├── skill/          # 技能
│   ├── hooks/          # Claude Code / Codex Hooks 兼容
│   ├── interaction/    # 批准、问题、权限预设
│   ├── sandbox/        # 沙箱策略与实现
│   ├── subprocess/     # 子进程
│   ├── shell/          # Shell
│   ├── fs/             # 文件系统
│   ├── terminal/       # 终端
│   ├── code-runtime/   # 代码运行时
│   ├── lsp/            # 语言服务器
│   ├── mcp/            # MCP
│   ├── session/        # 会话持久化与投影
│   ├── session-query/  # 会话检索
│   ├── storage/        # 通用存储
│   ├── credentials/    # 凭证
│   ├── api/            # 网关与远程 API
│   ├── client/         # Web 客户端能力与 UI
│   ├── host/           # Host 服务
│   ├── extensions/     # Cordis/UI 扩展
│   ├── sdk/            # SDK
│   └── ...             # 附件、工作区、工具等横向能力
├── native/
│   └── landlock-run/   # 现有原生安全执行组件
├── python/
│   ├── sdk/
│   └── sdk-runtime/
├── scripts/
└── docs/
```

完整细树由 `scripts/print-clean-code-tree.mjs` 自动生成，不在本文重复数百行。

## 2. Harness 2.0 的六大逻辑域

现有五十多个 `packages/*` 不立即搬家，但所有新功能必须先归入以下六个逻辑域。

```text
Kernel
├── Context
├── Service
├── Scope
├── RuntimeEffect
├── Event
├── Lifecycle
└── Identity

Core
├── Session
├── Turn
├── Step
├── Agent Runtime
├── Tool Runtime
├── Artifact
└── Storage

Intelligence
├── Model Registry / Router
├── Context Engine
├── Compaction
├── Recovery
├── Memory
└── Skill

Autonomy
├── Goal
├── Task Graph
├── Plan
├── Agent Graph
├── Team
├── Workflow
├── Automation
└── Learning

Execution
├── Execution World
├── Capability Permission
├── Approval
├── Resource Scheduler
├── Sandbox
├── Process / PTY / Shell / FS / Network
└── Computer Use

Integration
├── Hooks
├── MCP
├── ACP
├── Gateway
├── LSP
├── Plugins
└── App Server
```

## 3. 不允许出现的依赖方向

```text
Kernel      -> UI / Provider / Gateway      禁止
Core        -> Desktop / Telegram           禁止
Session     -> Claude / OpenAI Provider     禁止
Tool Runtime-> React UI                     禁止
Memory      -> Electron                     禁止
Execution   -> Goal / Workflow / Skill      禁止
```

允许的总体方向：

```text
Kernel
  ↑
Core
  ↑
Intelligence / Autonomy / Execution / Integration
  ↑
Plugins / Product Assembly
  ↑
Apps
```

## 4. 唯一运行时原则

Harness 2.0 只允许一个 Agent/Session 真相源：

```text
Harness SessionEvent
        +
Harness Agent Runtime
        +
Cordis Capability Seam
```

Codex、Hermes、Claude Code、cc-haha 均只能以以下形式进入：

```text
Service
Provider
Hook
Skill
Agent Template
Workflow Compiler
ExecutionWorld
Compatibility Adapter
```

禁止引入第二套 Thread、第二套 Session、第二套 Agent 主循环。

## 5. 三平面

```text
Control Plane
Desktop / Web / CLI / TUI / IDE / H5 / Gateway
                    │
                    ▼
Intelligence Plane
DeepSeek Harness：Agent / Session / Context / Model / Memory /
Skill / Goal / Team / Workflow / Automation / Learning
                    │
                    ▼
Execution Plane
Rust Native Core：Process / PTY / FS / Network / Sandbox /
Permission Enforcement / Computer / Artifact / Cancellation
```

Rust 层只处理执行事实，不理解 Goal、Memory、Skill 或模型语义。

## 6. P0 首个落地：Step Snapshot

Harness 原有 `request/header` 与 `request/context` 已经可以重建请求状态，但缺少一个明确的“本次模型请求冻结边界”。

Harness 2.0 新增：

```text
step/snapshot
├── turn
├── step
├── attempt
├── agentId
├── surfaceSeqs
└── refs
    ├── requestHeader
    └── requestContext
```

语义：

1. 每次真正准备模型请求时写入；
2. 同一 Step 发生请求重试时，`attempt` 递增；
3. `surfaceSeqs` 锁定本次请求的模型可见消息表面；
4. `refs` 指向本次请求使用的权威 `request/header` 与 `request/context`；
5. Session invariant 验证引用必须指向最新权威状态。

未来 Permission、Budget、ExecutionWorld、ResolvedConfig 等能力只需继续向 Step Snapshot 扩展权威引用，不需要再创建另一套请求快照系统。
