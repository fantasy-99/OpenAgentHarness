# Queue And Reliability

## 队列与并发

### 队列原则

- 一个 session 一条逻辑队列
- 一个 session 同时只有一个 worker 持锁执行
- 不同 session 的 run 可以并发

### 建议做法

- Redis list 或 stream 保存 session 队列
- Redis lock 控制 session 执行权
- PostgreSQL 记录 run 最终状态
- `history.db` 通过异步 mirror sync 写入，不进入主调度链路

### 为什么不用单纯数据库锁

只用 PostgreSQL 也能做，但会在以下方面更笨重：

- 高频调度效率低
- 分布式 worker 扩展不自然
- 实时队列可观测性差

## 取消、超时与失败恢复

### 取消

- 调用方可通过 API 取消 run
- worker 轮询取消标记
- 对 shell 子进程发送终止信号
- 对 MCP 调用和子流程做 best-effort cancellation

### 超时

需要区分：

- run 总超时
- 单次模型调用超时
- 单次工具调用超时

### 恢复

worker 重启后：

- 从 PostgreSQL 扫描 `running` 且长时间未 heartbeat 的 run
- 根据恢复策略标记为 `failed` 或重新排队

## 本地历史镜像可靠性

### 同步原则

- PostgreSQL 是唯一事实源
- `.openharness/data/history.db` 是单向异步镜像
- 镜像同步失败不影响 run 执行和队列推进

### 建议做法

- 中心库在写入业务记录时，同事务追加 history event
- 独立 syncer 按 `workspace_id + event_id` 拉取增量
- 本地 SQLite 采用幂等 upsert
- 成功后推进本地同步游标

### 恢复

- syncer 重启后从本地 `last_event_id` 继续同步
- 本地镜像缺失时可从头回放
- 本地镜像损坏时可删除并重建

### 故障边界

- 中心库故障会影响在线请求
- Redis 故障会影响调度
- 本地镜像故障只影响备份和离线检视，不影响在线执行
