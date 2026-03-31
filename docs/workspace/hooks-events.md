# Hook Events And Matcher

## 目标

Hook 用于运行时扩展和拦截，不对 LLM 直接暴露。

继续采用 `.openharness/hooks/*.yaml` 作为 hook 声明入口，但允许在 `hooks/` 目录下放置额外脚本、代码文件、prompt 文件和资源子目录。

## 基础示例

```yaml
name: redact-secrets
events:
  - before_model_call
matcher: "platform/openai-default|workspace/openai-default"

handler:
  type: command
  command: node ./.openharness/hooks/scripts/redact-secrets.js

capabilities:
  - rewrite_model_request
```

## 顶层字段

- `name`
- `events`
- `matcher`
- `handler`
- `capabilities`

## `events` 建议点位

- `before_context_build`
- `after_context_build`
- `before_model_call`
- `after_model_call`
- `before_tool_dispatch`
- `after_tool_dispatch`
- `run_completed`
- `run_failed`

## `matcher` 字段

`matcher` 参考 Claude Code 的 hooks 机制，使用正则字符串按事件查询值过滤 hook 是否触发。

规则：

- 可选；未声明时表示匹配该事件下的所有触发
- 使用正则字符串，而不是 glob
- 不同事件的匹配目标不同：
  - `before_tool_dispatch`、`after_tool_dispatch`
    - 匹配 `tool_name`
  - `before_model_call`、`after_model_call`
    - 匹配 `model_ref`
  - `run_completed`、`run_failed`
    - 可匹配 `trigger_type`
  - `before_context_build`、`after_context_build`
    - 默认忽略 `matcher`

示例：

```yaml
matcher: "shell.exec|mcp__docs__search"
```

```yaml
matcher: "platform/openai-default|workspace/中文模型"
```
