# OAP Daemon Roadmap

OAP（Open Agent Harness Personal）是 OAH 的个人部署形态。它面向本地单用户使用，目标是用一个常驻 daemon 提供完整 OAH-compatible API，让 WebUI、TUI 和 Desktop 都能连接同一套本地服务。

## 0. Repository Reality Check

结合当前仓库实现，OAP 方向没有需要推翻的大架构问题。现有代码已经具备几个关键前提：

- `apps/server/src/bootstrap.ts` 已支持未配置 PostgreSQL 时使用 `@oah/storage-sqlite`。
- 未配置 Redis 时，server 会回退到 in-process / local-inline 执行；worker 不必须依赖 Redis 接收请求。
- `API + embedded worker` 已是一等进程形态，适合包装成 local daemon。
- `template/deploy-root/config/daemon.yaml` 已是 SQLite + embedded worker + local disk 的雏形。
- `@oah/storage-sqlite` 已有 workspace registry、session/run/message、pending queue、event store、history events 等完整 repository 结构。

所以 OAP 不应该变成新的 server、新的 engine、新的 TUI 协议或新的 Electron runtime。正确路线是：

```text
OAP daemon = existing OAH server + embedded worker + SQLite/local disk profile + daemon lifecycle wrapper
```

不过 ROADMAP 需要明确几个现实约束：

| Area | Current reality | OAP implication |
| --- | --- | --- |
| Server process | `oah-api` already runs embedded worker when not `--api-only` / `--no-worker`. | Daemon should wrap this entrypoint, not fork a new runtime process. |
| Redis | Optional. Without Redis, runs execute local-inline in the API process. | OAP does not need Redis for single-user operation. |
| PostgreSQL | Optional. Without PostgreSQL, SQLite runtime persistence is used. | OAP can use SQLite, but must harden its directory and migration semantics. |
| SQLite location | Writable `project` workspaces currently default to repo-local `.openharness/data/history.db`. | OAP needs a config switch to force `OAH_HOME/state` shadow storage for external repos. |
| Workspace import | `POST /api/v1/workspaces/import` currently rejects paths outside `config.paths.workspace_dir`. | OAP needs a personal-only local path registration path, gated by server profile/capability. |
| Profile identity | `/api/v1/system/profile` does not yet exist. | Clients cannot safely distinguish OAH vs OAP until this is added. |
| Daemon lifecycle | No `oah daemon *` command yet. | CLI should add lifecycle management around the existing server. |

High-level verdict:

- No large architectural rewrite is needed.
- The largest required adjustment is not the runtime core; it is local workspace registration and storage policy around external repo paths.
- The second largest adjustment is packaging: daemon lifecycle, local token, logs, PID, and client defaults.

## 1. Product Target

最终面向用户的入口应收敛到：

```bash
oah daemon start
oah tui --workspace /path/to/repo
```

更完整的本地工作流：

```bash
oah daemon init
oah daemon start
oah daemon status
oah daemon logs
oah daemon stop

oah tui --workspace /path/to/repo
oah web
oah models list
oah models add ./model.yaml
oah models default openai-default
```

`oah tui --workspace /path/to/repo` 应是个人使用的主入口：

1. 解析 `OAH_HOME`，默认 `~/.openagentharness`。
2. 如果 home 不存在，则从 `template/deploy-root` 初始化。
3. 如果 daemon 未运行，则自动启动或提示启动。
4. 将 `/path/to/repo` 注册为 workspace，或复用已有 workspace 记录。
5. 通过本地 OAH API / SSE 进入 TUI。

## 2. Positioning

OAP 不是 OAH 的 fork，也不是一套新协议。它是 OAH-compatible 的 personal deployment profile。

```text
WebUI       ┐
TUI         ├── OAH API ── OAH enterprise server
Desktop    ┘          └── OAP local daemon
```

OAH 与 OAP 的差异在部署形态，不在客户端协议：

| 维度 | OAH enterprise | OAP personal |
| --- | --- | --- |
| 用户 | 团队、平台、企业部署 | 本地单用户 |
| 进程 | `oah-api` + `oah-controller` + `oah-sandbox` | local daemon，一进程优先 |
| Worker | standalone workers / sandbox fleet | embedded worker |
| 存储 | PostgreSQL + Redis + object storage | SQLite + local disk |
| 配置 | `OAH_DEPLOY_ROOT/config/server.docker.yaml` 或 K8S profile | `OAH_HOME/config/daemon.yaml` |
| 资产 | deploy root 同步 / 发布 | home 下直接读取 |
| 客户端 | WebUI / TUI / Desktop | 同一套 WebUI / TUI / Desktop |

