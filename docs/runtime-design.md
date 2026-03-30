# Runtime Design

## 1. 目标

运行时需要解决以下问题：

- 将调用方输入转成可执行的 run
- 保证 per-session 串行执行
- 自动发现 workspace 能力并构建上下文
- 将 LLM tool calls 映射到 Action、Skill、MCP、Native Tool
- 统一处理超时、取消、日志、审计和事件流

## 2. Run 生命周期

### 2.1 主要阶段

1. 接收请求
2. 持久化 message
3. 创建 run
4. 入 session 队列
5. 获取 session 锁
6. 构建上下文
7. 执行 hook
8. 启动 LLM loop
9. 分发 tool call
10. 汇总结果并输出
11. 更新 run 状态
12. 发布 SSE 事件

### 2.2 状态流转

建议的 `run.status`：

- `queued`
- `running`
- `waiting_tool`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

### 2.3 Agent Control Flow

同一 run 内允许出现两类 agent 控制动作：

- `agent.switch`
  - 在当前 run 内切换 `effective_agent_name`
- `agent.delegate`
  - 在后台创建子 session / 子 run 调用 subagent

建议约束：

- `agent.switch` 不创建新的主 run
- `agent.delegate` 创建新的子执行单元，但当前主 run 可继续或等待结果
- 两者都必须经过 orchestrator 校验 allowlist 和 policy

## 3. Context Engine

### 3.1 输入

- workspace 元数据
- workspace settings
- session 历史消息
- 当前 agent 定义
- 平台级模型入口清单
- workspace 级模型入口清单
- `AGENTS.md`
- `.openharness` 目录中的声明式配置
- 平台默认配置
- `settings.skill_dirs` 解析出的额外 skill roots
- `.openharness/settings.yaml`

### 3.2 输出

- 系统 prompt
- 对话历史
- 模型参数与 model entry 解析结果
- 允许暴露给 LLM 的 tools 列表
- 运行策略
- hook 管道

### 3.3 上下文装配顺序

建议顺序：

1. 平台默认 system prompt
2. workspace `system_prompt.base`
3. workspace `system_prompt.llm_optimized`
4. agent 主 prompt
5. `AGENTS.md` 项目说明
6. skills 摘要
7. session 历史消息
8. agent 激活或切换时的 `<system_reminder>`
9. 当前消息输入

其中 `<system_reminder>` 的触发规则建议为：

- session 创建时显式指定 agent
- 当前 run 的 `agent_name` 与上一轮 active agent 不同
- 同一 agent 连续执行时默认不重复注入
- run 内发生 `agent.switch`，且 `effective_agent_name` 改变

## 4. Registry 与 Projection

### 4.1 独立注册表

运行时分别维护：

- `AgentRegistry`
- `ModelRegistry`
- `ActionRegistry`
- `SkillRegistry`
- `McpRegistry`
- `HookRegistry`
- `NativeToolRegistry`

### 4.2 Tool Exposure

在每次 run 启动时：

1. 根据 agent 配置解析 `model_ref`
2. 根据 agent 配置解析可用的 native tools
3. 解析可用的 actions 元数据
4. 解析可用的 skills 元数据
5. 解析 `mcp/settings.yaml` 和本地 server 目录
6. 将上述能力投影为模型可消费的 tool definitions

`model_ref` 解析规则：

- `model_ref` 指向一个具体模型入口
- 该入口已经包含 `provider`、`key`、`url`、`name`
- agent 不再覆盖入口中的模型名

Agent 采用 Markdown 目录注册：

- 从 `agents/*.md` 读取 agent 定义
- 文件名作为默认 agent 名称
- frontmatter 承载少量结构化字段
- Markdown 正文作为 agent 主 prompt
- `system_reminder` 为可选字段，用于 agent 激活或切换时注入额外系统提示

frontmatter 建议字段：

- `mode`
- `model`
- `description`
- `system_reminder`
- `tools`
- `switch`
- `subagents`
- `policy`

`system_reminder` 注入建议：

- 运行时统一包装为 `<system_reminder>...</system_reminder>`
- 可叠加平台默认提醒和 agent 自定义提醒
- 注入位置应晚于历史消息装配、早于当前消息输入

agent 间控制建议：

- `agent.switch`
  - 用于同一 run 内切换到另一个 agent
  - 目标 agent 必须命中当前 agent 的 `switch` allowlist
- `agent.delegate`
  - 用于调用后台 subagent
  - 目标 agent 必须命中当前 agent 的 `subagents` allowlist
- `mode`
  - 用于标记某个 agent 是 `primary`、`subagent` 还是 `all`

执行结果建议沉淀为：

- `Run.effective_agent_name`
- `Run.switch_count`
- `RunStep(step_type=agent_switch)`
- `RunStep(step_type=agent_delegate)`

Skill 采用按需加载：

- 发现阶段优先读取 `SKILL.md` frontmatter 中的元数据
- 若无 frontmatter，则从目录名和正文中推断基础元数据
- 激活阶段再加载完整 `SKILL.md`
- `scripts/`、`references/`、`assets/` 中的内容仅在需要时加载
- 默认扫描 `.openharness/skills/*`
- 可从 `settings.skill_dirs` 追加额外 skill 根目录

