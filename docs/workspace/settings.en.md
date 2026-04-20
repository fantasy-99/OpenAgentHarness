# Settings

`.openharness/settings.yaml` now holds only core workspace configuration: the default agent, model aliases, imports, and extra skill directories.

Prompt configuration has moved to the dedicated [`prompts.yaml`](./prompts.en.md) file.

## Minimal Config

```yaml
default_agent: build
```

## Full Example

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

## Top-Level Fields

| Field | Required | Description |
| --- | --- | --- |
| `default_agent` | No | Default primary agent. Must exist and not be a pure `subagent` |
| `models` | No | Model alias map that agents can reference |
| `skill_dirs` | No | Additional skill search directories |
| `runtime` | No | Records which runtime the workspace was initialized from |
| `imports` | No | Tools and skills to import during runtime initialization |

!!! tip

    If a runtime needs stable model selection, prefer having agents reference these aliases via `model: <alias>`. Then switching models only requires editing `settings.yaml`.

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

| Rule | Details |
| --- | --- |
| key | Alias used by agent frontmatter, for example `model: default` |
| `ref` | Concrete model ref, must be `platform/<name>` or `workspace/<name>` |
| `temperature` / `top_p` / `max_tokens` | Default inference parameters for that model alias |
| resolution time | Resolved when the workspace loads; the runtime still operates on concrete `model_ref`s internally |
| scope | Only affects agents that declare `model`; agents without an explicit model still use normal default-model resolution |

Use this file to decide both which concrete model each alias points to and which inference defaults it carries; use agent frontmatter only to choose the alias.

## `skill_dirs`

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

| Rule | Details |
| --- | --- |
| Default directory | `.openharness/skills/*` is always scanned |
| Additive | `skill_dirs` adds directories; it does not replace the default |
| Path resolution | Relative to the workspace root |
| Priority | `.openharness/skills/*` > `skill_dirs` declaration order |
| Cross-tier conflict | Warning logged; higher priority wins |
| Same-tier conflict | Config error; loading fails |

## `imports`

```yaml
imports:
  tools:
    - docs-server
  skills:
    - repo-explorer
```

| Field | Description |
| --- | --- |
| `tools` | Platform tools to copy into the workspace from `paths.tool_dir` |
| `skills` | Platform skills to copy into the workspace from `paths.skill_dir` |

These are only used during runtime initialization. After import, the workspace uses its `Active Workspace Copy` and no longer depends on the platform directory. Referencing a nonexistent tool or skill causes initialization to fail.
