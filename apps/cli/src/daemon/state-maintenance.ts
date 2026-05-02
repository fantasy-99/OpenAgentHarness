import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadServerConfig } from "@oah/config";

import { initDaemonHome, isDaemonProcessRunning, type DaemonCommandOptions } from "./lifecycle.js";

export type DaemonStateMaintenanceOptions = DaemonCommandOptions & {
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  checkpoint?: boolean | undefined;
  vacuum?: boolean | undefined;
};

export type WorkspaceStateCleanupOptions = DaemonCommandOptions & {
  workspaceId: string;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  includeHistory?: boolean | undefined;
  confirmHistoryDeletion?: boolean | undefined;
};

type StatePathSummary = {
  label: string;
  path: string;
  bytes: number;
  files: number;
};

type SQLiteFile = {
  path: string;
  bytes: number;
  walBytes: number;
  shmBytes: number;
};

type WorkspaceStateSummary = {
  workspaceId: string;
  bytes: number;
  files: number;
  historyBytes: number;
  cacheBytes: number;
};

type WorkspaceCleanupTarget = {
  label: "cache" | "history";
  path: string;
  destructive: boolean;
};

export async function summarizeDaemonState(options: DaemonCommandOptions = {}): Promise<string> {
  const paths = await resolveStatePaths(options);
  const [state, workspaceState, archives, archivePayloads, materialized, sqliteFiles] = await Promise.all([
    summarizePath("state", paths.stateRoot),
    summarizePath("workspace-state", path.join(paths.stateRoot, "data", "workspace-state")),
    summarizePath("archives", path.join(paths.stateRoot, "archives")),
    summarizePath("archive-payloads", path.join(paths.stateRoot, "archive-payloads")),
    summarizePath("materialized", path.join(paths.stateRoot, "__materialized__")),
    findSQLiteFiles(paths.stateRoot)
  ]);
  const sqliteBytes = sqliteFiles.reduce((total, file) => total + file.bytes + file.walBytes + file.shmBytes, 0);

  return [
    `OAH_HOME: ${paths.home}`,
    `State root: ${paths.stateRoot}`,
    "",
    formatPathSummary(state),
    formatPathSummary(workspaceState),
    formatPathSummary(archives),
    formatPathSummary(archivePayloads),
    formatPathSummary(materialized),
    `sqlite: ${sqliteFiles.length} db file${sqliteFiles.length === 1 ? "" : "s"} · ${formatBytes(sqliteBytes)}`,
    "",
    ...(await formatWorkspaceStateSummaries(paths.stateRoot))
  ].join("\n");
}

export async function maintainDaemonState(options: DaemonStateMaintenanceOptions = {}): Promise<string> {
  const paths = await resolveStatePaths(options);
  const running = await isDaemonProcessRunning(options);
  if (running && !options.force) {
    return [
      "OAP daemon appears to be running.",
      "Stop the daemon before local SQLite maintenance, or pass --force if you know no runs are active."
    ].join("\n");
  }

  const checkpoint = options.checkpoint !== false;
  const vacuum = options.vacuum !== false;
  const sqliteFiles = await findSQLiteFiles(paths.stateRoot);
  if (sqliteFiles.length === 0) {
    return `No SQLite history databases found under ${paths.stateRoot}.`;
  }

  if (options.dryRun) {
    return [
      `Would maintain ${sqliteFiles.length} SQLite database${sqliteFiles.length === 1 ? "" : "s"} under ${paths.stateRoot}.`,
      `Operations: ${[checkpoint ? "checkpoint" : undefined, vacuum ? "vacuum" : undefined].filter(Boolean).join(", ") || "none"}`,
      ...sqliteFiles.map((file) => `- ${file.path} (${formatBytes(file.bytes + file.walBytes + file.shmBytes)})`)
    ].join("\n");
  }

  const beforeBytes = sqliteFiles.reduce((total, file) => total + file.bytes + file.walBytes + file.shmBytes, 0);
  const results = await Promise.all(sqliteFiles.map((file) => maintainSqliteFile(file.path, { checkpoint, vacuum })));
  const failures = results.filter((result) => !result.ok);
  const afterFiles = await findSQLiteFiles(paths.stateRoot);
  const afterBytes = afterFiles.reduce((total, file) => total + file.bytes + file.walBytes + file.shmBytes, 0);

  if (failures.length > 0) {
    return [
      `Maintained ${results.length - failures.length}/${results.length} SQLite databases under ${paths.stateRoot}.`,
      `Size: ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}.`,
      "Failures:",
      ...failures.map((failure) => `- ${failure.path}: ${failure.error}`)
    ].join("\n");
  }

  return `Maintained ${results.length} SQLite database${results.length === 1 ? "" : "s"} under ${paths.stateRoot}. Size: ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}.`;
}

