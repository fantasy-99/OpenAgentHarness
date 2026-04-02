# 当前进度

这页是文档站里的路线图入口，用来说明“项目现在到哪一步了”。

仓库里还维护了一份独立的 `ROADMAP.md`，内容会比这里更新得更频繁；为了让文档站内链接保持可浏览，这里给出一个稳定入口和阅读建议。

## 建议怎么看

- 想了解产品与架构边界：先看 [架构总览](./architecture-overview.md)
- 想知道如何启动和部署：看 [快速开始](./getting-started.md) 与 [部署与运行](./deploy.md)
- 想知道历史设计顺序：看 [实施路线](./implementation-roadmap.md)

## 当前仓库的重点方向

结合现有设计文档，可以把当前演进重点概括为：

- 维持当前运行时真值边界，让实现、设计和 OpenAPI 描述持续一致
- 在需要时，再评估更激进的恢复策略，例如自动重新入队 / 续跑，而不是只做 fail-closed recovery
- 将已明确延期的能力继续保持为“候选项”而不是“默认承诺”，例如 Unix socket 模型网关、`action_run` / `artifact` 一等化

## 仓库内原始台账

如果你是在 GitHub 仓库中阅读源码，也可以直接查看根目录里的路线图文件：

- [仓库 ROADMAP.md](https://github.com/fairyshine/OpenAgentHarness/blob/master/ROADMAP.md)
