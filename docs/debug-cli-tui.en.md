# Debug CLI And TUI

## Positioning

OpenAgentHarness is still a headless runtime and does not ship a formal product UI.

For development, local debugging, and operations work, the repository includes a lightweight terminal debug surface:

- `oah` CLI
- `oah tui`

It is meant to be:

- a debug entry point
- a local development tool
- an operations troubleshooting tool

It is not:

- a polished terminal product
- an end-user chat client
- an admin console

## Current Entry Point

After the local stack is running, connect the TUI to the local API:

```bash
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui
```

The current CLI includes:

```text
oah
  tui
  workspace:list
  workspaces
  catalog:show --workspace <id>
```

Use `workspace:list` / `workspaces` to list visible workspaces, `catalog:show` to inspect a workspace catalog as JSON, and `tui` to enter the interactive debug interface.

## Why TUI

Compared with a product web UI, a TUI fits the current system especially well:

- it matches the headless-runtime positioning
- it works naturally from a repository, server shell, or local terminal
- it can reuse the existing HTTP and SSE APIs
- it is convenient for debugging actions, model runtime behavior, hooks, runs, and streaming output

## Shape

The CLI and TUI share one binary entry point:

- `oah`

The layers are:

- CLI
  - scriptable, one-shot inspection commands
- TUI
  - real-time observation and interactive troubleshooting

## Relationship To The System

CLI/TUI consumes existing capabilities and does not introduce a parallel runtime.

It mainly depends on:

- external OpenAPI endpoints
- SSE streams
- internal model runtime endpoints where explicitly needed
- server-side catalog discovery results

Principles:

- reuse HTTP / SSE APIs whenever possible
- keep terminal UI state separate from backend contracts
- keep the main TUI centered on the current workspace and current session

## Boundaries

CLI/TUI does not own:

- user management
- multi-tenant administration
- permission management
- long-term chat product experience

It only owns:

- debugging
- verification
- observation
- troubleshooting

## Roadmap

Recommended next steps:

1. Stabilize `workspace:list`, `catalog:show`, and `oah tui`
2. Add non-interactive `session inspect`, `run inspect`, and `model generate`
3. Strengthen TUI views for run timelines, tool calls, prompt composition, and catalog inspection
4. Add deeper troubleshooting views for hooks, subagents, and action environment summaries