## 3. Deployment Identity And Capabilities

WebUI、TUI、Desktop 都应同时兼容 OAH enterprise server 和 OAP local daemon。为了避免客户端靠端口、URL、配置猜测部署形态，OAH-compatible server 应提供一个稳定的 profile endpoint。

Desktop 不应被定义成 OAP-only client。它是通用 OAH-compatible client；连接 OAP local daemon 时，才根据 profile / capabilities 额外显示 daemon supervisor、local logs、本地模型/工具/技能管理等能力。

建议 API：

```http
GET /api/v1/system/profile
```

建议响应：

```json
{
  "apiCompatibility": "oah/v1",
  "product": "open-agent-harness",
  "edition": "enterprise",
  "runtimeMode": "kubernetes",
  "deploymentKind": "oah",
  "displayName": "OAH enterprise server",
  "capabilities": {
    "localDaemonControl": false,
    "localWorkspacePaths": false,
    "workspaceRegistration": true,
    "storageInspection": true,
    "modelManagement": false,
    "localDaemonSupervisor": false
  }
}
```

OAP local daemon 则应返回：

```json
{
  "apiCompatibility": "oah/v1",
  "product": "open-agent-harness",
  "edition": "personal",
  "runtimeMode": "daemon",
  "deploymentKind": "oap",
  "displayName": "OAP local daemon",
  "capabilities": {
    "localDaemonControl": true,
    "localWorkspacePaths": true,
    "workspaceRegistration": true,
    "storageInspection": true,
    "modelManagement": true,
    "localDaemonSupervisor": true
  }
}
```

客户端使用原则：

- WebUI / TUI / Desktop 连接后先读取 profile。
- UI 明确展示当前连接的是 `OAH enterprise server` 还是 `OAP local daemon`。
- `--workspace /local/path`、daemon logs、local model/tool/skill 管理等只在 `edition=personal` 且 capability 允许时启用。
- 连接远端 OAH 时，不显示 stop daemon、open local logs、register local path 等个人本地专属操作。
- profile 与 capabilities 是客户端行为判断依据，不能只依赖 `localhost`、端口或用户手工选择。

## 4. Single Workspace Mode

`--workspace` single workspace server mode 最初是为了简化服务部署：绕过多 workspace registry，直接让 server 服务一个 repo。

有了 OAP 后，这条路线不再作为主要产品路径继续推进。新的简化模型是：

```bash
oah daemon start
oah tui --workspace /path/to/repo
```

迁移原则：

- `--workspace` server mode 保留为短期开发/测试兼容入口。
- README 和用户文档逐步从 single workspace mode 转向 OAP daemon。
- 新功能优先落到 daemon + workspace registry 路径，不再优先增强 single workspace server mode。
- 等 OAP workspace 注册、SQLite shadow storage、TUI 自动连接成熟后，将 single workspace mode 标记为 deprecated。

## 5. Directory Contract

OAP 默认使用：

```text
~/.openagentharness/
  models/
  runtimes/
  tools/
  skills/
  workspaces/
  config/
    daemon.yaml
    server.docker.yaml
    kubernetes.server.yaml
  state/
  logs/
  run/
  .oah-local/
```

约定：

- `OAH_HOME` 默认是 `~/.openagentharness`。
- 本机个人使用时，`OAH_DEPLOY_ROOT` 可以默认等于 `OAH_HOME`。
- `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/` 是 OAH / OAP 可互通的平台资产。
- `state/` 存 SQLite、workspace shadow、archive、materialization cache 等本地私有状态。
- `logs/` 和 `run/` 属于 daemon 生命周期，不参与 deploy root 发布。
- `config/daemon.yaml` 是 OAP 的源配置。
- `config/server.docker.yaml` 和 `config/kubernetes.server.yaml` 保留为从个人环境迁移到 Compose / K8S 的 profile。
- `tools/` 和 `skills/` 是全局 catalog / registry，不代表自动启用到所有 workspace。
- 启用或导入 tool / skill 时，应写入目标 repo 的 `.openharness/tools` / `.openharness/skills`，并默认要求用户确认。
- 默认模型来自 `OAH_HOME/models` 与 `config/daemon.yaml`；repo 可以不配置模型，直接使用 daemon / server 默认模型。
- repo 内如需指定模型，只应保存 model ref / alias，不应保存 API key 或 provider secret。
- workspace memory 固定为 repo 内 `.openharness/memory/MEMORY.md` 与 `.openharness/memory/*.md` topic files；OAP 不另行定义第二套本地记忆目录。

