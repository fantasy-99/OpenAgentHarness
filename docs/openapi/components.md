# Components

## 通用对象

OpenAPI 主规范中的 `components/schemas` 目前主要包括：

- `Workspace`
- `WorkspacePage`
- `WorkspaceEntry`
- `WorkspaceEntryPage`
- `WorkspaceFileContent`
- `WorkspaceDeleteResult`
- `WorkspaceImportRequest`
- `WorkspaceCatalog`
- `ModelCatalogItem`
- `ModelProvider`
- `ModelProviderList`
- `ChatMessage`
- `Usage`
- `Session`
- `SessionPage`
- `Message`
- `MessagePage`
- `Run`
- `RunStep`
- `CreateWorkspaceRequest`
- `PutWorkspaceFileRequest`
- `CreateWorkspaceDirectoryRequest`
- `MoveWorkspaceEntryRequest`
- `CreateSessionRequest`
- `CreateMessageRequest`
- `CreateActionRunRequest`
- `WorkspaceHistoryMirrorStatus`
- `ModelGenerateRequest`
- `ModelStreamRequest`
- `ModelGenerateResponse`
- `MessageAccepted`
- `ActionRunAccepted`
- `CancelRunAccepted`
- `Error`
- `ErrorResponse`

### `Workspace`

用于 `POST /workspaces`、`GET /workspaces`、`GET /workspaces/{workspaceId}`。

字段：

- `id`
- `externalRef`
- `name`
- `rootPath`
- `executionPolicy`
- `status`
- `kind`
- `readOnly`
- `historyMirrorEnabled`
- `createdAt`
- `updatedAt`

### `WorkspaceImportRequest`

用于 `POST /workspaces/import`。

字段：

- `rootPath`
- `kind`
- `name`
- `externalRef`

### `WorkspaceEntry`

用于 `GET /workspaces/{workspaceId}/entries`、`PUT /workspaces/{workspaceId}/files/content`、`POST /workspaces/{workspaceId}/directories`、`PATCH /workspaces/{workspaceId}/entries/move`。

字段：

- `path`
- `name`
- `type`
- `sizeBytes`
- `mimeType`
- `etag`
- `updatedAt`
- `createdAt`
- `readOnly`

说明：

- `type` 当前草案只包含 `file | directory`
- `sizeBytes` 对目录可省略

### `WorkspaceEntryPage`

用于 `GET /workspaces/{workspaceId}/entries`。

字段：

- `workspaceId`
- `path`
- `items[]`
- `nextCursor`

说明：

- 只表示“某个目录下的直接子项分页”，不是递归树

### `WorkspaceFileContent`

用于 `GET /workspaces/{workspaceId}/files/content`。

字段：

- `workspaceId`
- `path`
- `encoding`
- `content`
- `truncated`
- `sizeBytes`
- `mimeType`
- `etag`
- `updatedAt`
- `readOnly`

### `WorkspaceDeleteResult`

用于 `DELETE /workspaces/{workspaceId}/entries`。

字段：

- `workspaceId`
- `path`
- `type`
- `deleted`

### `PutWorkspaceFileRequest`

用于 `PUT /workspaces/{workspaceId}/files/content`。

字段：

- `path`
- `content`
- `encoding`
- `overwrite`
- `ifMatch`

说明：

- `ifMatch` 用于和读取结果中的 `etag` 配合，支持乐观并发控制

### `CreateWorkspaceDirectoryRequest`

用于 `POST /workspaces/{workspaceId}/directories`。

字段：

- `path`
- `createParents`

### `MoveWorkspaceEntryRequest`

用于 `PATCH /workspaces/{workspaceId}/entries/move`。

字段：

- `sourcePath`
- `targetPath`
- `overwrite`

### `ModelProvider`

用于描述当前服务端已支持的模型 provider。

字段：

- `id`
- `packageName`
- `description`
- `requiresUrl`
- `useCases`

### `ModelProviderList`

用于 `GET /model-providers`。

字段：

- `items[]`

### `WorkspaceHistoryMirrorStatus`

用于 `GET /workspaces/{workspaceId}/history-mirror` 和 `POST /workspaces/{workspaceId}/history-mirror/rebuild`。

字段：

- `workspaceId`
- `supported`
- `enabled`
- `state`
- `lastEventId`
- `lastSyncedAt`
- `dbPath`
- `errorMessage`

### `Run`

用于 `GET /runs/{runId}`。

字段：

- `id`
- `workspaceId`
- `sessionId`
- `parentRunId`
- `initiatorRef`
- `triggerType`
- `triggerRef`
- `agentName`
- `effectiveAgentName`
- `switchCount`
- `status`
- `cancelRequestedAt`
- `startedAt`
- `heartbeatAt`
- `endedAt`
- `createdAt`
- `errorCode`
- `errorMessage`
- `metadata`

