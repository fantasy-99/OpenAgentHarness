import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { daemonStatus, initDaemonHome, readDaemonLogs } from "../apps/cli/src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAP daemon lifecycle helpers", () => {
  it("initializes OAH_HOME from the deploy-root template without overwriting user config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-home-"));
    tempDirs.push(home);

    const first = await initDaemonHome({ home });
    const initialToken = await readFile(first.tokenPath, "utf8");
    await writeFile(first.configPath, "server:\n  host: 127.0.0.1\n  port: 18788\n", "utf8");

    const second = await initDaemonHome({ home });

    expect(second.home).toBe(home);
    expect(await readFile(second.configPath, "utf8")).toBe("server:\n  host: 127.0.0.1\n  port: 18788\n");
    expect(await readFile(second.tokenPath, "utf8")).toBe(initialToken);
    expect(await readFile(path.join(home, ".oah-home-version"), "utf8")).toBe("1\n");
  });

  it("can initialize OAH_HOME from packaged deploy-root assets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-packaged-"));
    tempDirs.push(tempDir);
    const templateRoot = path.join(tempDir, "deploy-root");
    const home = path.join(tempDir, "home");
    await mkdir(path.join(templateRoot, "config"), { recursive: true });
    await writeFile(path.join(templateRoot, "README.md"), "packaged template\n", "utf8");
    await writeFile(path.join(templateRoot, "config", "daemon.yaml"), "server:\n  host: 127.0.0.1\n  port: 18799\n", "utf8");

    const previousTemplate = process.env.OAH_DEPLOY_ROOT_TEMPLATE;
    process.env.OAH_DEPLOY_ROOT_TEMPLATE = templateRoot;
    try {
      await initDaemonHome({ home });
    } finally {
      if (previousTemplate === undefined) {
        delete process.env.OAH_DEPLOY_ROOT_TEMPLATE;
      } else {
        process.env.OAH_DEPLOY_ROOT_TEMPLATE = previousTemplate;
      }
    }

    expect(await readFile(path.join(home, "README.md"), "utf8")).toBe("packaged template\n");
    expect(await readFile(path.join(home, "config", "daemon.yaml"), "utf8")).toContain("18799");
  });

  it("reports stale PID files without probing the server endpoint", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-stale-"));
    tempDirs.push(home);
    await initDaemonHome({ home });
    await writeFile(path.join(home, "run", "daemon.pid"), "not-a-pid\n", "utf8");

    await expect(daemonStatus({ home })).resolves.toContain("stale PID file");
  });

  it("reads the requested tail of the daemon log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-logs-"));
    tempDirs.push(home);
    await initDaemonHome({ home });
    await mkdir(path.join(home, "logs"), { recursive: true });
    await writeFile(path.join(home, "logs", "daemon.log"), "one\ntwo\nthree\n", "utf8");

    await expect(readDaemonLogs({ home, lines: 2 })).resolves.toBe("three\n");
  });
});