## 6. Runtime Model

OAP daemon 默认应是：

- API server + embedded worker in one process
- no PostgreSQL
- no Redis
- no object storage
- no standalone sandbox fleet
- local disk execution by default
- SQLite for durable sessions, runs, messages, per-session pending runs, registry metadata, and local history
- in-process scheduling for active run execution

它仍然应复用 OAH 的核心模块：

- API routes
- SSE event stream
- workspace registry
- engine-core
- model runtime
- tool / skill loading
- runtime import / initialization
- storage abstraction

OAP 不应该引入另一套 client SDK 或另一套 TUI 协议。

## 7. Architecture Adjustments Required

OAP 需要的架构调整应控制在下面几个边界内。

### 7.1 Daemon 是产品化进程包装，不是新 runtime

`oah daemon start` 应启动现有 server bootstrap：

```bash
apps/server/src/index.ts --config "$OAH_HOME/config/daemon.yaml"
```

长期可以换成构建后的二进制或 npm bin，但语义仍然是同一个 OAH server。不要新增一套 `apps/daemon` runtime，除非只是极薄的 launcher/supervisor。

### 7.2 OAP 需要 personal workspace registration，而不是继续扩大 single workspace mode

当前 `POST /api/v1/workspaces/import` 对 embedded/local 模式仍要求 rootPath 位于 `config.paths.workspace_dir` 下。这对 Compose/K8S 是合理的，但对 OAP 的核心命令不够：

```bash
oah tui --workspace /path/to/repo
```

OAP 需要一条由 profile/capability gate 控制的注册路径：

- 只在 `edition=personal` 且 `localWorkspacePaths=true` 时允许任意本机绝对路径。
- 记录稳定 `externalRef`，建议形如 `local:path:<normalized-abs-path>`。
- workspace id 应可由 `externalRef` 稳定推导，或至少保证同一路径重复打开会复用旧记录。
- 连接 OAH enterprise server 时，`--workspace /local/path` 必须拒绝，并提示切换到 local daemon。

这可以实现为扩展现有 import endpoint，也可以新增更清晰的 endpoint，例如：

```http
POST /api/v1/local/workspaces/register
```

如果复用 `/api/v1/workspaces/import`，必须避免把企业服务也打开任意本地路径能力。

### 7.3 SQLite 要成为 OAP 真值，而不是 repo-local sidecar

当前 `@oah/storage-sqlite` 的 repository 覆盖面足够好，且已有 `workspace-registry.db` 和 per-workspace `history.db`。问题不是“不支持 SQLite”，而是默认路径策略不适合 OAP：

- 普通可写 `project` workspace 会落到 `<workspace>/.openharness/data/history.db`。
- OAP 对外部 repo 默认不应污染 repo。
- OAP 需要 `storage.sqlite.project_db_location: shadow` 或等价配置，强制所有外部 repo 的 session/run/message/history 写入 `OAH_HOME/state`。

推荐配置形态：

```yaml
storage:
  sqlite:
    project_db_location: shadow # shadow | workspace
```

其中：

- `shadow` 是 OAP 默认。
- `workspace` 保留给显式选择 repo-local history 的高级用户或兼容模式。

### 7.4 Server profile 应成为客户端唯一判断依据

WebUI、TUI、Desktop 都不能靠 localhost、端口号或用户手动选择来判断 OAH/OAP。必须先读：

```http
GET /api/v1/system/profile
```

该 endpoint 应由 server bootstrap 根据实际配置和进程形态生成，而不是写死：

- 是否配置 PostgreSQL / Redis / object storage。
- process mode 是 `api_embedded_worker`、`api_only` 还是 `standalone_worker`。
- config profile 是否声明 `deploymentKind=oap`。
- local capabilities 是否可用。

### 7.5 Desktop 不承载 daemon，只监督 daemon

Desktop 应是通用 OAH-compatible client。它可以帮助安装、启动、停止、查看 OAP local daemon，但 daemon 生命周期应独立于 Electron renderer/main bundle：

