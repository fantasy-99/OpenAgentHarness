# OAP Remaining Roadmap

OAP（Open Agent Harness Personal）是 OAH 的个人部署形态。它不是 OAH 的 fork，也不是新的 API 协议，而是：

```text
OAP daemon = existing OAH server + embedded worker + SQLite/local disk profile + daemon lifecycle wrapper
```

当前 OAP 主线已经落地：daemon lifecycle、server profile、local workspace registration、SQLite shadow storage、TUI/WebUI defaults、Desktop thin shell、`--runtime` 首次初始化语义都已经实现。这个文件不再记录已完成的 Phase 历史，只跟踪剩余待办。

## Current Contract

这些约定已经稳定，后续实现应保持一致：

- OAP 全称是 Open Agent Harness Personal。
- OAH enterprise server 与 OAP local daemon 暴露同一套 OAH-compatible API。
- WebUI、TUI、Desktop 都是通用客户端，不绑定某一种部署形态。
- 客户端连接后必须读取 `GET /api/v1/system/profile`，用 profile / capabilities 判断当前是 OAH 还是 OAP。
- Desktop 是 WebUI 的 Electron thin shell，可以监督本地 daemon，但 daemon 始终是独立进程。
- `OAH_HOME` 默认是 `~/.openagentharness`，本机个人场景下也可以作为 `OAH_DEPLOY_ROOT`。
- OAP 默认使用 `OAH_HOME/config/daemon.yaml`、SQLite、embedded worker、本地磁盘和 `OAH_HOME/state`。
- 外部 repo workspace 不复制进 `OAH_HOME/workspaces`；`OAH_HOME/workspaces` 只用于受管 workspace。
- `OAH_HOME/tools` 与 `OAH_HOME/skills` 是全局 catalog，启用到项目时必须写入 repo 的 `.openharness/tools` / `.openharness/skills`。
- OAS 是用户层配置，直接放在 repo 内，例如 `AGENTS.md`、`.openharness/tools`、`.openharness/skills`、`.openharness/memory/MEMORY.md`。
- `oah tui` 默认把当前目录视为 workspace；`--workspace` 可显式指定路径。
- `oah tui --runtime <name>` 只在目标目录没有 `.openharness/` 时用于首次 bootstrap；已有 `.openharness/` 时保留现有 OAS 配置。
- single workspace server mode 只作为 legacy / compatibility 入口，不再作为个人本地部署主线。

## Done Baseline

以下能力已经完成，不再作为 active roadmap 跟踪：

- `GET /api/v1/system/profile` 与 deployment capabilities。
- `template/deploy-root` 扁平化为 `models/`、`runtimes/`、`tools/`、`skills/`、`workspaces/`、`config/`、`state/`、`logs/`、`run/`。
- `config/daemon.yaml`、`config/server.docker.yaml`、`config/kubernetes.server.yaml` 多 profile 结构。
- `oah daemon init/start/status/stop/restart/logs`。
- daemon PID、token、logs、health check、stale PID 和端口冲突处理。
- personal-only `POST /api/v1/local/workspaces/register`。
- 外部 repo workspace 的 register / reuse。
- `storage.sqlite.project_db_location: shadow | workspace`。
- OAP daemon 默认使用 shadow storage，避免把 session/run/history 默认写进 repo-local `.openharness/data/history.db`。
- `oah models list/add/default`、`oah runtimes list`、`oah tools list`、`oah skills list`。
- CLI/TUI 默认解析本地 daemon endpoint 与 token。
- `oah web` 使用同一 OAH-compatible API endpoint。
- WebUI dev proxy 支持 `OAH_WEB_PROXY_TARGET`、`OAH_CONFIG`、`OAH_HOME/config/daemon.yaml`。
- `apps/desktop` Electron thin shell。
- README 与正式 docs 已写入 OAH/OAP/OAR/OAS 分层、OAP daemon、本地目录和 TUI 默认工作流。

## Remaining Work

### 1. Local API Auth Enforcement

Status: planned

Goal: 让 daemon 生成的 local token 真正成为本地 API 访问保护，而不只是客户端连接信息。

Tasks:

