# source

This directory is the local source of truth for data published from your deploy root into object storage.

After editing anything here, run:

```bash
cd /Users/wumengsong/Code/OpenAgentHarness
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
pnpm storage:sync
```

## Mapping

| Local directory | Bucket prefix | Purpose |
| --- | --- | --- |
| `workspaces/` | `workspace/` | Workspace runtime data |
| `runtimes/` | `runtime/` | Workspace initialization templates |
| `models/` | `model/` | Platform model config YAML files |
| `tools/` | `tool/` | Tool config and tool server definitions |
| `skills/` | `skill/` | Reusable skill packages |

## Notes

- `pnpm storage:sync` syncs readonly prefixes by default and skips `source/workspaces` unless you pass `--include-workspaces`.
- The bundled runtime template expects a platform model named `openai-default`.
- Empty directories are fine. Add only the models, tools, skills, and workspaces you actually need.
