# Hook Runtime

## Hook 类型

- **Lifecycle Hook** — 观测系统事件
- **Interceptor Hook** — 改写请求和执行逻辑

Handler 类型：`command`（shell 脚本）、`http`（HTTP 请求）、`prompt`（prompt 型判断）、`agent`（agent 执行决策）。

配置使用 YAML，可选 `matcher` 按事件值做正则过滤。

## 事件点

| 事件 | matcher 匹配 |
| --- | --- |
| `before_context_build` / `after_context_build` | 不支持 matcher |
| `before_model_call` / `after_model_call` | `model_ref` |
| `before_tool_dispatch` / `after_tool_dispatch` | `tool_name` |
| `run_completed` / `run_failed` | `trigger_type` |

## 输入协议

所有 handler 接收同一份 JSON envelope。公共字段：`workspace_id`、`session_id`、`run_id`、`cwd`、`hook_event_name`、`agent_name`、`effective_agent_name`。事件附加字段按类型补充（`model_ref`、`tool_name`、`tool_input`、`tool_output`、`trigger_type`）。

## 输出协议

统一采用：

- 通用控制字段：`continue`、`stopReason`、`suppressOutput`、`systemMessage`
- 顶层 `decision` / `reason`
- 允许改写的事件将 patch 放入 `hookSpecificOutput`，受 `capabilities` 限制

## Handler 返回语义

| Handler | 成功 | 阻断 | 错误 |
| --- | --- | --- | --- |
| `command` | exit 0（stdout JSON 按输出协议解析） | exit 2（stderr 为原因） | 其他 exit code，记录日志继续 |
| `http` | 2xx + JSON body | — | 非 2xx / 超时，记录日志继续 |
| `prompt` | 运行时注入 envelope，要求返回统一 JSON | — | — |
| `agent` | 运行时将 envelope 作为任务上下文交给指定 agent | — | — |

## 限制

- Hook 不允许直接操作数据库事务
- 改写能力须显式声明 capability
- 默认只作用于当前 run 上下文
- `.openharness/hooks/` 可放置 `*.yaml`、脚本、prompt 文件和其他静态资源
