# Hook I/O Protocol

整体参考 Claude Code 的 hook I/O 形式，但事件名和 patch 能力对齐 Open Agent Harness。

## 输入

所有 handler 都接收同一份 JSON envelope。

公共字段建议至少包括：

- `workspace_id`
- `session_id`
- `run_id`
- `cwd`
- `hook_event_name`
- `agent_name`
- `effective_agent_name`

事件附加字段按事件类型补充，例如：

- `before_model_call`
  - `model_ref`
  - `model_request`
- `after_model_call`
  - `model_ref`
  - `model_request`
  - `model_response`
- `before_tool_dispatch`
  - `tool_name`
  - `tool_input`
  - `tool_call_id`
- `after_tool_dispatch`
  - `tool_name`
  - `tool_input`
  - `tool_output`
  - `tool_call_id`
- `run_completed` / `run_failed`
  - `trigger_type`
  - `run_status`

各 handler 的传递方式：

- `command`
  - JSON 通过 stdin 传入
- `http`
  - JSON 作为 POST body 传入
- `prompt`
  - 运行时将该 JSON envelope 注入 prompt 上下文
- `agent`
  - 运行时将该 JSON envelope 注入 agent task 上下文

## 输出

统一输出对象建议采用 Claude Code 风格：

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Optional warning for operator",
  "decision": "block",
  "reason": "Explanation for the block",
  "hookSpecificOutput": {
    "hookEventName": "before_tool_dispatch",
    "additionalContext": "Optional extra context",
    "patch": {
      "tool_input": {
        "command": "npm run lint"
      }
    }
  }
}
```

字段说明：

- `continue`
  - 默认 `true`
  - `false` 时终止当前 run 继续执行
- `stopReason`
  - 当 `continue=false` 时给用户或调用方看的说明
- `suppressOutput`
  - 是否隐藏 hook 原始输出
- `systemMessage`
  - 给操作者的提示信息
- `decision`
  - 当前建议只支持 `"block"`
- `reason`
  - 对 `decision=block` 的说明
- `hookSpecificOutput`
  - 事件级结构化输出
- `hookSpecificOutput.additionalContext`
  - 注入到后续上下文的补充信息
- `hookSpecificOutput.patch`
  - 改写对象，仅在 capability 允许时生效

patch 范围建议为：

- `context`
- `model_request`
- `model_response`
- `tool_input`
- `tool_output`

规则：

- `patch` 只能改写 `capabilities` 允许的对象
- 不具备对应 capability 的 patch 字段必须被忽略并记录 warning
- `decision=block` 与 `patch` 可同时存在，但通常以 block 优先

## 不同 handler 的返回语义

- `command`
  - exit code `0`：成功；若 stdout 为 JSON，则按上面的统一输出协议解析
  - exit code `2`：阻断当前事件；stderr 作为失败原因
  - 其他 exit code：非阻断错误；记录后继续
- `http`
  - `2xx` + 空 body：成功且无额外输出
  - `2xx` + JSON body：按统一输出协议解析
- `http`
  - 非 `2xx` / 超时：非阻断错误；记录后继续
- `prompt`
  - 必须返回可解析的统一 JSON
- `agent`
  - 必须返回可解析的统一 JSON

## 当前建议限制

- 只允许声明少量 capability
- 只能操作当前 run 的上下文对象
- hook 输出必须是运行时可解释的结构化结果
- `agent` 型 hook 默认不允许继续递归触发新的 hook agent 链路，避免失控
