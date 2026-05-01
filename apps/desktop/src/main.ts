import { BrowserWindow, Menu, app, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDesktopLaunchPlan, webEntryToUrl } from "./connection.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    title: "Open Agent Harness",
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

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
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
    ])
  );
}

app.whenReady().then(async () => {
  installMenu();
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
