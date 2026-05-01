import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateWorkspaceHistory } from "../apps/cli/src/daemon/history-migration.js";
import { initDaemonHome } from "../apps/cli/src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function writeRepoLocalHistory(workspaceRoot: string, content = "repo-local-history"): Promise<string> {
  const sourcePath = path.join(workspaceRoot, ".openharness", "data", "history.db");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content, "utf8");
  await writeFile(`${sourcePath}-wal`, "repo-local-wal", "utf8");
  return sourcePath;
}

describe("OAP repo-local history migration", () => {
  it("copies repo-local history into OAP shadow storage without touching the source", async () => {
    const home = await createTempDir("oah-history-home-");
    const workspaceRoot = await createTempDir("oah-history-workspace-");
    const sourcePath = await writeRepoLocalHistory(workspaceRoot);

    await expect(
      migrateWorkspaceHistory({
        home,
        workspaceId: "ws_history",
        workspaceRoot
      })
    ).resolves.toContain("Migrated repo-local history");

    const targetDir = path.join(home, "state", "data", "workspace-state", "ws_history");
    await expect(readFile(path.join(targetDir, "history.db"), "utf8")).resolves.toBe("repo-local-history");
    await expect(readFile(path.join(targetDir, "history.db-wal"), "utf8")).resolves.toBe("repo-local-wal");
    await expect(readFile(sourcePath, "utf8")).resolves.toBe("repo-local-history");
    await expect(readFile(path.join(targetDir, "history.migration.json"), "utf8")).resolves.toContain('"workspaceId": "ws_history"');
  });

  it("previews history migration without writing shadow files", async () => {
    const home = await createTempDir("oah-history-dry-home-");
    const workspaceRoot = await createTempDir("oah-history-dry-workspace-");
    await writeRepoLocalHistory(workspaceRoot);

    await expect(
      migrateWorkspaceHistory({
        home,
        workspaceId: "ws_history",
        workspaceRoot,
        dryRun: true
      })
    ).resolves.toContain("Would migrate repo-local history");

    await expect(readFile(path.join(home, "state", "data", "workspace-state", "ws_history", "history.db"), "utf8")).rejects.toThrow();
  });

  it("does not overwrite an existing shadow history unless requested", async () => {
    const home = await createTempDir("oah-history-existing-home-");
    const workspaceRoot = await createTempDir("oah-history-existing-workspace-");
    await initDaemonHome({ home });
    await writeRepoLocalHistory(workspaceRoot, "incoming-history");
    const targetPath = path.join(home, "state", "data", "workspace-state", "ws_history", "history.db");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "existing-history", "utf8");

    await expect(
      migrateWorkspaceHistory({
        home,
        workspaceId: "ws_history",
        workspaceRoot
      })
    ).resolves.toContain("Shadow history already exists");

    await expect(readFile(targetPath, "utf8")).resolves.toBe("existing-history");
  });

  it("backs up existing shadow history before overwriting it", async () => {
    const home = await createTempDir("oah-history-overwrite-home-");
    const workspaceRoot = await createTempDir("oah-history-overwrite-workspace-");
    await initDaemonHome({ home });
    await writeRepoLocalHistory(workspaceRoot, "incoming-history");
    const targetDir = path.join(home, "state", "data", "workspace-state", "ws_history");
    const targetPath = path.join(targetDir, "history.db");
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, "existing-history", "utf8");

    const message = await migrateWorkspaceHistory({
      home,
      workspaceId: "ws_history",
      workspaceRoot,
      overwrite: true
    });

    expect(message).toContain("backed up");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("incoming-history");
    const record = JSON.parse(await readFile(path.join(targetDir, "history.migration.json"), "utf8")) as { backupDir: string };
    await expect(readFile(path.join(record.backupDir, "history.db"), "utf8")).resolves.toBe("existing-history");
  });
});
