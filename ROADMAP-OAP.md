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

Status: done

Goal: 让 daemon 生成的 local token 真正成为本地 API 访问保护，而不只是客户端连接信息。

Tasks:

- [x] 在 server HTTP 层支持 local token enforcement。
- [x] 仅对 OAP local daemon profile 默认启用，避免影响 OAH enterprise 部署。
- [x] 允许 health check、server profile、OpenAPI / docs 等明确 public endpoints 免 token。
- [x] CLI/TUI/WebUI/Desktop 统一通过 `OAH_HOME/run/token`、proxy header 或 launcher handoff 获取 token。
- [x] token 缺失、失效、权限错误时返回明确 `401 unauthorized`。
- [x] 增加 HTTP 覆盖；CLI/TUI/WebUI/Desktop 复用已有 bearer token 连接路径。

Acceptance:

- 未携带 token 的本地 API 请求不能读写 workspace/session/run 数据。
- `oah tui`、`oah web`、Desktop 在默认 OAP 场景下无需用户手动复制 token。

### 2. Packaged `oah web`

Status: done

Goal: 非 repo 开发环境下，`oah web` 也能启动可用 WebUI，而不是依赖 Vite dev server。

Tasks:

- [x] 构建并定位 WebUI static bundle。
- [x] CLI 可通过 `OAH_WEB_DIST`、monorepo `apps/web/dist` 或 packaged `web/dist` 定位 WebUI dist。
- [x] `oah web` 在存在 static bundle 时启动内置静态 WebUI + API proxy。
- [x] 找不到 static bundle 时保持现有 `@oah/web` Vite dev server 回退。
- [x] 支持远端 OAH endpoint 与本地 OAP daemon endpoint 切换，并在代理请求中自动带 bearer token。

Acceptance:

- 用户安装 CLI 后执行 `oah web`，无需进入仓库也能打开 WebUI。
- WebUI 空 base URL 默认连接 OAP local daemon。

### 3. Desktop Productization

Status: done

Goal: 把 Desktop 从开发期 thin shell 推进到可分发桌面客户端。

Tasks:

- [x] 增加正式应用名称、bundle identifier / appId。
- [x] 打包 WebUI static bundle 的资源映射与运行时查找逻辑。
- [x] 复用现有 WebUI favicon 作为 Desktop 窗口 / 打包图标候选。
- [x] 增加 unsigned directory packaging 入口。
- [x] 支持通过环境变量 / WebUI connection settings 切换本地 OAP 与远端 OAH endpoint。
- [x] 增加基础本地 daemon supervisor 菜单：start/reconnect/logs、`OAH_HOME` 位置。
- [x] 若启用 local API auth，Desktop 通过 local daemon token handoff 注入 WebUI connection settings。

Acceptance:

- Desktop 可以作为通用 OAH-compatible client 使用。
- 连接远端 OAH 时不显示本地 daemon stop/restart/logs 等 OAP 专属操作。
- 连接本地 OAP 时可以管理 daemon，但 Desktop 退出不会停止 daemon。

Deferred release hardening:

- macOS signing / notarization。
- 自动更新机制。
- 完整 daemon supervisor 面板：init/stop/restart/logs、endpoint/token 状态、`OAH_HOME` 位置。
- 更完整的 endpoint profile switcher UI。

### 4. Workspace Asset Enable / Import Commands

Status: implemented

Goal: 让全局 catalog 中的 tools / skills 能显式加载到当前 workspace，保持可复现性。

Tasks:

- [x] 设计 `oah tools enable <name>` / `oah skills enable <name>` 命令。
- [x] 默认作用于当前目录的 `.openharness`。
- [x] 支持 `--workspace <path>` 指定目标 repo。
- [x] 写入 `.openharness/tools` / `.openharness/skills`，而不是只写 daemon 内部状态。
- [x] 冲突时提示 `--overwrite` 策略。
- [x] 增加 `--dry-run` 写入预览。
- [x] 更新 README / TUI 文档中对全局 catalog 与 workspace enabled assets 的展示差异说明。

Acceptance:

- `tools list` / `skills list` 只表示 `OAH_HOME` 的全局 catalog，不等同于 workspace 已启用。
- `tools enable` 会写入 `.openharness/tools/settings.yaml`，并在存在本地 server 目录时复制到 `.openharness/tools/servers/<name>`。
- `skills enable` 会复制 skill 目录到 `.openharness/skills/<name>`。
- 项目迁移到另一台机器后，可以从 repo 的 `.openharness` 看出实际启用了哪些能力。

### 5. Workspace Repair And Move Handling

Status: implemented

Goal: 处理本地 repo 移动、重命名、软链接变化后 workspace registry 的修复。

Tasks:

