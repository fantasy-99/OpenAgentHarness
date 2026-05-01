import { BrowserWindow, Menu, app, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDesktopLaunchPlan, startLocalDaemon, webEntryToUrl, type DesktopLaunchPlan } from "./connection.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
app.setName("Open Agent Harness");

async function createMainWindow(): Promise<void> {
  const plan = await resolveDesktopLaunchPlan({
    home: process.env.OAH_HOME,
    apiBaseUrl: process.env.OAH_DESKTOP_API_BASE_URL,
    token: process.env.OAH_DESKTOP_TOKEN,
    webUrl: process.env.OAH_DESKTOP_WEB_URL,
    autoStartDaemon: process.env.OAH_DESKTOP_AUTO_START_DAEMON !== "0"
  });

  process.env.OAH_DESKTOP_CONNECTION_JSON = JSON.stringify({
    baseUrl: plan.connection.baseUrl,
    ...(plan.connection.token ? { token: plan.connection.token } : {})
  });

  installMenu(plan);

  const icon = resolveWindowIcon();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    title: "Open Agent Harness",
    ...(icon ? { icon } : {}),
    backgroundColor: "#f8fafc",
    show: false,
    webPreferences: {
      preload: path.join(moduleDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await window.loadURL(webEntryToUrl(plan.webEntry));
}

function resolveWindowIcon(): string | undefined {
  const candidates = [
    process.env.OAH_DESKTOP_ICON,
    process.resourcesPath ? path.join(process.resourcesPath, "webui", "favicon.png") : undefined,
    path.resolve(moduleDir, "../webui/favicon.png"),
    path.resolve(moduleDir, "../../cli/dist/webui/favicon.png"),
    path.resolve(moduleDir, "../../../apps/web/public/favicon.png")
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function installMenu(plan: DesktopLaunchPlan): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Open Agent Harness",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    }
  ];

  if (plan.connection.source === "local-daemon") {
    template.splice(1, 0, {
      label: "Daemon",
      submenu: [
        {
          label: "Start Local Daemon",
          click: () => {
            void startLocalDaemon({ home: plan.home });
          }
        },
        {
          label: "Reconnect to Local Daemon",
          click: () => {
            process.env.OAH_DESKTOP_FORCE_CONNECTION = "1";
            void startLocalDaemon({ home: plan.home }).then(() => BrowserWindow.getFocusedWindow()?.reload());
          }
        },
        { type: "separator" },
        {
          label: "Open OAH Home",
          click: () => {
            void shell.openPath(plan.home);
          }
        },
        {
          label: "Open Daemon Log",
          click: () => {
            void shell.openPath(path.join(plan.home, "logs", "daemon.log"));
          }
        }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
