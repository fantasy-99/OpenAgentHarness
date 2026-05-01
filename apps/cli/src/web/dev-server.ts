import { spawn } from "node:child_process";

import type { OahConnection } from "../api/oah-api.js";
import { resolveDaemonPaths } from "../daemon/lifecycle.js";

export type WebUiOptions = {
  connection: OahConnection;
  host: string;
  port: number;
  open?: boolean;
};

export async function launchWebUi(options: WebUiOptions): Promise<void> {
  const paths = resolveDaemonPaths();
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "--filter",
    "@oah/web",
    "dev",
    "--",
    "--host",
    options.host,
    "--port",
    String(options.port),
    ...(options.open ? ["--open"] : [])
  ];

  console.error(`Starting WebUI at http://${options.host}:${options.port} with OAH API ${options.connection.baseUrl}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpmCommand, args, {
      cwd: paths.repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        OAH_WEB_PROXY_TARGET: options.connection.baseUrl,
        ...(options.connection.token ? { OAH_TOKEN: options.connection.token } : {})
      }
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`WebUI dev server exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`));
    });
  });
}