- [x] 复用并增强现有 `oah workspace:list` / `oah workspaces` listing。
- [x] 增加 `oah workspace repair <workspace-id>` / `oah workspaces repair <workspace-id>`，并保留兼容别名 `oah workspaces:repair <workspace-id>`。
- [x] 增加 `workspace:list --missing` 检测 registry 中 rootPath 不存在的本地 workspace。
- [x] 支持把旧 workspace record 重新绑定到新的本地路径。
- [x] 保留原有 workspace id，从而保留 session/run/history 归属。
- [x] 明确 `externalRef=local:path:<resolved-path>` 的稳定格式与迁移策略。

Acceptance:

- 用户移动 repo 后可以用 `workspace repair` 恢复旧 session，而不是创建一套新的 workspace 历史。
- 修复仅在 OAP personal local daemon profile 下可用，避免误用于企业远端 OAH。
- 如果目标路径已经被注册为另一个 workspace，服务端会返回冲突，避免误删另一套历史。

### 6. Repo-Local History Migration

Status: implemented

Goal: 帮助早期用户把 repo-local `.openharness/data/history.db` 导入 OAP shadow storage。

Tasks:

- [x] 探测 repo-local `.openharness/data/history.db`。
- [x] 增加迁移命令：`oah workspace migrate-history` / `oah workspaces migrate-history`。
- [x] 导入到 `OAH_HOME/state/data/workspace-state/<workspace-id>/history.db`。
- [x] 避免重复导入：目标 shadow history 已存在时默认拒绝。
- [x] 提供 `--dry-run`、`--overwrite`，覆盖时默认备份旧 shadow history，可用 `--no-backup` 关闭。
- [x] 记录迁移结果到 `history.migration.json`。

Acceptance:

- 旧 repo-local history 可以迁移到 OAP 默认 shadow storage。
- 迁移会同时复制存在的 `history.db-wal` / `history.db-shm`。
- 迁移不会删除或修改原始 repo-local `history.db`。

### 7. Daemon Storage Maintenance

Status: baseline implemented

Goal: 让 OAP daemon 主动管理 SQLite 和本地 state 的长期健康。

Tasks:

- [x] 增加手动 SQLite checkpoint 策略：`oah daemon maintenance` 默认执行 WAL checkpoint/truncate。
- [ ] 增加 retention policy：sessions、runs、events、archives。
- [x] 增加 cleanup / vacuum 命令：`oah daemon maintenance` 支持 checkpoint / vacuum / dry-run。
- [x] 为 `OAH_HOME/state` 提供 size summary：`oah daemon state`。
- [x] 在单独命令中显示 state usage。
- [x] 确保维护任务不影响活跃 run：默认检测到 daemon 正在运行时拒绝维护，需显式 `--force`。

Acceptance:

- 用户能看见 OAP state 占用，并能手动 checkpoint/vacuum shadow SQLite 数据库。
- 破坏性 retention 策略仍待后续单独设计，默认不删除 session/run/event 历史。

### 8. Single Workspace Legacy Deprecation

Status: baseline implemented

Goal: 把旧的 server `--workspace` 单 workspace 模式明确标为兼容入口，避免继续分叉产品路径。

Tasks:

- [x] server `--workspace` 启动时输出 deprecation warning。
- [x] 文档中保留 legacy 用法，但主路径指向 `oah daemon start` + `oah tui`。
- [x] 确认测试仍覆盖 legacy 行为，防止短期破坏旧脚本。
- [x] 新功能不再优先支持 single workspace server mode。

Acceptance:

- 新用户不会把 single workspace server mode 当作 OAP 推荐路径。
- 老脚本短期仍能运行。

### 9. TUI Session Resume Polish

Status: baseline implemented

Goal: 让 `oah tui` 默认进入当前 workspace 后，有更顺滑的 session 续接体验。

Tasks:

- [x] 默认选择当前 workspace 最近 session，或在无 session 时创建新 session。
- [x] 提供清晰的 session picker。
- [x] 对 queued/running/completed session 给出不同提示。
- [x] 支持通过参数显式选择新建 session 或恢复最近 session。

Acceptance:

- 用户在 repo 内执行 `oah tui` 后，可以很快回到上次对话或开始新对话。

### 10. Packaged Runtime Assets

Status: baseline implemented

Goal: 让 OAP 不依赖仓库源码路径也能初始化和启动。

Tasks:

- [x] 打包 server entrypoint。
- [x] 打包 `template/deploy-root`。
- [x] 打包默认 runtimes、models、tools、skills 样例。
- [x] daemon init 从 packaged assets 初始化 `OAH_HOME`。
- [x] 保持 monorepo 开发模式与 packaged install 模式一致。

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
