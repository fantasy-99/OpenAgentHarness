# OAH Desktop

Desktop is a thin Electron shell around the existing WebUI. It is a generic OAH-compatible client, not an OAP-only runtime.

## Boundaries

- The daemon stays independent of Electron.
- The renderer loads the existing `@oah/web` UI.
- Desktop injects the selected OAH API endpoint into WebUI local settings.
- Desktop never runs the engine in the renderer and never reads or writes session SQLite directly.
- When connected to a remote OAH endpoint, local daemon controls should stay hidden.

## Development

```bash
pnpm --filter @oah/desktop dev
```

By default, this builds `@oah/web`, copies the WebUI static bundle into the CLI runtime assets, starts or reuses the local OAP daemon, and opens the bundled WebUI against the daemon endpoint.

Useful environment variables:

```bash
OAH_DESKTOP_API_BASE_URL=http://127.0.0.1:8787
OAH_DESKTOP_TOKEN=...
OAH_DESKTOP_WEB_URL=http://127.0.0.1:5173
OAH_DESKTOP_WEB_DIST=/absolute/path/to/web/dist
OAH_DESKTOP_ICON=/absolute/path/to/favicon.png
OAH_DESKTOP_AUTO_START_DAEMON=0
OAH_DESKTOP_FORCE_CONNECTION=1
OAH_DESKTOP_CLI_ENTRY=/absolute/path/to/oah-cli/dist/index.js
```

`OAH_DESKTOP_WEB_URL` is useful when running `pnpm dev:web` separately and loading the Vite dev server instead of the built static WebUI.

## Packaging Shape

Desktop remains a generic OAH-compatible client. The package metadata declares the app identity (`Open Agent Harness`, `dev.openagentharness.desktop`) and includes an `extraResources` mapping for the WebUI bundle at `resources/webui`.

Unsigned local packaging can be exercised with:

```bash
pnpm --filter @oah/desktop package:dir
```

Signing, notarization, and auto-update are intentionally outside the current Phase 3 baseline.

Runtime lookup order:

1. `OAH_DESKTOP_WEB_URL` for a development WebUI URL.
2. `OAH_DESKTOP_WEB_DIST` for an explicit static bundle directory.
3. Packaged `resources/webui`.
4. CLI runtime assets at `apps/cli/dist/webui`.
5. Source checkout build output at `apps/web/dist`.

The local daemon is still independent. When Desktop connects to the local OAP daemon it shows a Daemon menu for start/reconnect/logs/home; when it connects to an explicit remote OAH endpoint those local controls are not shown.
