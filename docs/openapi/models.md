# Model Gateway Module

## 范围

该模块包括：

- 模型一次性生成
- 模型流式生成

它主要服务于：

- workspace action
- 本地脚本
- `oah model` CLI
- 其他需要直接调用平台预设模型的程序

## 接口

### `POST /internal/v1/models/generate`

用途：

- 使用指定服务端模型执行一次性生成

请求核心字段：

- `model`
- `prompt`
- `messages`
- `temperature`
- `maxTokens`

返回核心字段：

- `model`
- `text`
- `finishReason`
- `usage`

请求示例：

```json
{
  "model": "openai-default",
  "prompt": "Summarize the repository"
}
```

响应示例：

```json
{
  "model": "openai-default",
  "text": "This repository implements ...",
  "finishReason": "stop",
  "usage": {
    "inputTokens": 120,
    "outputTokens": 48,
    "totalTokens": 168
  }
}
```

### `POST /internal/v1/models/stream`

用途：

- 使用指定服务端模型执行流式生成

返回：

- `text/event-stream`

建议事件类型：

- `response.started`
- `text.delta`
- `response.completed`
- `response.failed`

请求示例：

```json
{
  "model": "openai-default",
  "messages": [
    { "role": "user", "content": "Summarize the repository" }
  ]
}
```

流式示例：

```text
event: response.started
data: {"model":"openai-default"}

event: text.delta
data: {"delta":"This repository "}

event: response.completed
data: {"model":"openai-default","finishReason":"stop"}
```

## 设计说明

- 该模块是“模型网关”，不是 session 对话接口
- 它不创建 session，也不维护对话历史
- 适合 action、脚本、CLI 临时调用模型
- 服务端内部仍统一通过 AI SDK 调模型
- 该模块只面向服务端预设模型，不直接访问 workspace 私有模型
- 请求参数直接使用服务端模型名，例如 `openai-default`
- 这是内部本地调用接口，不要求 token 认证
- 建议只通过 Unix Socket 或 `127.0.0.1` loopback 暴露，不挂到公网入口

## 相关 Schema

OpenAPI 单文件中对应的 schema 包括：

- `ModelGenerateRequest`
- `ModelStreamRequest`
- `ModelGenerateResponse`
- `ChatMessage`
- `Usage`
