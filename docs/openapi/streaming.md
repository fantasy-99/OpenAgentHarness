# Streaming Module

## 接口

### `GET /sessions/{sessionId}/events`

用途：

- 订阅某个 session 的流式事件
- 可选按 `runId` 过滤
- 可选通过 `cursor` 恢复

响应类型：

- `Content-Type: text/event-stream`

## 事件类型

- `run.queued`
- `run.started`
- `message.delta`
- `message.completed`
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

## 事件格式

```text
event: tool.completed
data: {"runId":"run_123","callId":"tc_001","toolName":"code.review","sourceType":"action"}
```

agent 切换事件示例：

```text
event: agent.switched
data: {"runId":"run_123","fromAgent":"plan","toAgent":"build","switchCount":1}
```

subagent 事件示例：

```text
event: agent.delegate.started
data: {"runId":"run_123","agentName":"builder","targetAgent":"repo-explorer","childRunId":"run_456"}
```

## 客户端规则

- 使用长连接接收事件
- 断线后可携带 `cursor` 重连
- 最终状态以 `run.completed`、`run.failed`、`run.cancelled` 为准
