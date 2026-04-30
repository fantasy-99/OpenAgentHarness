# Config Profiles

This directory contains profile-level server configs for different deployment shapes.

- `daemon.yaml` is for a local single-user daemon. It uses SQLite fallback, embedded execution, and local disk paths.
- `server.docker.yaml` is for Docker Compose / `pnpm local:up`.
- `kubernetes.server.yaml` is a ConfigMap / Helm `config.serverYaml` source for split Kubernetes deployments.

For compatibility, OAH still accepts legacy deploy roots with `server.docker.yaml` at the root and assets under `source/`.
