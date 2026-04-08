# Quick Start

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20+ |
| pnpm | 10+ |
| Docker + docker compose | Latest stable |

## Installation and Startup

### Step 1: Install dependencies

```bash
pnpm install
```

### Step 2: Start infrastructure

Start PostgreSQL and Redis (Docker Compose for development):

```bash
pnpm infra:up
```

### Step 3: Start the backend

```bash
pnpm dev:server -- --config ./server.example.yaml
```

Listens on `http://127.0.0.1:8787` by default. The embedded worker starts automatically.

### Step 4: Start the debug console

```bash
pnpm dev:web
```

Open [http://localhost:5174](http://localhost:5174).

## Verify It Works

After startup, check:

1. Backend logs show the runtime mode (embedded worker / api-only)
2. Browser opens `http://localhost:5174`
3. Send a message in the console. The run should move from `queued` to executing.

!!! tip
    If the backend is not at the default address, set the proxy target:
    ```bash
    OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
    ```

## Single Workspace Mode

To serve a single workspace without a config file, point directly at a workspace path:

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

Optional flags: `--workspace-kind chat`, `--tool-dir`, `--skill-dir`, `--host`, `--port`

!!! info
    In single workspace mode, the debug console enters the workspace automatically.

## Common Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm infra:up` | Start PostgreSQL + Redis |
| `pnpm infra:down` | Stop infrastructure |
| `pnpm dev:server -- --config ./server.example.yaml` | Start backend (embedded worker) |
| `pnpm dev:server -- --api-only --config ./server.example.yaml` | Start API only |
| `pnpm dev:worker -- --config ./server.example.yaml` | Start standalone worker |
| `pnpm dev:web` | Start debug console |
| `pnpm build` | Full build |
| `pnpm test` | Run tests |
| `mkdocs serve` | Preview docs locally |

## Next Steps

- [Architecture Overview](./architecture-overview.md) — Understand the system structure
- [Workspace Guide](./workspace/README.md) — Configure agents, skills, and tools
- [Deploy and Run](./deploy.md) — Unified local vs split production deployment
- [Design Overview](./design-overview.md) — Core design decisions
