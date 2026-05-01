import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDesktopConnection, resolveWebEntry } from "../apps/desktop/src/connection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("desktop launch connection", () => {
  it("uses an explicit API endpoint before local daemon settings", async () => {
    vi.stubEnv("OAH_DESKTOP_API_BASE_URL", "https://oah.example.test/");
    vi.stubEnv("OAH_DESKTOP_TOKEN", "remote-token");

    await expect(resolveDesktopConnection()).resolves.toEqual({
      baseUrl: "https://oah.example.test",
      token: "remote-token",
      source: "explicit"
    });
  });

  it("reads the local daemon endpoint and token from OAH_HOME", async () => {
    const home = await createTempDir("oah-desktop-home-");
    await mkdir(path.join(home, "config"), { recursive: true });
    await mkdir(path.join(home, "run"), { recursive: true });
    await writeFile(path.join(home, "config", "daemon.yaml"), "server:\n  host: 0.0.0.0\n  port: 18888\n", "utf8");
    await writeFile(path.join(home, "run", "token"), "local-token\n", "utf8");

    await expect(resolveDesktopConnection({ home })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:18888",
      token: "local-token",
      source: "local-daemon"
    });
  });

  it("can load a development WebUI URL instead of the built static bundle", async () => {
    await expect(resolveWebEntry("http://127.0.0.1:5173")).resolves.toEqual({
      kind: "url",
      url: "http://127.0.0.1:5173"
    });
  });
});