- [ ] 在 server HTTP 层支持 local token enforcement。
- [ ] 仅对 OAP local daemon profile 默认启用，避免影响 OAH enterprise 部署。
- [ ] 允许 health check 或明确的 public endpoints 按需免 token。
- [ ] CLI/TUI/WebUI/Desktop 统一通过 `OAH_HOME/run/token` 或 launcher handoff 获取 token。
- [ ] token 缺失、失效、权限错误时给出可操作修复提示。
- [ ] 增加 HTTP、CLI、TUI、WebUI smoke 覆盖。

Acceptance:

- 未携带 token 的本地 API 请求不能读写 workspace/session/run 数据。
- `oah tui`、`oah web`、Desktop 在默认 OAP 场景下无需用户手动复制 token。

### 2. Packaged `oah web`

Status: planned

Goal: 非 repo 开发环境下，`oah web` 也能启动可用 WebUI，而不是依赖 Vite dev server。

Tasks:

- [ ] 构建并定位 WebUI static bundle。
- [ ] CLI/runtime assets 中包含 WebUI dist。
- [ ] `oah web` 在 packaged install 下启动静态资源服务或打开已打包资源。
- [ ] 保持开发环境下 `OAH_WEB_PROXY_TARGET` / Vite proxy 行为。
- [ ] 支持远端 OAH endpoint 与本地 OAP daemon endpoint 切换。

Acceptance:

- 用户安装 CLI 后执行 `oah web`，无需进入仓库也能打开 WebUI。
- WebUI 空 base URL 默认连接 OAP local daemon。

### 3. Desktop Productization

Status: planned

Goal: 把 Desktop 从开发期 thin shell 推进到可分发桌面客户端。

Tasks:

- [ ] 增加正式应用图标、名称、bundle identifier。
- [ ] 打包 WebUI static bundle。
- [ ] 增加 macOS signing / notarization 路线。
- [ ] 评估自动更新机制。
- [ ] 增加 endpoint profile switcher，清晰切换本地 OAP 与远端 OAH。
- [ ] 增加本地 daemon supervisor 面板：init/start/stop/restart/logs、endpoint/token 状态、`OAH_HOME` 位置。
- [ ] 若启用 local API auth，Desktop 提供 token handoff 或 secure storage。

Acceptance:

- Desktop 可以作为通用 OAH-compatible client 使用。
- 连接远端 OAH 时不显示本地 daemon stop/restart/logs 等 OAP 专属操作。
- 连接本地 OAP 时可以管理 daemon，但 Desktop 退出不会停止 daemon。

### 4. Workspace Asset Enable / Import Commands

Status: planned

Goal: 让全局 catalog 中的 tools / skills 能显式加载到当前 workspace，保持可复现性。

Tasks:

- [ ] 设计 `oah tools enable <name>` / `oah skills enable <name>` 或等价命令。
- [ ] 默认作用于当前目录的 `.openharness`。
- [ ] 支持 `--workspace <path>` 指定目标 repo。
- [ ] 写入 `.openharness/tools` / `.openharness/skills`，而不是只写 daemon 内部状态。
- [ ] 冲突时提示 overwrite / merge 策略。
- [ ] 增加 dry-run 或 diff preview。
- [ ] 更新 TUI / WebUI 中对全局 catalog 与 workspace enabled assets 的展示差异。

Acceptance:

- 全局 catalog 不会被误认为自动启用。
- 项目迁移到另一台机器后，可以从 repo 的 `.openharness` 看出实际启用了哪些能力。

### 5. Workspace Repair And Move Handling

Status: planned

Goal: 处理本地 repo 移动、重命名、软链接变化后 workspace registry 的修复。

Tasks:

- [ ] 增加 `oah workspaces list` 或复用现有 workspace listing。
- [ ] 增加 `oah workspace repair` / `oah workspaces repair` 命令。
- [ ] 检测 registry 中 rootPath 不存在的 workspace。
- [ ] 支持把旧 workspace record 重新绑定到新的本地路径。
- [ ] 保留原有 session/run/history。
- [ ] 明确 `externalRef=local:path:<realpath>` 的稳定格式与迁移策略。