export async function cleanupWorkspaceState(options: WorkspaceStateCleanupOptions): Promise<string> {
  const workspaceId = validateWorkspaceId(options.workspaceId);
  const paths = await resolveStatePaths(options);
  const running = await isDaemonProcessRunning(options);
  if (running && !options.force) {
    return [
      "OAP daemon appears to be running.",
      "Stop the daemon before workspace state cleanup, or pass --force if you know no runs are active."
    ].join("\n");
  }

  if (options.includeHistory && !options.dryRun && !options.confirmHistoryDeletion) {
    return [
      `Refusing to remove session/run/event history for ${workspaceId} without confirmation.`,
      "Run with --dry-run first, then confirm the destructive cleanup."
    ].join("\n");
  }

  const cleanupTargets = await resolveWorkspaceCleanupTargets(paths.stateRoot, workspaceId, { includeHistory: options.includeHistory === true });
  if (cleanupTargets.length === 0) {
    return `No workspace state cleanup targets found for ${workspaceId} under ${paths.stateRoot}.`;
  }

  const summaries = await Promise.all(
    cleanupTargets.map(async (target) => ({ ...target, ...(await scanDirectory(target.path)) }))
  );
  const totalBytes = summaries.reduce((total, summary) => total + summary.bytes, 0);
  const totalFiles = summaries.reduce((total, summary) => total + summary.files, 0);
  const header = `${options.dryRun ? "Would remove" : "Removed"} ${formatBytes(totalBytes)} · ${totalFiles} file${totalFiles === 1 ? "" : "s"} of workspace state for ${workspaceId}.`;

  if (options.dryRun) {
    return [
      header,
      ...summaries.map(
        (summary) =>
          `- ${summary.label}: ${summary.path} (${formatBytes(summary.bytes)} · ${summary.files} file${summary.files === 1 ? "" : "s"}${summary.destructive ? " · destructive" : ""})`
      )
    ].join("\n");
  }

  await Promise.all(cleanupTargets.map((target) => rm(target.path, { recursive: true, force: true })));
  return [
    header,
    ...summaries.map((summary) => `- ${summary.label}: ${summary.path}`),
    options.includeHistory ? "History databases were removed for this workspace." : "History databases were not removed."
  ].join("\n");
}

async function resolveStatePaths(options: DaemonCommandOptions) {
  const daemonPaths = await initDaemonHome(options);
  const config = await loadServerConfig(daemonPaths.configPath);
  const stateRoot = path.resolve(config.paths.runtime_state_dir ?? path.join(path.dirname(config.paths.workspace_dir), ".openharness"));
  return {
    home: daemonPaths.home,
    stateRoot
  };
}

async function summarizePath(label: string, targetPath: string): Promise<StatePathSummary> {
  const summary = await scanDirectory(targetPath);
  return {
    label,
    path: targetPath,
    bytes: summary.bytes,
    files: summary.files
  };
}

async function formatWorkspaceStateSummaries(stateRoot: string): Promise<string[]> {
  const summaries = await summarizeWorkspaceState(stateRoot);
  if (summaries.length === 0) {
    return ["workspaces: none"];
  }
  return [
    "workspaces:",
    ...summaries.map(
      (summary) =>
        `- ${summary.workspaceId}: ${formatBytes(summary.bytes)} · ${summary.files} file${summary.files === 1 ? "" : "s"} (history ${formatBytes(summary.historyBytes)}, cache ${formatBytes(summary.cacheBytes)})`
    )
  ];
}

