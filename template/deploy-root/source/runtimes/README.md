# Runtimes

This directory contains workspace initialization templates published to `runtime/`.

Included starter runtime:

- `workspace/`
  - Standard project workspace runtime
  - References the platform model alias `openai-default`
  - Intended as the minimal starting point for new workspaces

Notes:

- Runtimes initialize new workspaces. They are not used as the active execution copy at run time.
- If you want additional runtime presets, add more subdirectories here.
