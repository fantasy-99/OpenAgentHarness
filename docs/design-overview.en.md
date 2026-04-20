# Design Overview

Navigation hub for the Open Agent Harness design documents.

## Terminology

- [Terminology](./terminology.en.md) -- shared boundaries for `Agent Engine`, `Agent Runtime`, and `Agent Spec`
- [Concept Relationships](./concept-relationships.en.md) -- one map for `Workspace`, `Worker`, `Sandbox`, and `Runtime`

## Three Core Concepts

| Concept | Role | Description |
|---------|------|-------------|
| **Workspace** | Capability boundary | Each workspace declares its own agents, models, tools, skills, actions, and hooks, and uses one consistent directory structure for discovery and execution. |
| **Session** | Context boundary | A continuous conversation or task collaboration, scoped to a workspace. |
| **Run** | Execution boundary | One model inference + tool loop. Runs are serial within a session. |

## Read by Topic

### Architecture and Domain

- [Architecture Overview](./architecture-overview.en.md) -- layers, modules, request flow
- [Domain Model](./domain-model.md) -- core objects and relationships
- [Storage Design](./storage-design.md) -- PostgreSQL / Redis / SQLite responsibilities

### Workspace Configuration

- [Workspace Overview](./workspace/README.md)
- [Settings](./workspace/settings.md) | [Agents](./workspace/agents.md) | [Models](./workspace/models.md)
- [Skills](./workspace/skills.md) | [External Tools](./workspace/mcp.md) | [Hooks](./workspace/hooks.md)

### Engine

- [Engine Overview](./engine/README.md)
- [Lifecycle](./engine/lifecycle.md) | [Context Engine](./engine/context-engine.md)
- [Queue and Reliability](./engine/queue-and-reliability.md) | [Events and Audit](./engine/events-and-audit.md)

### External Interfaces

- [API Reference](./openapi/README.md) | [Schemas Overview](./schemas/README.md)

### Deployment

- [Quick Start](./getting-started.md) | [Deploy and Run](./deploy.md) | [Server Config](./server-config.md)

## Read by Role

### Platform Engineers

1. [Architecture Overview](./architecture-overview.en.md)
2. [Terminology](./terminology.en.md)
3. [Concept Relationships](./concept-relationships.en.md)
4. [Domain Model](./domain-model.md)
5. [Workspace Overview](./workspace/README.md)
6. [Engine Overview](./engine/README.md)

### Product / Integration Teams

1. [Quick Start](./getting-started.md)
2. [Deploy and Run](./deploy.md)
3. [API Reference](./openapi/README.md)
4. [Streaming](./openapi/streaming.md)

### Troubleshooting

1. [Deploy and Run](./deploy.md)
2. [Lifecycle](./engine/lifecycle.md)
3. [Queue and Reliability](./engine/queue-and-reliability.md)
4. [Events and Audit](./engine/events-and-audit.md)

## Translation Note

Not every page has an English translation yet. When no English page exists, the site falls back to the Chinese source.
