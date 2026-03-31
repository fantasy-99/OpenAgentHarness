# OpenAPI Spec

这里保存 Open Agent Harness 的 OpenAPI 3.1 草案和按模块拆分的接口说明。

## 文件结构

- [openapi.yaml](./openapi.yaml)
  - 单文件 OpenAPI 3.1 草案
- [overview.md](./overview.md)
  - API 总览与统一约束
- [workspaces.md](./workspaces.md)
  - workspace、catalog、model 可见性
- [models.md](./models.md)
  - 模型网关，供脚本、CLI 和 action 直接调用模型
- [sessions.md](./sessions.md)
  - session 与 message
- [runs.md](./runs.md)
  - run 查询与取消
- [actions.md](./actions.md)
  - action 手动触发
- [streaming.md](./streaming.md)
  - SSE 事件流
- [components.md](./components.md)
  - 通用 schema、参数与错误模型

## 使用原则

- 接口定义以 [openapi.yaml](./openapi.yaml) 为准
- 模块文档用于解释资源边界和语义