说明：

- `parentRunId` 当前已用于表达 subagent / background child run 与父 run 的关系
- `heartbeatAt` 会在 run 活跃期间持续刷新，供 worker 启动恢复扫描使用

### `ActionCatalogItem`

用于 `GET /workspaces/{workspaceId}/catalog` 中的 `actions[]`。

字段：

- `name`
- `description`
- `exposeToLlm`
- `callableByUser`
- `callableByApi`
- `retryPolicy`

说明：

- `retryPolicy=safe` 表示该 action 已显式声明为可安全重试的候选项
- 缺省或 `manual` 表示只能按人工或外部调用方显式重试对待，不应默认自动恢复

## 模型网关对象

### `ChatMessage`

用于模型网关中的消息输入。

字段：

- `role`
  - `system | user | assistant | tool`
- `content`
  - `system`
    - 必须是字符串
  - `user`
    - 可以是字符串
    - 也可以是 `text | image | file` parts 数组
  - `assistant`
    - 可以是字符串
    - 也可以是 `text | file | reasoning | tool-call | tool-result | tool-approval-request` parts 数组
  - `tool`
    - 必须是 `tool-result | tool-approval-response` parts 数组

说明：

- 这里对齐的是 AI SDK `ModelMessage` 的 JSON-safe 表示
- 某些 AI SDK 运行时对象，例如 `URL`、二进制 data，不直接以运行时对象写入数据库
- 持久化时会转换为 JSON-safe 形式；真正发给 AI SDK 前，再恢复为可接受的运行时值

### `MessagePart`

用于 message content 中的结构化片段。

当前支持的主要 part：

- `text`
  - `text`
- `image`
  - `image`
  - `mediaType`
- `file`
  - `data`
  - `mediaType`
  - `filename`
- `reasoning`
  - `text`
- `tool-call`
  - `toolCallId`
  - `toolName`
  - `input`
  - `providerExecuted`
- `tool-result`
  - `toolCallId`
  - `toolName`
  - `output`
- `tool-approval-request`
  - `approvalId`
  - `toolCallId`
- `tool-approval-response`
  - `approvalId`
  - `approved`
  - `reason`

### `ToolResultOutput`

用于 `tool-result.output`。

当前支持：

- `text`
  - `value: string`
- `json`
  - `value: JSONValue`
- `execution-denied`
  - `reason?: string`
- `error-text`
  - `value: string`
- `error-json`
  - `value: JSONValue`
- `content`
  - `value: [...]`
  - 用于承载 AI SDK content-style tool output，例如 `text`、`file-data`、`image-url`

### `Message`

用于 session message 查询返回。

字段：

- `id`
- `sessionId`
- `runId`
- `role`
- `content`
  - 与 `ChatMessage.content` 使用同一套 role-aware 规则
- `metadata`
- `createdAt`

### `Usage`

用于返回模型 token 使用量。

字段：

- `inputTokens`
- `outputTokens`
- `totalTokens`

### `ModelGenerateRequest`

用于 `/internal/v1/models/generate`。

字段：

- `model`
  - 服务端模型名，例如 `openai-default`
- `prompt`
- `messages`
- `temperature`
- `maxTokens`

约束：

- `prompt` 与 `messages` 至少提供一个

### `ModelStreamRequest`

用于 `/internal/v1/models/stream`。

当前与 `ModelGenerateRequest` 保持同结构。

### `ModelGenerateResponse`

用于一次性模型生成返回。

字段：

- `model`
- `text`
- `finishReason`
- `usage`

## 通用参数

- `workspaceId`
- `sessionId`
- `runId`
- `actionName`
- `pageSize`
- `cursor`
- `path`
- `sortBy`
- `sortOrder`
- `recursive`
- `encoding`
- `maxBytes`
- `runId` query 参数

## 错误模型

统一错误结构：

```json
{
  "error": {
    "code": "ACTION_NOT_FOUND",
    "message": "Action code.review was not found",
    "details": {}
  }
}
```

## 建议错误码

- `WORKSPACE_NOT_FOUND`
- `SESSION_NOT_FOUND`
- `RUN_NOT_FOUND`
- `AGENT_NOT_FOUND`
- `ACTION_NOT_FOUND`
- `SKILL_NOT_FOUND`
- `MCP_NOT_FOUND`
- `HOOK_NOT_FOUND`
- `INVALID_CONFIGURATION`
- `RUN_CONFLICT`
- `RUN_CANCELLED`
- `TOOL_TIMEOUT`
- `POLICY_DENIED`
- `AGENT_SWITCH_DENIED`
- `SUBAGENT_DENIED`
- `MODEL_NOT_FOUND`
- `MODEL_GATEWAY_DISABLED`
- `MODEL_GATEWAY_LOCAL_ONLY`
