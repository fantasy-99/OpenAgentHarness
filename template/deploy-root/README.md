# Deploy Root Template

This directory is the starter `OAH_DEPLOY_ROOT` for local development and first deployments.

Suggested flow:

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
```

Before starting OAH, add at least one model YAML under `source/models/` that matches `llm.default_model` in `server.docker.yaml`.

For the bundled starter runtime, the expected platform model name is:

- `openai-default`

Then run:

```bash
pnpm local:up
pnpm dev:web
```
