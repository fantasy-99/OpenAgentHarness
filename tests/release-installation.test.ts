import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeInstallation,
  detectReleaseAsset,
  resolveInstallRoot,
  rollbackInstallation,
  updateInstallation
} from "../apps/cli/src/release/installation.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("OAH release installation", () => {
  it("detects release asset names for supported platforms", () => {
    expect(detectReleaseAsset("darwin", "arm64")).toEqual({ platform: "macos-aarch64", binaryName: "oah" });
    expect(detectReleaseAsset("darwin", "x64")).toEqual({ platform: "macos-x86_64", binaryName: "oah" });
    expect(detectReleaseAsset("linux", "x64")).toEqual({ platform: "linux-x86_64", binaryName: "oah" });
    expect(detectReleaseAsset("win32", "x64")).toEqual({ platform: "windows-x86_64", binaryName: "oah.cmd" });
  });

  it("previews updates without querying or writing releases when version is explicit", async () => {
    const installRoot = await createTempDir("oah-install-dry-");

    const message = await updateInstallation({ installRoot, version: "1.2.3", dryRun: true });

    expect(message).toContain("Would install OpenAgentHarness v1.2.3");
    expect(message).toContain(path.join(installRoot, "versions", "1.2.3"));
  });

  it("prefers OAH_HOME over the deprecated OAH_INSTALL_ROOT environment variable", async () => {
    const home = await createTempDir("oah-home-root-");
    const installRoot = await createTempDir("oah-install-root-");
    const previousHome = process.env.OAH_HOME;
    const previousInstallRoot = process.env.OAH_INSTALL_ROOT;
    process.env.OAH_HOME = home;
    process.env.OAH_INSTALL_ROOT = installRoot;
    try {
      expect(resolveInstallRoot()).toBe(home);
    } finally {
      if (previousHome === undefined) {
        delete process.env.OAH_HOME;
      } else {
        process.env.OAH_HOME = previousHome;
      }
      if (previousInstallRoot === undefined) {
        delete process.env.OAH_INSTALL_ROOT;
      } else {
        process.env.OAH_INSTALL_ROOT = previousInstallRoot;
      }
    }
  });

  it("switches current to an installed release and writes the root shim", async () => {
    const installRoot = await createTempDir("oah-install-rollback-");
    await mkdir(path.join(installRoot, "versions", "0.0.1", "bin"), { recursive: true });
    await mkdir(path.join(installRoot, "versions", "0.0.2", "bin"), { recursive: true });

    const message = await rollbackInstallation({ installRoot, version: "0.0.2" });
    const shim = await readFile(path.join(installRoot, "bin", process.platform === "win32" ? "oah.cmd" : "oah"), "utf8");
    const info = await describeInstallation({ installRoot });

    expect(message).toContain("0.0.2");
    expect(shim).toContain("current");
    expect(shim).toContain("OAH_HOME");
    expect(info).toContain("Current release: 0.0.2");
    expect(info).toContain("Installed releases: 0.0.1, 0.0.2");
  });
});
