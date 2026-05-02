# OAP Release Hardening

OAP（Open Agent Harness Personal）是 OAH 的个人部署形态。它不是 OAH 的 fork，也不是新的 API 协议，而是：

```text
OAP daemon = existing OAH server + embedded worker + SQLite/local disk profile + daemon lifecycle wrapper
```

OAP 主线 baseline 已经落地：daemon lifecycle、local API auth、server profile、local workspace registration、SQLite shadow storage、workspace asset enable、history migration、state maintenance、TUI/WebUI defaults、Desktop thin shell、packaged runtime assets、`--runtime` 首次初始化语义都已经实现。

本文只跟踪剩余发布加固项，不再记录已完成的 Phase 历史。

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

## Remaining Work

### 1. Workspace State Cleanup

Goal: 以 workspace 为单位管理 OAP state 占用，保持可观察、可预览、默认保守。

Tasks:

- [x] `oah daemon state` 按 workspace 显示 state 占用。
- [x] 提供 workspace-level cleanup 入口：`oah workspace cleanup <workspace-id>`。
- [x] 默认只清理 cache、临时 materialized 文件、可重建状态；不自动删除会话历史。
- [x] 如需删除某个 workspace 的 session / run / event history，必须显式指定 workspace、`--dry-run` 预览并二次确认。
- [x] 增加 workspace 级清理测试，覆盖误删保护。

Acceptance:

- 用户能按 workspace 看见和处理 OAP state 占用。
- 默认行为不会删除 session / run / event 历史。
- 破坏性清理必须以 workspace 为边界显式开启并可预览。

### 2. Desktop Release Hardening

Goal: 让 Desktop 从可运行 thin shell 进一步成为可分发桌面客户端。

Tasks:

- [ ] macOS signing / notarization。
- [ ] 自动更新机制。
- [ ] 完整 daemon supervisor 面板：init / stop / restart / logs / endpoint / token / `OAH_HOME` 状态。
- [ ] 更完整的 endpoint profile switcher UI。
- [ ] 桌面端安装包 smoke：连接本地 OAP、远端 OAH、切换 endpoint、打开 WebUI。

Acceptance:

- Desktop 可以被普通用户安装和启动。
- 连接 OAP 时本地 daemon 管理能力清晰可见。
- 连接 OAH enterprise 时不会暴露 OAP-only 控制项。

### 3. Package Release Engineering

Goal: 从 monorepo baseline 走向可发布、可安装、可回滚的包体系。

Tasks:

- [x] 增加 GitHub Release tarball layout：`versions/<version>`、`current`、`bin/oah`。
- [x] 增加一行安装脚本：下载 tarball、校验 `.sha256`、安装到 `OAH_HOME`。
- [x] 增加 `oah version` / `oah update` / `oah rollback`。
- [x] 增加 release bundle 构建脚本与 GitHub Release workflow baseline。
- [ ] 决定哪些 `@oah/*` 包解除 `private`。
- [ ] 明确 npm / registry 发布顺序与版本同步策略。
- [ ] 增加 clean-install smoke：在全新目录安装发布包后执行 `oah daemon init` / `oah daemon start` / `oah tui`。
- [ ] 检查 package `files`、exports、bin、runtime assets、WebUI assets、server entrypoint。
- [ ] 增加发布前 CI gate，覆盖 pack tarball 内容检查与安装后 smoke。
- [ ] 评估包签名、SBOM、release provenance。

Acceptance:

- 用户不需要源码 checkout 也能安装 CLI 并启动 OAP daemon。
- tarball / registry install 与 monorepo 开发模式使用同一套 OAP 目录语义。
- 发布失败时有明确回滚路径。

## Validation Checklist

每完成一个剩余项，至少确认：

- [ ] `pnpm exec tsc -b --pretty false`
- [ ] `pnpm exec vitest run`
- [ ] `pnpm build`
- [ ] `git diff --check`
- [ ] `mkdocs build --strict --site-dir /tmp/oah-mkdocs-site`
- [ ] 相关 daemon / TUI / WebUI / Desktop smoke 覆盖

## Non-Goals

- OAP 不替代 OAH enterprise deployment。
- OAP 不要求 Docker、PostgreSQL、Redis、MinIO 或 Kubernetes。
- OAP 不引入新的 API protocol。
- OAP 不把 Electron 作为 runtime boundary。
- OAP 不继续把 single workspace server mode 作为个人本地使用主线。