- daemon 独立升级、独立日志、独立 token。
- Desktop 退出不应杀掉 daemon，除非用户显式 stop。
- TUI/WebUI/Desktop 连接同一 daemon endpoint。

### 7.6 OAS 直接落在 workspace，不引入私有 overlay

OAP 的 user-facing spec 应直接使用项目里的 OAS 文件，不再设计额外的本地私有 spec 层：

- 项目说明仍是 workspace 根目录 `AGENTS.md`。
- workspace memory 固定为 `.openharness/memory/MEMORY.md` 和 `.openharness/memory/*.md`。
- workspace tools 固定为 `.openharness/tools/settings.yaml` 与 `.openharness/tools/servers/*`。
- workspace skills 固定为 `.openharness/skills/*/SKILL.md`。
- 全局 `OAH_HOME/tools` 与 `OAH_HOME/skills` 只是可导入 catalog；真正启用必须写入 workspace。

这样做的好处是 WebUI、TUI、Desktop 看到同一个 effective workspace，也避免出现“daemon 里能用、repo 里看不到”的隐式配置。

### 7.7 Daemon 控制状态写入和清理

OAP 的 session、run、message、pending queue 和 history 写入应统一由 daemon 负责：

- 客户端只通过 OAH API 读写，不直接操作 SQLite。
- daemon 可以做 write batching、checkpoint、retention、cleanup 和 vacuum。
- workspace 维度按稳定 workspace id 分目录，避免多个 repo 共享同一个大文件。
- 默认写入 `OAH_HOME/state`，只在用户显式选择时写入 repo-local `.openharness/data/history.db`。

## 8. Implementation Risk Matrix

| Risk | Severity | Notes | Required mitigation |
| --- | --- | --- | --- |
| OAP 任意本地路径注册误开到企业服务 | High | 会让远端 OAH 暴露不该有的 local path 语义。 | 必须由 profile/capability gate 控制，默认 enterprise 关闭。 |
| SQLite 默认污染 repo | High | 当前 writable project 默认 repo-local history。 | 增加 shadow storage 配置并让 daemon profile 默认启用。 |
| 另起 OAP runtime / API | High | 会分叉协议和测试面。 | OAP 只包装现有 server bootstrap。 |
| Daemon token 与本地安全 | Medium | 本机服务也需要避免任意进程误用。 | loopback + token 文件 + 权限检查。 |
| Desktop 与 daemon 绑定过深 | Medium | 会造成 TUI/WebUI 与 Desktop 行为不一致。 | Desktop 只做 supervisor/client，不做 runtime boundary。 |
| 客户端绕过 daemon 直接写 SQLite | Medium | 会破坏 batching、retention 和跨客户端一致性。 | WebUI/TUI/Desktop 只通过 OAH API 访问状态。 |
| 全局 tools / skills 被误认为自动启用 | Medium | 会让 workspace 可复现性变差。 | 全局目录只做 catalog，启用时写入 repo `.openharness/tools` / `.openharness/skills`。 |
| model secret 写入 repo | Medium | 个人配置迁移时容易泄露 key。 | repo 只保存 model ref；provider secret 留在 `OAH_HOME` 或安全凭据源。 |
| Single workspace mode 继续扩张 | Medium | 会和 daemon registry 路线竞争。 | 仅保留兼容，新增能力落到 daemon registry。 |

## 9. Roadmap Phases

Status values:

- `done`: 已完成或足够稳定，不再作为 OAP active work 跟踪
- `in progress`: 已有基础，仍需继续实现
- `planned`: 方向明确，但尚未开始

### Phase 0: Home / Deploy Root Alignment

Status: in progress

Objective: 让 `OAH_HOME` 与 `OAH_DEPLOY_ROOT` 共享一套扁平资产结构，并保留多 deployment profile。

Completed:

- `template/deploy-root` 已扁平化为 `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/`。
- `config/server.docker.yaml` 已成为 Compose 默认 profile。
- `config/daemon.yaml` 已作为 local daemon profile 模板。
- `config/kubernetes.server.yaml` 已作为 K8S / Helm profile 模板。
- sync scripts 已优先识别扁平 root，并 fallback 到 legacy `source/`。
- `docs/home-and-deploy-root.md` 已记录目录契约。

Next:

- 提供 `oah daemon init` 或等价 bootstrap helper，初始化 `OAH_HOME`。
- 初始化时避免覆盖用户已有 config、models、runtimes、tools、skills。
- 为 `OAH_HOME` 写入版本标记，支持后续迁移。

