# OpenAPI Overview

This section contains the OpenAPI 3.1 draft and the modular API explanations for Open Agent Harness.

## Start Here

- to understand the overall API shape: [overview.md](./overview.md)
- to inspect the concrete schema: [openapi.yaml](./openapi.yaml)
- to integrate message sending and execution: read [sessions.md](./sessions.md), [runs.md](./runs.md), and [streaming.md](./streaming.md) together

## File Structure

- [openapi.yaml](./openapi.yaml): single-file OpenAPI draft
- [overview.md](./overview.md): API conventions and system-wide rules
- [workspaces.md](./workspaces.md): workspace and catalog visibility
- [models.md](./models.md): internal model gateway
- [sessions.md](./sessions.md): sessions and messages
- [runs.md](./runs.md): run lookup and cancellation
- [actions.md](./actions.md): manual action triggering
- [streaming.md](./streaming.md): SSE event streaming
- [components.md](./components.md): shared schemas and error models

## Rule of Thumb

The OpenAPI file is the interface source of truth. The Markdown pages explain intent, boundaries, and behavior.

