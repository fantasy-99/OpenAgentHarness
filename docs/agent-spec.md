# Agent Spec

`Agent Spec` 在当前仓库中专指“用户叠加给 runtime 的扩展层”，不是整个 workspace 结构的总称。

当前 `Spec` 主要包括：

- `AGENTS.md`
- `MEMORY.md`
- 额外加载的 `model`
- 额外加载的 `tool`
- 额外加载的 `skill`

不属于 `Spec` 的内容：

- agent 定义
- action 定义
- hook 定义
- runtime 本体结构

完整边界说明见：

- [terminology.md](./terminology.md)

workspace 结构与运行时能力定义仍按主题文档组织，主入口见：

- [workspace/README.md](./workspace/README.md)

推荐阅读顺序：

1. [workspace/README.md](./workspace/README.md)
2. [workspace/agents.md](./workspace/agents.md)
3. [workspace/models.md](./workspace/models.md)
4. [workspace/skills.md](./workspace/skills.md)
5. [workspace/mcp.md](./workspace/mcp.md)
6. [workspace/loading-and-validation.md](./workspace/loading-and-validation.md)