Completion target:

- 空机器上执行 `oah daemon init` 后，`~/.openagentharness` 可直接启动 daemon。

### Phase 1: Deployment Identity API

Status: in progress

Objective: 让每个 OAH-compatible server 明确自报当前是 OAH enterprise server 还是 OAP local daemon，并暴露客户端可用能力。

Required endpoint:

```http
GET /api/v1/system/profile
```

Required fields:

- `apiCompatibility`: API compatibility string, initially `oah/v1`
- `product`: product family, initially `open-agent-harness`
- `edition`: `enterprise` or `personal`
- `runtimeMode`: `daemon`, `embedded`, `compose`, `kubernetes`, or `split`
- `deploymentKind`: `oah` or `oap`
- `displayName`: short user-facing label
- `capabilities`: feature flags for client behavior

Initial capability flags:

- `localDaemonControl`
- `localWorkspacePaths`
- `workspaceRegistration`
- `storageInspection`
- `modelManagement`
- `localDaemonSupervisor`

Completed:

- `GET /api/v1/system/profile` 已在 API server 暴露。
- `@oah/api-contracts` 已提供 `systemProfileSchema`。
- `ServerConfig.deployment` 已支持 `kind`、`runtime_mode`、`display_name`。
- `template/deploy-root/config/daemon.yaml` 默认声明 `kind=oap`、`runtime_mode=daemon`。
- `server.docker.yaml` 与 `kubernetes.server.yaml` 默认声明 OAH enterprise profile。

Next:

- WebUI / TUI / Desktop 连接后读取 profile，并用 capabilities 控制本地专属行为。
- OAP 后续 workspace registration 需要复用 `localWorkspacePaths` capability gate。

Completion target:

- WebUI、TUI、Desktop 都能通过同一个 endpoint 判断当前连接目标。
- 客户端不再用 URL、端口或是否 localhost 来推断 OAH/OAP。
- OAH enterprise server 默认不暴露 local path registration；OAP local daemon 默认暴露。

### Phase 2: Daemon Lifecycle CLI

Status: planned

Objective: 把当前开发期命令：

```bash
pnpm exec tsx --tsconfig ./apps/server/tsconfig.json ./apps/server/src/index.ts -- \
  --config "$OAH_HOME/config/daemon.yaml"
```

收敛成：

```bash
oah daemon start
```

Required commands:

- `oah daemon init`
- `oah daemon start`
- `oah daemon status`
- `oah daemon stop`
- `oah daemon restart`
- `oah daemon logs`

Daemon lifecycle requirements:

- PID file under `OAH_HOME/run/daemon.pid`
- local API token under `OAH_HOME/run/token` or equivalent secure local credential
- stdout/stderr logs under `OAH_HOME/logs/`
- health check against `http://127.0.0.1:8787`
- stale PID detection
- port conflict detection and actionable error output
- graceful shutdown before force kill

Completion target:

- 用户不需要知道 `tsx`、`apps/server/src/index.ts`、`--config` 或 repo-internal package layout。

### Phase 3: Workspace Registration

Status: planned

Objective: 用 daemon-managed workspace registry 替代 single workspace server mode。

Target command:

```bash
oah tui --workspace /path/to/repo
```

Expected behavior:

- 规范化 repo path。
- 如果 workspace 不存在，则创建 workspace record。
- 如果 workspace 已存在，则复用原有 workspace id、sessions 和 settings。
- 对外部 repo workspace，不要求复制到 `OAH_HOME/workspaces`。
- 对受管 workspace，可以放在 `OAH_HOME/workspaces`。
- TUI 默认连接本地 daemon，也可通过 `--base-url` 连接远端 OAH。
- 如果连接的是 OAH enterprise server，`--workspace /local/path` 应拒绝或提示切换到 OAP local daemon，除非 server profile 显式声明支持 local path registration。

Current implementation blocker:

- 现有 `/api/v1/workspaces/import` 在本地 embedded 模式下仍要求 `rootPath` 位于 `config.paths.workspace_dir` 内。
- 这个限制适合 OAH enterprise / managed workspace，但不适合 OAP 打开任意本机 repo。
- OAP 不能通过简单把 `workspace_dir` 设成 `/` 来绕过；那会污染 discovery、权限语义和误扫风险。

Required implementation:

