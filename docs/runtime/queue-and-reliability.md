# Queue And Reliability

## 队列与并发

默认部署：`server` 以 `API + embedded worker` 模式运行。需拆分时使用 `server --api-only` + 独立 `worker`。

### 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 可并发

### 当前实现

| 能力 | 状态 |
| --- | --- |
| 同 session 串行执行 | done |
| embedded worker 模式 | done |
| Redis 队列/锁（无 Redis 时退回 in-process） | done |
| heartbeat 落库 | done |
| 分布式可靠性（串行 + 取消 + 超时 + heartbeat + stale run 回收） | partial |
| 启动时扫描 heartbeat 过期 run 并回收 | partial |

### 建议做法

- Redis list / stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态
- `history.db` 异步 mirror sync，不进入主调度链路

为什么不用单纯数据库锁：高频调度效率低、分布式扩展不自然、实时队列可观测性差。

## 取消、超时与恢复

### 取消

- API 取消 run → worker 检查取消标记 → shell 子进程发终止信号 → 外部调用 best-effort cancellation

### 超时

| 类型 | 状态 |
| --- | --- |
| run 总超时 | done |
| 单次工具调用超时 | done |
| hook 超时（不阻断 run，发通知事件） | done |
| 单次模型调用超时 | partial（hook 层有，主模型流以 run 总超时为主） |

### 恢复

| 能力 | 状态 |
| --- | --- |
| 基于 heartbeat 的启动恢复扫描 | done |
| stale run 标记为 `failed`（fail-closed） | done |
| 自动重新排队 / 续跑 | missing |

## 本地历史镜像

### 同步原则

- PostgreSQL 是唯一事实源
- `.openharness/data/history.db` 是单向异步镜像
- 镜像同步失败不影响 run 执行

### 做法

中心库写入时追加 history event → 独立 syncer 按 `workspace_id + event_id` 拉增量 → 本地 SQLite 幂等 upsert → 推进同步游标。

### 恢复

- syncer 从 `last_event_id` 继续
- 镜像缺失可从头回放
- 镜像损坏可删除重建

### 故障边界

| 故障 | 影响 |
| --- | --- |
| 中心库 | 在线请求 |
| Redis | 调度 |
| 本地镜像 | 仅备份和离线检视 |

## 当前边界

- 生产执行：已具备取消、run/tool 超时、hook 非阻断超时通知
- worker 崩溃后 run 卡住：不会，stale run 在后续 worker 启动时回收为失败态
- worker 崩溃后 run 自动续跑：不能，需外部编排或人工重试
