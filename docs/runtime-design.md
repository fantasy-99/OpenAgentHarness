# Engine Design

该文档已拆分为按执行链路组织的 engine 设计目录，便于分别查看 lifecycle、context engine、projection、hook runtime、backend、队列与可靠性，以及事件审计。

主入口见：

- [engine/README.md](./engine/README.md)

推荐阅读顺序：

1. [engine/README.md](./engine/README.md)
2. [engine/lifecycle.md](./engine/lifecycle.md)
3. [engine/context-engine.md](./engine/context-engine.md)
4. [engine/projection-and-executors.md](./engine/projection-and-executors.md)
5. [engine/hook-runtime.md](./engine/hook-runtime.md)
6. [engine/execution-backend.md](./engine/execution-backend.md)
7. [engine/queue-and-reliability.md](./engine/queue-and-reliability.md)
8. [engine/events-and-audit.md](./engine/events-and-audit.md)