- 新增 personal-only local registration 能力，或扩展 import endpoint 并以 profile/capability gate 控制。
- workspace record 需要稳定保存本地路径来源，建议 `externalRef=local:path:<normalized-abs-path>`。
- register/reuse 逻辑应该优先按 `externalRef` / normalized path 查找，而不是每次创建新 workspace。

Open design questions:

- 外部 repo workspace 的 `externalRef` 格式是否最终稳定为 `local:path:<abs-path>`，还是改为 URI-safe 编码。
- workspace name 默认用 repo basename，还是从 git remote / package metadata 推导。
- 如果同一路径被移动或重命名，是否提供 `oah workspace repair`。

Completion target:

- `oah tui --workspace /path/to/repo` 不再需要启动一个专属 server 进程。

### Phase 4: SQLite Shadow Storage

Status: in progress

Objective: OAP 的会话、run、message 和 history 默认留在 `OAH_HOME/state`，避免污染用户 repo。

Already available:

- `@oah/storage-sqlite` 已提供 workspace registry、session、message、run、run step、event store、pending run queue、audit record 和 history event repositories。
- server bootstrap 在未配置 PostgreSQL 时已经会创建 SQLite runtime persistence。
- `runtime_state_dir` 已能导向 shadow root，默认解析到 `runtime_state_dir/data/workspace-state`。

Current gap:

- `@oah/storage-sqlite` 当前对普通可写 project workspace 会优先写入 `<workspace>/.openharness/data/history.db`。
- OAP 更希望外部 repo workspace 的会话数据默认写入 home shadow storage。
- `ServerConfig.storage` 目前还没有 `sqlite` 子配置，schema 也还没有 `project_db_location`。
- daemon 还需要统一控制写入批处理、retention、cleanup 和 SQLite vacuum 策略。

Proposed config:

```yaml
storage:
  sqlite:
    project_db_location: shadow
```

Expected storage layout:

```text
~/.openagentharness/state/
  data/
    workspace-state/
      workspace-registry.db
      <workspace-id>/
        history.db
  __materialized__/
    <workspace-id>/
  archives/
    <workspace-id>/
```

Completion target:

- 打开任意外部 repo 后，OAP 不会默认生成 repo-local `.openharness/data/history.db`。
- 用户明确选择 workspace-local storage 时，才写入 repo-local `.openharness/data/history.db`。
- `@oah/storage-sqlite` 继续复用现有 registry/per-workspace DB 结构，只调整路径策略和配置面。
- WebUI、TUI、Desktop 都不直接写 SQLite，状态变更统一走 daemon API。

### Phase 5: Local Config And Asset Management

Status: planned

Objective: 让个人用户可以通过 CLI 管理模型、tools、skills 和默认 runtime，而不是手改 YAML。

Target commands:

```bash
oah models list
oah models add ./model.yaml
oah models default openai-default
oah runtimes list
oah tools list
oah skills list
```

Requirements:

- 修改 `OAH_HOME/models`、`tools`、`skills` 下的资产。
- `OAH_HOME/tools` 与 `OAH_HOME/skills` 只作为 catalog；启用到 repo 时写入 `.openharness/tools` / `.openharness/skills`。
- 校验 YAML schema。
- 修改 `config/daemon.yaml` 中的 `llm.default_model`。
- repo 可以不配置模型，默认使用 daemon 的 default model。
- repo 内只保存 model ref / alias，不保存 provider API key。
- 不影响 `config/server.docker.yaml` / `config/kubernetes.server.yaml`，除非用户显式同步 profile。

Completion target:

- OAP 用户能在不理解 deploy root 内部细节的情况下完成基本模型和能力配置。

### Phase 6: WebUI And TUI Client Defaults

Status: planned

Objective: 客户端默认面向 OAP 本地 daemon，但仍可连接远端 OAH enterprise server。

Shared client requirements:

- 连接后先读取 `GET /api/v1/system/profile`。
- 明确展示当前环境：`OAP local daemon` 或 `OAH enterprise server`。
- 根据 `capabilities` 控制 UI、命令和错误提示。

TUI requirements:

- `oah tui --workspace /path/to/repo` 默认连接本地 daemon。
- 如果 daemon 未运行，提示启动或自动启动。
- 支持 `--base-url` 覆盖到远端 OAH，并根据 profile 禁用个人本地专属行为。
- 支持 `--token` 或读取 local daemon token。
- workspace 创建 / 复用失败时给出明确修复建议。

Web requirements:

