# Components

## 通用对象

OpenAPI 主规范中的 `components/schemas` 目前主要包括：

- `Workspace`
- `WorkspacePage`
- `WorkspaceCatalog`
- `ModelCatalogItem`
- `ChatMessage`
- `Usage`
- `Session`
- `SessionPage`
- `Message`
- `MessagePage`
- `Run`
- `RunStep`
- `CreateWorkspaceRequest`
- `UpdateWorkspaceSettingsRequest`
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

### `UpdateWorkspaceSettingsRequest`

用于 `PATCH /workspaces/{workspaceId}/settings`。

字段：

- `historyMirrorEnabled`

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

## 模型网关对象

### `ChatMessage`

用于模型网关中的消息输入。

字段：

- `role`
  - `system | user | assistant | tool`
- `content`

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
