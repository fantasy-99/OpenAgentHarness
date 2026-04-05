# Session And Message Module

## 范围

该模块包括：

- session 创建
- session 查询
- message 列表
- message 创建

## 接口

### `POST /workspaces/{workspaceId}/sessions`

用途：

- 在指定 workspace 下创建新会话

可选字段：

- `title`
- `agentName`

说明：

- `agentName` 可指向当前 workspace 可见 catalog 中的 platform agent 或 workspace agent
- `kind=chat` workspace 下创建 session 时，行为与普通对话一致，但不会启用任何执行型工具

### `GET /workspaces/{workspaceId}/sessions`

用途：

- 分页读取指定 workspace 下的 session 列表

查询参数：

- `pageSize`
- `cursor`

返回：

- `items[]`
- `nextCursor`

说明：

- 仅返回属于当前 `workspaceId` 的会话
- 返回结果按创建顺序稳定分页

### `GET /sessions/{sessionId}`

用途：

- 获取会话元数据

### `GET /sessions/{sessionId}/messages`

用途：

- 分页读取历史消息

说明：

- 返回的 `Message.content` 采用 AI SDK 风格
  - 纯文本消息可直接返回字符串
  - assistant tool call 与 tool result 会通过 message parts 返回

查询参数：

- `pageSize`
- `cursor`

### `POST /sessions/{sessionId}/messages`

用途：

- 写入一条用户消息
- 创建 run
- 将 run 放入 session 队列

返回：

- `messageId`
- `runId`
- `status=queued`

## 设计说明

- message 创建是异步语义，不同步返回最终结果
- 客户端需结合 `GET /runs/{runId}` 和 SSE 获取执行进度
- 同一 session 可连续写入多条 message，它们会形成串行 run 队列
- runtime 持久化的消息链路会显式保留 assistant tool-call message 与 tool result message
- session 会维护 `activeAgentName`，作为后续默认 primary agent
- 若 run 内发生 `agent.switch`，session 的 `activeAgentName` 可在 run 完成后同步更新
- `kind=chat` workspace 的 session / message / run 仍保存到中心数据库
- `kind=chat` workspace 不会在 workspace 目录内生成 `.openharness/data/history.db`
