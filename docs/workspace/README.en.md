# Workspace

The workspace is the primary capability boundary. When a user opens a project, the runtime auto-discovers all capabilities from the project root -- no global configuration required.

## Workspace Is Not Sandbox

These two concepts are easy to conflate, but they live at different layers:

| Concept | Boundary | Meaning |
| --- | --- | --- |
| `Workspace` | Logical / project / capability boundary | Which project the agent is working on, and which agents, models, tools, skills, and hooks it declares |
| `Sandbox` | Execution host boundary | Which local filesystem and process environment the active copy runs inside |

So:

- `workspace` defines what the project is and what capabilities it declares
- `sandbox` defines where execution happens
- an active workspace is materialized into an `Active Workspace Copy` owned by the owner worker
- in `embedded` mode, that copy is usually the local filesystem
- in `self_hosted / e2b`, that copy usually lives inside a remote sandbox

## Workspace Kind

There is one standard workspace shape. A workspace declares agents, models, actions, skills, tools, and hooks in one consistent directory structure, and the runtime discovers and executes them uniformly.

## Directory Structure

Full structure:

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

Minimal viable structure:

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

## Auto-Discovery

The runtime scans these paths at run startup:

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Project description, injected into system prompt |
| `.openharness/settings.yaml` | Main config entry point |
| `.openharness/prompts.yaml` | Workspace prompt configuration |
| `.openharness/agents/*.md` | Agent definitions |
| `.openharness/models/*.yaml` | Model entries |
| `.openharness/actions/*/ACTION.yaml` | Action definitions |
| `.openharness/skills/*/SKILL.md` | Skill definitions |
| `.openharness/tools/settings.yaml` | MCP tool server registry |
| `.openharness/tools/servers/*` | Local tool server code |
| `.openharness/hooks/*.yaml` | Hook definitions |

!!! info

    `.openharness/data/` is a runtime-managed directory and is not part of capability discovery. `history.db` only stores local runtime data and is not a cross-process sync mechanism.

!!! info

    `AGENTS.md`, `.openharness/agents`, `.openharness/models`, and similar files describe the workspace itself, not the sandbox. Even when a workspace is materialized into another host for execution, those definitions still belong to the same workspace.

**Merge rules:**

- Platform built-in agents and workspace agents merge into a visible catalog; workspace wins on name conflict
- Platform and workspace model entries merge (no override)
- Agents should preferably reference model aliases declared in `settings.models`
- Explicit parameters can only select from the current catalog, not extend it
- If no `default_agent` is declared and the caller does not specify one, a config error is returned

## FAQ

**Why is `.openharness/data/` excluded from config parsing?**

It is a runtime-managed directory. `history.db` is only a local runtime data file, not an external source-of-truth interface.

**Why are file APIs sandbox-scoped instead of workspace-scoped?**

Because file reads, writes, and command execution always target the active execution copy, and that copy belongs to a sandbox. The workspace API handles project identity and capability discovery; the sandbox API handles filesystem and process context.
