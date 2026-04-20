# Settings

`.openharness/settings.yaml` 现在只负责 workspace 的核心配置：默认 agent、模型别名、导入项和额外 skill 目录。

Prompt 相关配置已拆到独立文件 [`prompts.yaml`](./prompts.md)。

## 最小配置

```yaml
default_agent: build
```

## 完整示例

```yaml
default_agent: build

models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 2048
  planner:
    ref: workspace/repo-planner

skill_dirs:
  - ./.codex/skills

imports:
  tools:
    - docs-server
  skills:
    - repo-explorer
```

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `default_agent` | 否 | 默认主 agent。目标必须存在且不能是纯 `subagent` |
| `models` | 否 | agent 可引用的模型别名表 |
| `skill_dirs` | 否 | 额外 skill 搜索目录列表 |
| `runtime` | 否 | 记录当前 workspace 来源的 runtime 名称 |
| `imports` | 否 | runtime 初始化时导入的公共 tools/skills |

!!! tip

    如果某个 runtime 需要稳定地切换模型，推荐所有 agent 都通过 `model: <alias>` 引用这里声明的别名。之后只改 `settings.yaml` 就能整体切换。

## `models`

```yaml
models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    top_p: 0.9
    max_tokens: 2048
  fast:
    ref: platform/kimi-k25
  repo:
    ref: workspace/repo-model
```

| 规则 | 说明 |
| --- | --- |
| key | 别名，由 agent frontmatter 使用，例如 `model: default` |
| `ref` | 具体模型引用，格式必须是 `platform/<name>` 或 `workspace/<name>` |
| `temperature` / `top_p` / `max_tokens` | 该模型别名对应的默认推理参数 |
| 解析时机 | workspace 加载阶段解析；运行时内部仍使用具体 `model_ref` |
| 适用范围 | 仅影响显式声明 `model` 的 agent；未声明模型的 agent 仍走默认模型选择逻辑 |

推荐把“要不要换模型”和“这个模型档位的推理参数”都放在这里，把“这个 agent 用哪个模型档位”放在 agent frontmatter。

## `skill_dirs`

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

| 规则 | 说明 |
| --- | --- |
| 默认目录 | `.openharness/skills/*` 始终扫描 |
| 追加语义 | `skill_dirs` 追加额外目录，不替代默认目录 |
| 路径解析 | 相对 workspace 根目录 |
| 优先级 | `.openharness/skills/*` > `skill_dirs` 声明顺序 |
| 跨层同名 | 记录 warning，高优先级覆盖 |
| 同层同名 | 配置错误，加载失败 |

## `imports`

```yaml
imports:
  tools:
    - docs-server
  skills:
    - repo-explorer
```

| 字段 | 说明 |
| --- | --- |
| `tools` | 从 `paths.tool_dir` 导入到 workspace 的公共 tool 名称 |
| `skills` | 从 `paths.skill_dir` 导入到 workspace 的公共 skill 名称 |

仅用于 runtime 初始化。导入后 workspace 以它的 `Active Workspace Copy` 为准，不再依赖平台目录。引用不存在的 tool 或 skill 时，初始化失败。