async function summarizeWorkspaceState(stateRoot: string): Promise<WorkspaceStateSummary[]> {
  const workspaceIds = new Set<string>();
  for (const parent of [path.join(stateRoot, "data", "workspace-state"), path.join(stateRoot, "__materialized__")]) {
    for (const child of await listChildDirectories(parent)) {
      workspaceIds.add(child);
    }
  }

  const summaries = await Promise.all(
    [...workspaceIds].sort().map(async (workspaceId) => {
      const historyPath = path.join(stateRoot, "data", "workspace-state", workspaceId);
      const cachePath = path.join(stateRoot, "__materialized__", workspaceId);
      const [history, cache] = await Promise.all([scanDirectory(historyPath), scanDirectory(cachePath)]);
      return {
        workspaceId,
        bytes: history.bytes + cache.bytes,
        files: history.files + cache.files,
        historyBytes: history.bytes,
        cacheBytes: cache.bytes
      };
    })
  );
  return summaries.sort((left, right) => right.bytes - left.bytes || left.workspaceId.localeCompare(right.workspaceId));
}

async function listChildDirectories(parentPath: string): Promise<string[]> {
  const parentStats = await stat(parentPath).catch(() => null);
  if (!parentStats?.isDirectory()) {
    return [];
  }
  const entries = await readdir(parentPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function scanDirectory(targetPath: string): Promise<{ bytes: number; files: number }> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats) {
    return { bytes: 0, files: 0 };
  }
  if (targetStats.isFile()) {
    return { bytes: targetStats.size, files: 1 };
  }
  if (!targetStats.isDirectory()) {
    return { bytes: 0, files: 0 };
  }

  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    const child = await scanDirectory(path.join(targetPath, entry.name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

async function findSQLiteFiles(rootPath: string): Promise<SQLiteFile[]> {
  const rootStats = await stat(rootPath).catch(() => null);
  if (!rootStats?.isDirectory()) {
    return [];
  }

  const files: SQLiteFile[] = [];
  async function visit(directoryPath: string): Promise<void> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".db")) {
        continue;
      }
      files.push({
        path: entryPath,
        bytes: await fileSize(entryPath),
        walBytes: await fileSize(`${entryPath}-wal`),
        shmBytes: await fileSize(`${entryPath}-shm`)
      });
    }
  }
  await visit(rootPath);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveWorkspaceCleanupTargets(stateRoot: string, workspaceId: string, options: { includeHistory: boolean }): Promise<WorkspaceCleanupTarget[]> {
  const candidates: WorkspaceCleanupTarget[] = [
    { label: "cache", path: path.join(stateRoot, "__materialized__", workspaceId), destructive: false }
  ];
  if (options.includeHistory) {
    candidates.push({
      label: "history",
      path: path.join(stateRoot, "data", "workspace-state", workspaceId),
      destructive: true
    });
  }

  const targets: WorkspaceCleanupTarget[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    assertPathInside(path.resolve(stateRoot), resolved);
    const targetStats = await stat(resolved).catch(() => null);
    if (targetStats?.isDirectory()) {
      targets.push({ ...candidate, path: resolved });
    }
  }
  return targets;
}

async function maintainSqliteFile(dbPath: string, operations: { checkpoint: boolean; vacuum: boolean }): Promise<{ ok: true; path: string } | { ok: false; path: string; error: string }> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("pragma busy_timeout = 1000");
    if (operations.checkpoint) {
      db.exec("pragma wal_checkpoint(TRUNCATE)");
    }
    if (operations.vacuum) {
      db.exec("vacuum");
    }
    if (operations.checkpoint) {
      db.exec("pragma wal_checkpoint(TRUNCATE)");
    }
    return { ok: true, path: dbPath };
  } catch (error) {
    return { ok: false, path: dbPath, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

async function fileSize(targetPath: string): Promise<number> {
  return (await stat(targetPath).catch(() => null))?.size ?? 0;
}

function validateWorkspaceId(workspaceId: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(workspaceId) || workspaceId === "." || workspaceId === "..") {
    throw new Error(`Invalid workspace id: ${workspaceId}`);
  }
  return workspaceId;
}

function assertPathInside(parentPath: string, childPath: string): void {
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside state root: ${childPath}`);
  }
}

function formatPathSummary(summary: StatePathSummary): string {
  return `${summary.label}: ${formatBytes(summary.bytes)} · ${summary.files} file${summary.files === 1 ? "" : "s"} · ${summary.path}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}
