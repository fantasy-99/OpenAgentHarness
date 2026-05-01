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

By default, this builds `@oah/web`, starts or reuses the local OAP daemon, and opens the bundled WebUI against the daemon endpoint.

Useful environment variables:

```bash
OAH_DESKTOP_API_BASE_URL=http://127.0.0.1:8787
OAH_DESKTOP_TOKEN=...
OAH_DESKTOP_WEB_URL=http://127.0.0.1:5173
OAH_DESKTOP_AUTO_START_DAEMON=0
OAH_DESKTOP_FORCE_CONNECTION=1
```

`OAH_DESKTOP_WEB_URL` is useful when running `pnpm dev:web` separately and loading the Vite dev server instead of the built static WebUI.