Acceptance:

- 用户移动 repo 后可以恢复旧 session，而不是创建一套新的 workspace 历史。

### 6. Repo-Local History Migration

Status: planned

Goal: 帮助早期用户把 repo-local `.openharness/data/history.db` 导入 OAP shadow storage。

Tasks:

- [ ] 探测 repo-local `.openharness/data/history.db`。
- [ ] 增加迁移命令，例如 `oah workspace migrate-history`。
- [ ] 导入到 `OAH_HOME/state/data/workspace-state/<workspace-id>/history.db`。
- [ ] 避免重复导入。
- [ ] 提供备份与 dry-run。
- [ ] 记录迁移结果。

Acceptance:

- 旧 repo-local history 可以迁移到 OAP 默认 shadow storage。
- 迁移不会破坏原始 history.db。

### 7. Daemon Storage Maintenance

Status: planned

Goal: 让 OAP daemon 主动管理 SQLite 和本地 state 的长期健康。

Tasks:

- [ ] 增加 SQLite checkpoint 策略。
- [ ] 增加 retention policy：sessions、runs、events、archives。
- [ ] 增加 cleanup / vacuum 命令或 daemon maintenance job。
- [ ] 为 `OAH_HOME/state` 提供 size summary。
- [ ] 在 `oah daemon status` 或单独命令中显示 state usage。
- [ ] 确保维护任务不影响活跃 run。

Acceptance:

- 长期本地使用不会无限积累不可见状态。
- 用户能看见并清理 OAP state 占用。

### 8. Single Workspace Legacy Deprecation

Status: planned

Goal: 把旧的 server `--workspace` 单 workspace 模式明确标为兼容入口，避免继续分叉产品路径。

Tasks:

- [ ] server `--workspace` 启动时输出 deprecation warning。
- [ ] 文档中保留 legacy 用法，但主路径指向 `oah daemon start` + `oah tui`。
- [ ] 确认测试仍覆盖 legacy 行为，防止短期破坏旧脚本。
- [ ] 新功能不再优先支持 single workspace server mode。

Acceptance:

- 新用户不会把 single workspace server mode 当作 OAP 推荐路径。
- 老脚本短期仍能运行。

### 9. TUI Session Resume Polish

Status: planned

Goal: 让 `oah tui` 默认进入当前 workspace 后，有更顺滑的 session 续接体验。

Tasks:

- [ ] 默认选择当前 workspace 最近 session，或在无 session 时创建新 session。
- [ ] 提供清晰的 session picker。
- [ ] 对 queued/running/completed session 给出不同提示。
- [ ] 支持通过参数显式选择新建 session 或恢复最近 session。

Acceptance:

- 用户在 repo 内执行 `oah tui` 后，可以很快回到上次对话或开始新对话。

### 10. Packaged Runtime Assets

Status: planned

Goal: 让 OAP 不依赖仓库源码路径也能初始化和启动。

Tasks:

- [ ] 打包 server entrypoint。
- [ ] 打包 `template/deploy-root`。
- [ ] 打包默认 runtimes、models、tools、skills 样例。
- [ ] daemon init 从 packaged assets 初始化 `OAH_HOME`。
- [ ] 保持 monorepo 开发模式与 packaged install 模式一致。

Acceptance:

- 用户通过发布包安装后可以直接执行 `oah daemon init` / `oah daemon start`。

## Validation Checklist

每完成一个剩余项，至少确认：

- [ ] `pnpm exec tsc -b --pretty false`
- [ ] `pnpm exec vitest run`
- [ ] `git diff --check`
- [ ] `mkdocs build --strict --site-dir /tmp/oah-mkdocs-site`
- [ ] 相关 daemon / TUI / WebUI / Desktop smoke 覆盖

## Non-Goals

- OAP 不替代 OAH enterprise deployment。
- OAP 不要求 Docker、PostgreSQL、Redis、MinIO 或 Kubernetes。
- OAP 不引入新的 API protocol。
- OAP 不把 Electron 作为 runtime boundary。
- OAP 不继续把 single workspace server mode 作为个人本地使用主线。