MCP 采用集中式注册：

- 从 `mcp/settings.yaml` 读取 server 定义
- 本地 server 按 `command` 启动，支持 `string | string[]`
- 远程 server 通过 `url` 连接

Action 采用目录式注册：

- 从 `actions/*/ACTION.yaml` 读取 action 定义
- action 入口统一使用 `command`
- `command` 支持 `string | string[]`
- shell 命令和本地脚本都通过 `command` 表达

### 4.3 Invocation Routing

模型发出 tool call 后：

1. 校验 tool name 是否存在
2. 查找其真实来源类型
3. 构建统一 `InvocationContext`
4. 路由到对应执行器
5. 回收结构化结果并作为 tool message 回填模型

## 5. 执行器模型

### 5.1 统一调用协议

无论能力来源如何，内部都遵循统一的调用协议：

- `tool_name`
- `arguments`
- `source_type`
- `invocation_context`
- `result`

### 5.2 分类型执行器

- `NativeToolExecutor`
  - 执行 shell / file 等内建能力
- `ActionExecutor`
  - 执行命名任务入口
- `SkillExecutor`
  - 执行技能型能力
- `McpExecutor`
  - 调用 MCP server 对应工具

### 5.3 Action 与 Skill 的区别

Action：

- 偏命名任务入口
- 审计边界更强
- 更容易被调用方和 API 直接触发

Skill：

- 偏能力封装
- 更强调某类工作的执行方法
- 仍可被直接暴露给 LLM 调用

## 6. Hook Runtime

### 6.1 Hook 类型

- Lifecycle Hook
  - 观测系统事件
- Interceptor Hook
  - 改写请求和执行逻辑

### 6.2 建议事件点

- `before_context_build`
- `after_context_build`
- `before_model_call`
- `after_model_call`
- `before_tool_dispatch`
- `after_tool_dispatch`
- `run_completed`
- `run_failed`

### 6.3 当前限制

- Hook 不允许直接操作底层数据库事务
- Hook 改写能力必须显式声明 capability
- Hook 默认只作用于当前 run 上下文

## 7. Execution Backend 抽象

### 7.1 目标

屏蔽本地执行和未来沙箱执行的差异。

### 7.2 接口建议

```ts
export interface ExecutionBackend {
  kind(): string
  prepare(ctx: BackendPrepareContext): Promise<BackendSession>
  execShell(req: ExecShellRequest, ctx: BackendSession): Promise<ExecShellResult>
  readFile(req: ReadFileRequest, ctx: BackendSession): Promise<ReadFileResult>
  writeFile(req: WriteFileRequest, ctx: BackendSession): Promise<WriteFileResult>
  listFiles(req: ListFilesRequest, ctx: BackendSession): Promise<ListFilesResult>
  dispose(ctx: BackendSession): Promise<void>
}
```

### 7.3 当前实现

- `LocalWorkspaceBackend`
  - 以 workspace 根目录为工作目录
  - 在宿主机执行 shell
  - 提供文件读写能力

### 7.4 后续实现

- `SandboxBackend`
  - 容器 / VM / Firecracker / 远程 runner

## 8. 队列与并发

### 8.1 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 的 run 可以并发

### 8.2 建议做法

- Redis list 或 stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态

### 8.3 为什么不用单纯数据库锁

只用 PostgreSQL 也能做，但会在以下方面更笨重：

- 高频调度效率低
- 分布式 worker 扩展不自然
- 实时队列可观测性差

## 9. 取消、超时与失败恢复

### 9.1 取消

- 调用方可通过 API 取消 run
- worker 轮询取消标记
- 对 shell 子进程发送终止信号
- 对 MCP 调用和子流程做 best-effort cancellation

### 9.2 超时

需要区分：

- run 总超时
- 单次模型调用超时
- 单次工具调用超时

### 9.3 恢复

worker 重启后：

- 从 PostgreSQL 扫描 `running` 且长时间未 heartbeat 的 run
- 根据恢复策略标记为 `failed` 或重新排队

## 10. 事件流

### 10.1 SSE 适用场景

- 浏览器或轻量客户端监听 session/run 输出
- 实现简单，适合单向流式推送

### 10.2 建议事件类型

- `run.queued`
- `run.started`
- `run.progress`
- `message.delta`
- `agent.switch.requested`
- `agent.switched`
- `agent.delegate.started`
- `agent.delegate.completed`
- `agent.delegate.failed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `run.completed`
- `run.failed`
- `run.cancelled`

## 11. 结构化日志与审计

所有关键节点都需要产生日志和审计记录：

- API 请求入口
- run 状态变更
- model call
- tool call
- action run
- hook run
- backend shell 执行

日志中至少要包含：

- `subject_ref`
- `workspace_id`
- `session_id`
- `run_id`
- `agent_name`
- `effective_agent_name`
- `tool_name`
- `duration_ms`
- `status`