- `oah web` 可以打开本地 WebUI。
- WebUI 默认读本地 daemon endpoint。
- 仍支持手动配置远端 OAH endpoint。
- 连接远端 OAH 时不显示 local daemon control。

Completion target:

- 个人用户主要记住两个命令：`oah daemon start` 与 `oah tui --workspace .`。

### Phase 7: Desktop App

Status: planned

Objective: Electron 桌面端作为通用 OAH-compatible client。它既能连接远端 OAH enterprise server，也能连接 OAP local daemon；连接 OAP 时，可以额外承担 local daemon supervisor 职责。

Desktop responsibilities:

- 配置和切换 OAH-compatible API endpoint。
- 读取 server profile，并展示当前连接的是 OAH enterprise server 还是 OAP local daemon。
- 管理 endpoint token。
- 提供模型、tools、skills、workspace 和 session 的 GUI。
- 内嵌或打开 WebUI。
- 连接 OAP local daemon 时，检查 / 初始化 `OAH_HOME`。
- 连接 OAP local daemon 时，启停 local daemon、查看日志、管理本地 endpoint 和 token。
- 根据 server profile 判断是否显示 local daemon supervisor 功能。

Non-goals:

- 不 fork OAH API。
- 不在 Electron renderer 内直接跑 engine。
- 不绕过 daemon 直接读写 session DB。
- 连接远端 OAH 时，不显示本地 daemon stop/restart/logs。

Completion target:

- Desktop、TUI、WebUI 连接同一套 OAH-compatible API；连接 OAP 时共享同一个 local daemon。

### Phase 8: Migration And Deprecation

Status: planned

Objective: 从 single workspace mode 平滑迁移到 OAP daemon。

Steps:

1. README 将 single workspace mode 移入 legacy / compatibility。
2. CLI 对 `--workspace` server mode 输出迁移提示。
3. 提供迁移脚本，把 repo-local `.openharness/data/history.db` 导入 `OAH_HOME/state`。
4. 测试覆盖 `oah tui --workspace` 的 create/reuse/session resume。
5. 正式标记 single workspace server mode deprecated。

Completion target:

- 简化部署的正式答案只有 OAP daemon；single workspace mode 只保留给内部测试或兼容旧脚本。

## 10. Near-Term Implementation Order

建议按这个顺序推进：

1. `GET /api/v1/system/profile` 与 deployment capabilities
2. `storage.sqlite.project_db_location` 配置与 daemon profile 默认 shadow
3. personal-only local workspace registration API
4. `oah daemon init/start/status/stop/logs`
5. `OAH_HOME` bootstrap 与 daemon profile resolver
6. local daemon token、PID、logs、health check
7. `oah tui --workspace` 参数与 workspace register/reuse
8. README 中将 single workspace mode 标记为 legacy
9. `oah models` / `oah runtimes` / `oah tools` / `oah skills`
10. `oah web`
11. Electron desktop client and local daemon supervisor
12. single workspace migration / deprecation

## 11. Acceptance Scenarios

### Fresh local user

```bash
oah daemon start
oah models add ./openai-default.yaml
oah tui --workspace ~/Code/my-repo
```

Expected:

- `~/.openagentharness` is initialized.
- daemon is running on `127.0.0.1:8787`.
- `/api/v1/system/profile` reports `edition=personal` and `runtimeMode=daemon`.
- workspace is registered.
- session data is stored under `OAH_HOME/state`.
- repo is not polluted by default.

### Existing OAH developer

```bash
export OAH_DEPLOY_ROOT=/Users/me/Code/test_oah_server
pnpm local:up
```

Expected:

- Compose path continues to work.
- `/api/v1/system/profile` reports an OAH enterprise-compatible profile.
- `config/server.docker.yaml` remains the source profile.
- flat deploy root assets sync to MinIO.

### Hybrid user

```bash
export OAH_HOME=~/.openagentharness
export OAH_DEPLOY_ROOT=$OAH_HOME
oah daemon start
```

Expected:

- personal daemon reads local assets directly.
- the same home can later be used as a deploy root source for Compose / K8S profiles.

## 12. Non-Goals

- OAP should not replace OAH enterprise deployment.
- OAP should not require Docker, PostgreSQL, Redis, MinIO, or Kubernetes.
- OAP should not introduce a new API protocol.
- OAP should not make Electron the runtime boundary.
- OAP should not continue single workspace mode as the primary simplification story.
