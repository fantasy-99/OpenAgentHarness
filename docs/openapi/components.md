# Components

## 通用对象

OpenAPI 主规范中的 `components/schemas` 目前主要包括：

- `Workspace`
- `WorkspaceCatalog`
- `ModelCatalogItem`
- `Session`
- `Message`
- `MessagePage`
- `Run`
- `RunStep`
- `CreateWorkspaceRequest`
- `CreateSessionRequest`
- `CreateMessageRequest`
- `CreateActionRunRequest`
- `MessageAccepted`
- `ActionRunAccepted`
- `CancelRunAccepted`
- `Error`
- `ErrorResponse`

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
