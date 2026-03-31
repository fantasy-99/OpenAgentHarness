# Hook Handlers

建议支持四种 handler：

- `command`
  - 通过命令字符串执行脚本、解释器或本地程序
- `http`
  - 通过 HTTP 请求调用外部服务
- `prompt`
  - 通过 prompt + model 生成结构化结果
- `agent`
  - 调用指定 agent 生成结构化结果

## `command`

```yaml
handler:
  type: command
  command: python ./.openharness/hooks/scripts/check.py
  cwd: ./
  timeout_seconds: 30
  environment:
    MODE: strict
```

字段说明：

- `command`
  - 必填；命令字符串
- `cwd`
  - 可选；工作目录
- `timeout_seconds`
  - 可选；执行超时
- `environment`
  - 可选；追加环境变量

## `http`

```yaml
handler:
  type: http
  url: https://example.internal/hooks/check
  method: POST
  timeout_seconds: 10
  headers:
    Authorization: Bearer ${secrets.HOOK_TOKEN}
```

字段说明：

- `url`
  - 必填；HTTP endpoint
- `method`
  - 可选；默认 `POST`
- `headers`
  - 可选；请求头
- `timeout_seconds`
  - 可选；请求超时

## `prompt`

```yaml
handler:
  type: prompt
  prompt:
    file: ./.openharness/hooks/prompts/review.md
  model_ref: platform/openai-default
  timeout_seconds: 20
```

字段说明：

- `prompt`
  - 必填；支持 `inline` 或 `file`
- `model_ref`
  - 可选；指定 hook 使用的模型入口
- `timeout_seconds`
  - 可选；执行超时

## `agent`

```yaml
handler:
  type: agent
  agent: policy-reviewer
  task:
    inline: |-
      Inspect the invocation and return a structured decision.
  timeout_seconds: 30
```

字段说明：

- `agent`
  - 必填；指定执行 hook 的 agent 名称
- `task`
  - 必填；支持 `inline` 或 `file`
- `timeout_seconds`
  - 可选；执行超时

## 目录约定

`hooks/` 目录除 `*.yaml` 外，建议支持：

- `scripts/`
  - hook 调用的脚本和代码文件
- `prompts/`
  - prompt handler 或 agent handler 复用的提示词文件
- `resources/`
  - 配置片段、模板、测试数据和其他静态资源

规则：

- `hooks/*.yaml` 仍是唯一的 hook 声明入口
- 额外文件和子目录仅作为 hook 运行时依赖资源，不单独注册为 hook
- `file` 路径相对 workspace 根目录解析
