import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadServerConfig } from "@oah/config";

import { initDaemonHome, type DaemonCommandOptions } from "./lifecycle.js";

export type MigrateWorkspaceHistoryOptions = DaemonCommandOptions & {
  workspaceId: string;
  workspaceRoot: string;
  dryRun?: boolean | undefined;
  overwrite?: boolean | undefined;
  backup?: boolean | undefined;
};

type HistoryFilePlan = {
  source: string;
  target: string;
  label: "history.db" | "history.db-wal" | "history.db-shm";
  exists: boolean;
};

export async function migrateWorkspaceHistory(options: MigrateWorkspaceHistoryOptions): Promise<string> {
  const workspaceRoot = path.resolve(process.cwd(), options.workspaceRoot);
  const sourceDbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");
  const sourceStats = await stat(sourceDbPath).catch(() => null);
  if (!sourceStats?.isFile()) {
    return `No repo-local history database found at ${sourceDbPath}.`;
  }

  const paths = await initDaemonHome(options);
  const config = await loadServerConfig(paths.configPath);
  const shadowRoot = path.join(config.paths.runtime_state_dir ?? path.join(path.dirname(config.paths.workspace_dir), ".openharness"), "data", "workspace-state");
  const targetDir = path.join(shadowRoot, options.workspaceId);
  const targetDbPath = path.join(targetDir, "history.db");
  if (path.resolve(sourceDbPath) === path.resolve(targetDbPath)) {
    return `Repo-local history database is already the active target at ${targetDbPath}.`;
  }

  const files = await buildHistoryFilePlan(sourceDbPath, targetDbPath);
  const targetExists = await pathExists(targetDbPath);
  const backupEnabled = options.backup !== false;

  if (targetExists && !options.overwrite) {
    return [
      `Shadow history already exists at ${targetDbPath}.`,
      "Use --overwrite to replace it. The source repo-local history was left untouched."
    ].join("\n");
  }

  const migrationRecord = {
    workspaceId: options.workspaceId,
    workspaceRoot,
    source: sourceDbPath,
    target: targetDbPath,
    migratedAt: new Date().toISOString(),
    mode: targetExists ? "overwrite" : "create",
    copiedFiles: files.filter((file) => file.exists).map((file) => file.label)
  };

  if (options.dryRun) {
    return [
      `Would migrate repo-local history for ${options.workspaceId}.`,
      `Source: ${sourceDbPath}`,
      `Target: ${targetDbPath}`,
      targetExists ? `Target exists: yes${options.overwrite ? backupEnabled ? " (would backup and overwrite)" : " (would overwrite without backup)" : ""}` : "Target exists: no",
      `Would copy: ${migrationRecord.copiedFiles.join(", ")}`
    ].join("\n");
  }

  await mkdir(targetDir, { recursive: true });
  let backupDir: string | undefined;
  if (targetExists && backupEnabled) {
    backupDir = path.join(targetDir, "backups", `history-${timestampForFileName(migrationRecord.migratedAt)}`);
    await mkdir(backupDir, { recursive: true });
    await copyExistingHistoryFiles(targetDbPath, path.join(backupDir, "history.db"));
  }

  if (targetExists) {
    await removeHistoryFiles(targetDbPath);
  }

  for (const file of files) {
    if (!file.exists) {
      continue;
    }
    await cp(file.source, file.target, {
      force: true,
      preserveTimestamps: true
    });
  }

  await writeFile(
    path.join(targetDir, "history.migration.json"),
    `${JSON.stringify(
      {
        ...migrationRecord,
        ...(backupDir ? { backupDir } : {})
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const backupMessage = backupDir ? ` Existing shadow history was backed up to ${backupDir}.` : "";
  return `Migrated repo-local history for ${options.workspaceId} to ${targetDbPath}.${backupMessage} Source left untouched at ${sourceDbPath}.`;
}

async function buildHistoryFilePlan(sourceDbPath: string, targetDbPath: string): Promise<HistoryFilePlan[]> {
  const candidates: Array<Omit<HistoryFilePlan, "exists">> = [
    { label: "history.db", source: sourceDbPath, target: targetDbPath },
    { label: "history.db-wal", source: `${sourceDbPath}-wal`, target: `${targetDbPath}-wal` },
    { label: "history.db-shm", source: `${sourceDbPath}-shm`, target: `${targetDbPath}-shm` }
  ];

  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      exists: await pathExists(candidate.source)
    }))
  );
}

async function copyExistingHistoryFiles(sourceDbPath: string, targetDbPath: string): Promise<void> {
  const files = await buildHistoryFilePlan(sourceDbPath, targetDbPath);
  for (const file of files) {
    if (file.exists) {
      await cp(file.source, file.target, {
        force: true,
        preserveTimestamps: true
      });
    }
  }
}

async function removeHistoryFiles(targetDbPath: string): Promise<void> {
  await Promise.all([
    rm(targetDbPath, { force: true }),
    rm(`${targetDbPath}-wal`, { force: true }),
    rm(`${targetDbPath}-shm`, { force: true })
  ]);
}

async function pathExists(targetPath: string): Promise<boolean> {
  return Boolean(await stat(targetPath).catch(() => null));
}

function timestampForFileName(value: string): string {
  return value.replaceAll(/[^0-9A-Za-z]+/g, "-").replaceAll(/^-+|-+$/g, "");
}
