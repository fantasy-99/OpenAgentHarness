# Workspace

Workspace 是能力发现的主边界。用户打开项目后，运行时从项目根目录自动发现全部能力，无需全局配置。

## Workspace 不是 Sandbox

这两个概念很容易混，但边界不同：

| 概念 | 边界 | 说明 |
| --- | --- | --- |
| `Workspace` | 逻辑 / 项目 / 能力边界 | 描述 agent 正在处理哪个项目，以及该项目声明了哪些 agent、model、tool、skill、hook |
| `Sandbox` | 执行宿主边界 | 描述这些能力最终在哪个本地文件系统与进程环境里执行 |

因此：

- `workspace` 负责定义“是什么项目、有哪些能力”
- `sandbox` 负责定义“在哪个宿主里执行”
- 活跃 workspace 会被 materialize 成 owner worker 持有的 `Active Workspace Copy`
- 在 `embedded` 模式下，这个副本通常就是本机目录
- 在 `self_hosted / e2b` 模式下，这个副本通常位于远端 sandbox 内

## Workspace 类型

当前只保留一种标准 workspace 形态：在同一目录结构内声明 agents、models、actions、skills、tools、hooks，并由运行时统一发现与执行。

## 目录结构

完整结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    prompts.yaml
    data/
      history.db
    agents/
      planner.md
      builder.md
      reviewer.md
    models/
      GPT.yaml
      Kimi-K25.yaml
    actions/
      code-review/
        ACTION.yaml
      run-tests/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
        scripts/
        references/
      doc-reader/
        SKILL.md
    tools/
      settings.yaml
      servers/
        docs-server/
        browser/
    hooks/
      redact-secrets.yaml
      policy-guard.yaml
      scripts/
      prompts/
      resources/
```

最小可用结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    prompts.yaml
    agents/
      builder.md
    models/
      openai.yaml
```

## 自动发现规则

运行时在 run 启动时扫描以下路径：

| 路径 | 用途 |
| --- | --- |
| `AGENTS.md` | 项目说明文档，注入 system prompt |
| `.openharness/settings.yaml` | 总配置入口 |
| `.openharness/prompts.yaml` | Workspace prompt 配置 |
| `.openharness/agents/*.md` | Agent 定义 |
| `.openharness/models/*.yaml` | 模型入口 |
| `.openharness/actions/*/ACTION.yaml` | Action 定义 |
| `.openharness/skills/*/SKILL.md` | Skill 定义 |
| `.openharness/tools/settings.yaml` | MCP tool server 注册 |
| `.openharness/tools/servers/*` | 本地 tool server 代码 |
| `.openharness/hooks/*.yaml` | Hook 定义 |

!!! info

    `.openharness/data/` 是运行时托管目录，不参与能力定义解析。`history.db` 只承载本地运行时数据，不是跨进程同步机制。

!!! info

    `AGENTS.md`、`.openharness/agents`、`.openharness/models` 等描述的是 workspace 本身，不描述 sandbox。即使 workspace 被 materialize 到别的宿主中执行，这些定义仍然属于同一个 workspace。

**合并规则：**

- 平台内建 agent 与 workspace agent 合并成可见 catalog；同名时 workspace 覆盖平台
- 平台级与 workspace 级模型入口合并，不互相覆盖
- Agent 推荐通过 `settings.models` 中的别名引用模型
- 显式参数只能选择当前 catalog 中的已有能力，不能扩展
- 若未声明 `default_agent` 且调用方也未指定 agent，返回配置错误

## FAQ

**为什么 `.openharness/data/` 不参与配置解析？**

它是运行时托管目录。`history.db` 只是本地运行时数据文件，不是对外真值接口。

**为什么文件 API 用 sandbox，而不是直接用 workspace？**

因为文件读写和命令执行总是针对“当前活跃执行副本”进行，而这个副本属于某个 sandbox。workspace 负责项目身份和能力发现；sandbox 负责文件系统与进程上下文。
