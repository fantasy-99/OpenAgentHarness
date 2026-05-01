import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { maintainDaemonState, summarizeDaemonState } from "../apps/cli/src/daemon/state-maintenance.js";
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

function seedHistoryDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma journal_mode = wal");
    db.exec("create table if not exists events (id text primary key, payload text not null)");
    const insert = db.prepare("insert into events (id, payload) values (?, ?)");
    insert.run("evt_1", "hello");
  } finally {
    db.close();
  }
}

describe("OAP daemon state maintenance", () => {
  it("summarizes OAH_HOME state usage", async () => {
    const home = await createTempDir("oah-state-home-");
    await initDaemonHome({ home });
    const stateFile = path.join(home, "state", "data", "workspace-state", "ws_demo", "note.txt");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "state data", "utf8");

    const summary = await summarizeDaemonState({ home });

    expect(summary).toContain(`OAH_HOME: ${home}`);
    expect(summary).toContain("workspace-state:");
    expect(summary).toContain("sqlite: 0 db files");
  });

  it("previews SQLite maintenance without touching databases", async () => {
    const home = await createTempDir("oah-state-dry-home-");
    await initDaemonHome({ home });
    const dbPath = path.join(home, "state", "data", "workspace-state", "ws_demo", "history.db");
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedHistoryDatabase(dbPath);

    const message = await maintainDaemonState({ home, dryRun: true });

    expect(message).toContain("Would maintain 1 SQLite database");
    expect(message).toContain(dbPath);
    await expect(readFile(dbPath, "utf8")).resolves.toBeDefined();
  });

  it("runs checkpoint and vacuum for local shadow SQLite databases", async () => {
    const home = await createTempDir("oah-state-maintain-home-");
    await initDaemonHome({ home });
    const dbPath = path.join(home, "state", "data", "workspace-state", "ws_demo", "history.db");
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedHistoryDatabase(dbPath);

    const message = await maintainDaemonState({ home });

    expect(message).toContain("Maintained 1 SQLite database");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select payload from events where id = ?").get("evt_1") as { payload?: string } | undefined;
      expect(row?.payload).toBe("hello");
    } finally {
      db.close();
    }
  });
});
