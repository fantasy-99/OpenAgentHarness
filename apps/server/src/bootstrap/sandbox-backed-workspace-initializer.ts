import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sandboxSchema, type CreateWorkspaceRequest } from "@oah/api-contracts";
import { discoverWorkspace, initializeWorkspaceFromRuntime, type DiscoveredAgent, type PlatformModelRegistry } from "@oah/config";
import { createId, type WorkspaceInitializationResult, type WorkspaceRecord } from "@oah/engine-core";
import * as nativeBridge from "@oah/native-bridge";

import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback
} from "../observability/native-workspace-sync.js";
import type { SandboxHost } from "./sandbox-host.js";
import { enrichWorkspaceModelsWithDiscoveredMetadata } from "./model-metadata-discovery.js";

const SANDBOX_WORKSPACE_ROOT = "/workspace";
const DEFAULT_SEED_UPLOAD_CONCURRENCY = 8;
const DEFAULT_SEED_ARCHIVE_UPLOAD_MODE = "auto";
const DEFAULT_SEED_ARCHIVE_MIN_FILE_COUNT = 16;
const DEFAULT_SEED_ARCHIVE_MIN_TOTAL_BYTES = 128 * 1024;
const DEFAULT_SEED_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;
interface PreparedSeedCacheEntry {
  cacheRoot: string;
  preparedWorkspaceRoot: string;
  discovered: WorkspaceInitializationResult;
  archivePath?: string | undefined;
  archivePromise?: Promise<string> | undefined;
}

const preparedSeedCache = new Map<string, Promise<PreparedSeedCacheEntry>>();

interface SeedUploadPlanFile {
  localPath: string;
  remotePath: string;
  size: number;
  mtimeMs: number;
}

interface RemoteWorkspaceEntry {
  path: string;
  kind: "file" | "directory" | "other";
  sizeBytes?: number | undefined;
  updatedAt?: string | undefined;
}

export const nativeWorkspaceSyncAdapter = {
  isEnabled: nativeBridge.isNativeWorkspaceSyncEnabled,
  computeDirectoryFingerprint: nativeBridge.computeNativeDirectoryFingerprint,
  computeDirectoryFingerprintBatch: nativeBridge.computeNativeDirectoryFingerprintBatch,
  planSeedUpload: nativeBridge.planNativeSeedUpload,
  syncLocalToSandboxHttp: nativeBridge.syncNativeLocalToSandboxHttp
};

function resolveSeedUploadConcurrency(): number {
  const raw = process.env.OAH_SANDBOX_SEED_UPLOAD_CONCURRENCY;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_SEED_UPLOAD_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_UPLOAD_CONCURRENCY;
}

function resolveSeedArchiveUploadMode(): "off" | "auto" | "force" {
  const raw = process.env.OAH_SANDBOX_SEED_ARCHIVE_UPLOAD?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_SEED_ARCHIVE_UPLOAD_MODE as "auto";
  }

  if (["0", "false", "off", "no", "disabled"].includes(raw)) {
    return "off";
  }

  if (["1", "true", "on", "yes", "enabled", "force"].includes(raw)) {
    return "force";
  }

  return "auto";
}

function resolveSeedArchiveTimeoutMs(): number {
  const raw = process.env.OAH_SANDBOX_SEED_ARCHIVE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_SEED_ARCHIVE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_ARCHIVE_TIMEOUT_MS;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function runLocalProcess(input: {
  executable: string;
  args: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, input.timeoutMs ?? DEFAULT_SEED_ARCHIVE_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timeoutTriggered) {
        reject(new Error(`Process timed out after ${input.timeoutMs ?? DEFAULT_SEED_ARCHIVE_TIMEOUT_MS}ms.`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
        return;
      }
      resolve();
    });
  });
}

async function collectDirectoryFingerprint(rootPath: string): Promise<string> {
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint",
        implementation: "rust",
        target: rootPath,
        logFailure: false,
        action: () => nativeWorkspaceSyncAdapter.computeDirectoryFingerprint({ rootDir: rootPath })
      });
      return result.fingerprint;
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint",
        target: rootPath,
        error
      });
    }
  }

  return observeNativeWorkspaceSyncOperation({
    operation: "fingerprint",
    implementation: "ts",
    target: rootPath,
    logSuccess: false,
    logFailure: false,
    action: async () => {
      const hash = createHash("sha1");
      const visit = async (currentPath: string): Promise<void> => {
        const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          const absolutePath = path.join(currentPath, entry.name);
          const relativePath = path.relative(rootPath, absolutePath).replaceAll(path.sep, "/");
          const entryStat = await stat(absolutePath).catch(() => null);
          if (!entryStat) {
            continue;
          }

          hash.update(
            `${entry.isDirectory() ? "dir" : "file"}:${relativePath}:${entryStat.size}:${Math.trunc(entryStat.mtimeMs)}\n`
          );
          if (entry.isDirectory()) {
            await visit(absolutePath);
          }
        }
      };

      await visit(rootPath);
      return hash.digest("hex");
    }
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

async function buildPreparedSeedCacheKey(input: {
  runtimeDir: string;
  runtimeName: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  agentsMd?: string | undefined;
  toolServers?: Record<string, Record<string, unknown>> | undefined;
  skills?: Array<{ name: string; content: string }> | undefined;
}): Promise<string> {
  const runtimeRoot = path.join(input.runtimeDir, input.runtimeName);
  const fingerprintInputs = [
    { key: "runtimeRoot", rootDir: runtimeRoot },
    { key: "platformToolDir", rootDir: input.platformToolDir },
    { key: "platformSkillDir", rootDir: input.platformSkillDir },
    { key: "toolDir", rootDir: input.toolDir }
  ] as const;

  const directoryFingerprints = new Map<string, string>();
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint_batch",
        implementation: "rust",
        target: runtimeRoot,
        logFailure: false,
        metadata: {
          directoryCount: fingerprintInputs.length
        },
        action: () =>
          nativeWorkspaceSyncAdapter.computeDirectoryFingerprintBatch({
            directories: fingerprintInputs.map((entry) => ({
              rootDir: entry.rootDir
            }))
          })
      });
      for (const [index, entry] of result.results.entries()) {
        const fingerprintInput = fingerprintInputs[index];
        if (!fingerprintInput) {
          continue;
        }
        directoryFingerprints.set(fingerprintInput.key, entry.fingerprint);
      }
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint_batch",
        target: runtimeRoot,
        error,
        metadata: {
          directoryCount: fingerprintInputs.length
        }
      });
    }
  }

  const hash = createHash("sha1");
  hash.update(input.runtimeName);
  hash.update("\n");
  hash.update(directoryFingerprints.get("runtimeRoot") ?? (await collectDirectoryFingerprint(runtimeRoot)));
  hash.update("\n");
  hash.update(directoryFingerprints.get("platformToolDir") ?? (await collectDirectoryFingerprint(input.platformToolDir).catch(() => "")));
  hash.update("\n");
  hash.update(
    directoryFingerprints.get("platformSkillDir") ?? (await collectDirectoryFingerprint(input.platformSkillDir).catch(() => ""))
  );
  hash.update("\n");
  hash.update(directoryFingerprints.get("toolDir") ?? (await collectDirectoryFingerprint(input.toolDir).catch(() => "")));
  hash.update("\n");
  hash.update(input.agentsMd?.trim() ?? "");
  hash.update("\n");
  hash.update(stableJson(input.toolServers ?? {}));
  hash.update("\n");
  hash.update(stableJson(input.skills ?? []));
  return hash.digest("hex");
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        await worker(items[index]!);
      }
    })
  );
}

async function collectDirectoryUploadPlan(input: {
  currentLocalPath: string;
  currentRemotePath: string;
}): Promise<{
  directories: string[];
  files: SeedUploadPlanFile[];
}> {
  const directories: string[] = [];
  const files: SeedUploadPlanFile[] = [];
  const entries = await readdir(input.currentLocalPath, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(input.currentLocalPath, entry.name);
    const remotePath = path.posix.join(input.currentRemotePath, entry.name);

    if (entry.isDirectory()) {
      directories.push(remotePath);
      const nested = await collectDirectoryUploadPlan({
        ...input,
        currentLocalPath: localPath,
        currentRemotePath: remotePath
      });
      directories.push(...nested.directories);
      files.push(...nested.files);
      continue;
    }

    if (entry.isFile()) {
      const entryStat = await stat(localPath);
      files.push({
        localPath,
        remotePath,
        size: entryStat.size,
        mtimeMs: entryStat.mtimeMs
      });
    }
  }

  return {
    directories,
    files
  };
}

async function collectNativeDirectoryUploadPlan(input: {
  currentLocalPath: string;
  currentRemotePath: string;
}): Promise<{
  directories: string[];
  files: SeedUploadPlanFile[];
} | undefined> {
  if (!nativeWorkspaceSyncAdapter.isEnabled()) {
    return undefined;
  }

  try {
    const result = await observeNativeWorkspaceSyncOperation({
      operation: "plan_seed_upload",
      implementation: "rust",
      target: input.currentLocalPath,
      logFailure: false,
      metadata: {
        remoteRootPath: input.currentRemotePath
      },
      action: () =>
        nativeWorkspaceSyncAdapter.planSeedUpload({
          rootDir: input.currentLocalPath,
          remoteBasePath: input.currentRemotePath
        })
    });
    return {
      directories: result.directories,
      files: result.files.map((file) => ({
        localPath: file.absolutePath,
        remotePath: file.remotePath,
        size: file.size,
        mtimeMs: file.mtimeMs
      }))
    };
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "plan_seed_upload",
      target: input.currentLocalPath,
      error,
      metadata: {
        remoteRootPath: input.currentRemotePath
      }
    });
    return undefined;
  }
}

function isWorkspaceFileMtimeMatch(currentMtimeMs: number, targetMtimeMs: number): boolean {
  return Math.abs(currentMtimeMs - targetMtimeMs) < 1;
}

function parseRemoteWorkspaceEntryMtimeMs(updatedAt: string | undefined): number | undefined {
  if (!updatedAt || updatedAt.trim().length === 0) {
    return undefined;
  }

  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRemoteWorkspaceEntryFileMatch(input: {
  remoteEntry: RemoteWorkspaceEntry | undefined;
  localSize: number;
  localMtimeMs: number;
}): boolean {
  const remoteSize = input.remoteEntry?.sizeBytes;
  const remoteMtimeMs = parseRemoteWorkspaceEntryMtimeMs(input.remoteEntry?.updatedAt);
  return (
    input.remoteEntry?.kind === "file" &&
    typeof remoteSize === "number" &&
    remoteSize === input.localSize &&
    typeof remoteMtimeMs === "number" &&
    isWorkspaceFileMtimeMatch(remoteMtimeMs, input.localMtimeMs)
  );
}

async function shouldSkipSeedFileUpload(input: {
  sandboxHost: SandboxHost;
  remotePath: string;
  localSize: number;
  localMtimeMs: number;
  remoteEntryFound: boolean;
  remoteEntry?: RemoteWorkspaceEntry | undefined;
}): Promise<boolean> {
  if (!input.remoteEntryFound) {
    return false;
  }

  if (
    isRemoteWorkspaceEntryFileMatch({
      remoteEntry: input.remoteEntry,
      localSize: input.localSize,
      localMtimeMs: input.localMtimeMs
    })
  ) {
    return true;
  }

  const remoteStat = await input.sandboxHost.workspaceFileSystem.stat(input.remotePath).catch(() => null);
  return (
    remoteStat?.kind === "file" &&
    remoteStat.size === input.localSize &&
    isWorkspaceFileMtimeMatch(remoteStat.mtimeMs, input.localMtimeMs)
  );
}

async function collectRemoteWorkspaceEntries(
  sandboxHost: SandboxHost,
  rootPath: string
): Promise<RemoteWorkspaceEntry[]> {
  const visit = async (currentPath: string): Promise<RemoteWorkspaceEntry[]> => {
    const entries = await sandboxHost.workspaceFileSystem.readdir(currentPath).catch(() => []);
    const collected: RemoteWorkspaceEntry[] = [];

    for (const entry of entries) {
      const entryPath = path.posix.join(currentPath, entry.name);
      collected.push({
        path: entryPath,
        kind: entry.kind,
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(typeof entry.updatedAt === "string" && entry.updatedAt.trim().length > 0 ? { updatedAt: entry.updatedAt } : {})
      });

      if (entry.kind === "directory") {
        collected.push(...(await visit(entryPath)));
      }
    }

    return collected;
  };

  return visit(rootPath);
}

async function pruneUnexpectedRemoteWorkspaceEntries(input: {
  sandboxHost: SandboxHost;
  rootPath: string;
  expectedDirectories: Iterable<string>;
  expectedFiles: Iterable<string>;
}): Promise<Map<string, RemoteWorkspaceEntry>> {
  const expectedDirectorySet = new Set([...input.expectedDirectories, input.rootPath]);
  const expectedFileSet = new Set(input.expectedFiles);
  const remoteEntries = await collectRemoteWorkspaceEntries(input.sandboxHost, input.rootPath);
  const keptEntries = new Map<string, RemoteWorkspaceEntry>();

  const sortedEntries = [...remoteEntries].sort((left, right) => right.path.length - left.path.length);
  for (const entry of sortedEntries) {
    const shouldKeepDirectory = entry.kind === "directory" && expectedDirectorySet.has(entry.path) && !expectedFileSet.has(entry.path);
    const shouldKeepFile = entry.kind === "file" && expectedFileSet.has(entry.path) && !expectedDirectorySet.has(entry.path);

    if (shouldKeepDirectory || shouldKeepFile) {
      keptEntries.set(entry.path, entry);
      continue;
    }

    await input.sandboxHost.workspaceFileSystem.rm(entry.path, {
      recursive: entry.kind === "directory",
      force: true
    });
  }

  return keptEntries;
}

function resolveLeafEmptyRemoteDirectories(input: {
  directories: Iterable<string>;
  filePaths: Iterable<string>;
}): string[] {
  const directories = [...input.directories]
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const filePaths = [...input.filePaths]
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath.length > 0);

  return directories.filter((candidate) => {
    const childPrefix = `${candidate}/`;
    return (
      !filePaths.some((filePath) => filePath.startsWith(childPrefix)) &&
      !directories.some((directory) => directory !== candidate && directory.startsWith(childPrefix))
    );
  });
}

function shouldAttemptSeedArchiveUpload(input: {
  sandboxHost: SandboxHost;
  plan: {
    files: SeedUploadPlanFile[];
  };
}): boolean {
  if (input.sandboxHost.providerKind !== "self_hosted") {
    return false;
  }

  const mode = resolveSeedArchiveUploadMode();
  if (mode === "off") {
    return false;
  }

  const totalBytes = input.plan.files.reduce((sum, file) => sum + file.size, 0);
  if (mode === "force") {
    return input.plan.files.length > 0;
  }

  return (
    input.plan.files.length >= DEFAULT_SEED_ARCHIVE_MIN_FILE_COUNT ||
    totalBytes >= DEFAULT_SEED_ARCHIVE_MIN_TOTAL_BYTES
  );
}

async function maybeUploadSeedArchive(input: {
  sandboxHost: SandboxHost;
  workspace: WorkspaceRecord;
  resolveArchivePath: () => Promise<string>;
  plan: {
    files: SeedUploadPlanFile[];
  };
}): Promise<boolean> {
  if (!shouldAttemptSeedArchiveUpload(input)) {
    return false;
  }

  const archivePath = await input.resolveArchivePath();
  const archiveRelativePath = path.posix.join(".openharness", ".oah-seed-upload", path.basename(archivePath));
  const archiveWorkspacePath = path.posix.join(input.workspace.rootPath, archiveRelativePath);
  const timeoutMs = resolveSeedArchiveTimeoutMs();
  let needsRemoteCleanup = false;

  try {
    const archiveBytes = await readFile(archivePath);
    await input.sandboxHost.workspaceFileSystem.writeFile(archiveWorkspacePath, archiveBytes);
    needsRemoteCleanup = true;

    const result = await input.sandboxHost.workspaceCommandExecutor.runForeground({
      workspace: input.workspace,
      cwd: input.workspace.rootPath,
      timeoutMs,
      command: [
        "set -e",
        `tar -xf ${shellQuote(archiveRelativePath)} -C .`,
        `rm -f -- ${shellQuote(archiveRelativePath)}`,
        `rmdir -- ${shellQuote(path.posix.dirname(archiveRelativePath))} 2>/dev/null || true`
      ].join("; ")
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Archive extraction exited with code ${result.exitCode}.`);
    }

    needsRemoteCleanup = false;
    return true;
  } finally {
    if (needsRemoteCleanup) {
      await input.sandboxHost.workspaceFileSystem.rm(archiveWorkspacePath, {
        force: true
      }).catch(() => undefined);
    }
  }
}

async function buildSeedArchive(input: {
  localSeedRoot: string;
  archivePath: string;
  timeoutMs?: number | undefined;
}): Promise<string> {
  const tempArchivePath = `${input.archivePath}.tmp-${createId("seed")}`;
  try {
    await runLocalProcess({
      executable: "tar",
      args: [
        "-cf",
        tempArchivePath,
        "--exclude=.DS_Store",
        "--exclude=__pycache__",
        "--exclude=*/__pycache__",
        "--exclude=*.pyc",
        "--exclude=*.db-shm",
        "--exclude=*.db-wal",
        "-C",
        input.localSeedRoot,
        "."
      ],
      timeoutMs: input.timeoutMs
    });
    await rename(tempArchivePath, input.archivePath);
    return input.archivePath;
  } catch (error) {
    await rm(tempArchivePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ensurePreparedSeedArchive(entry: PreparedSeedCacheEntry): Promise<string> {
  if (entry.archivePath) {
    return Promise.resolve(entry.archivePath);
  }

  if (!entry.archivePromise) {
    entry.archivePromise = buildSeedArchive({
      localSeedRoot: entry.preparedWorkspaceRoot,
      archivePath: path.join(entry.cacheRoot, "workspace-seed.tar"),
      timeoutMs: resolveSeedArchiveTimeoutMs()
    })
      .then((archivePath) => {
        entry.archivePath = archivePath;
        return archivePath;
      })
      .catch((error) => {
        entry.archivePromise = undefined;
        throw error;
      });
  }

  return entry.archivePromise;
}

async function uploadDirectoryTree(input: {
  currentLocalPath: string;
  currentRemotePath: string;
  sandboxHost: SandboxHost;
}): Promise<void> {
  return observeNativeWorkspaceSyncOperation({
    operation: "sync_local_to_sandbox_http",
    implementation: "ts",
    target: input.currentLocalPath,
    logSuccess: false,
    logFailure: false,
    metadata: {
      remoteRootPath: input.currentRemotePath
    },
    action: async () => {
      const plan =
        (await collectNativeDirectoryUploadPlan(input)) ??
        (await observeNativeWorkspaceSyncOperation({
          operation: "plan_seed_upload",
          implementation: "ts",
          target: input.currentLocalPath,
          logSuccess: false,
          logFailure: false,
          metadata: {
            remoteRootPath: input.currentRemotePath
          },
          action: () => collectDirectoryUploadPlan(input)
        }));
      const concurrency = resolveSeedUploadConcurrency();

      const remoteEntries = await pruneUnexpectedRemoteWorkspaceEntries({
        sandboxHost: input.sandboxHost,
        rootPath: input.currentRemotePath,
        expectedDirectories: plan.directories,
        expectedFiles: plan.files.map((file) => file.remotePath)
      });

      const directoriesToCreate = (
        input.sandboxHost.providerKind === "self_hosted"
          ? resolveLeafEmptyRemoteDirectories({
              directories: plan.directories,
              filePaths: plan.files.map((file) => file.remotePath)
            })
          : plan.directories
      ).filter((remotePath) => remoteEntries.get(remotePath)?.kind !== "directory");

      await runWithConcurrency(directoriesToCreate, concurrency, async (remotePath) => {
        await input.sandboxHost.workspaceFileSystem.mkdir(remotePath, { recursive: true });
      });

      await runWithConcurrency(plan.files, concurrency, async ({ localPath, remotePath, size, mtimeMs }) => {
        if (
          await shouldSkipSeedFileUpload({
            sandboxHost: input.sandboxHost,
            remotePath,
            localSize: size,
            localMtimeMs: mtimeMs,
            remoteEntryFound: remoteEntries.has(remotePath),
            remoteEntry: remoteEntries.get(remotePath)
          })
        ) {
          return;
        }

        const data = await readFile(localPath);
        await input.sandboxHost.workspaceFileSystem.writeFile(remotePath, data, {
          ...(Number.isFinite(mtimeMs) && mtimeMs > 0 ? { mtimeMs: Number(mtimeMs) } : {})
        });
      });
    }
  });
}

async function uploadDirectoryTreeToSelfHostedSandboxNative(input: {
  currentLocalPath: string;
  currentRemotePath: string;
  sandbox: {
    id: string;
    baseUrl: string;
    headers?: Record<string, string> | undefined;
  };
}): Promise<void> {
  const maxConcurrency = resolveSeedUploadConcurrency();
  await observeNativeWorkspaceSyncOperation({
    operation: "sync_local_to_sandbox_http",
    implementation: "rust",
    target: input.currentLocalPath,
    logFailure: false,
    metadata: {
      remoteRootPath: input.currentRemotePath,
      sandboxId: input.sandbox.id,
      maxConcurrency
    },
    action: () =>
      nativeWorkspaceSyncAdapter.syncLocalToSandboxHttp({
        rootDir: input.currentLocalPath,
        remoteRootPath: input.currentRemotePath,
        maxConcurrency,
        sandbox: {
          baseUrl: input.sandbox.baseUrl,
          sandboxId: input.sandbox.id,
          ...(input.sandbox.headers ? { headers: input.sandbox.headers } : {})
        }
      })
  });
}

async function uploadWorkspaceSeed(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
  localSeedRoot: string;
  resolveArchivePath: () => Promise<string>;
  sandboxHost: SandboxHost;
  remoteRootPath?: string | undefined;
  selfHostedSandbox?:
    | {
        id: string;
        baseUrl: string;
        headers?: Record<string, string> | undefined;
      }
    | undefined;
}): Promise<void> {
  const lease = await input.sandboxHost.workspaceFileAccessProvider.acquire({
    workspace: createSandboxSeedWorkspace({
      workspaceId: input.workspaceId,
      request: input.request,
      initialized: input.initialized,
      remoteRootPath: input.remoteRootPath
    }),
    access: "write"
  });

  try {
    const existingRoot = await input.sandboxHost.workspaceFileSystem.stat(lease.workspace.rootPath).catch(() => null);
    if (existingRoot?.kind && existingRoot.kind !== "directory") {
      await input.sandboxHost.workspaceFileSystem.rm(lease.workspace.rootPath, {
        recursive: true,
        force: true
      });
    }
    if (!existingRoot || existingRoot.kind !== "directory") {
      if (lease.workspace.rootPath !== SANDBOX_WORKSPACE_ROOT) {
        await input.sandboxHost.workspaceFileSystem.mkdir(lease.workspace.rootPath, { recursive: true });
      }
    }
    if (input.selfHostedSandbox) {
      try {
        const archivePlan =
          (await collectNativeDirectoryUploadPlan({
            currentLocalPath: input.localSeedRoot,
            currentRemotePath: lease.workspace.rootPath
          })) ?? (await collectDirectoryUploadPlan({
            currentLocalPath: input.localSeedRoot,
            currentRemotePath: lease.workspace.rootPath
          }));
        if (
          await maybeUploadSeedArchive({
            sandboxHost: input.sandboxHost,
            workspace: lease.workspace,
            resolveArchivePath: input.resolveArchivePath,
            plan: archivePlan
          })
        ) {
          return;
        }
      } catch (error) {
        recordNativeWorkspaceSyncFallback({
          operation: "sync_local_to_sandbox_http",
          target: input.localSeedRoot,
          attemptedImplementation: "ts",
          fallbackImplementation: nativeWorkspaceSyncAdapter.isEnabled() ? "rust" : "ts",
          error,
          metadata: {
            mode: "archive_upload",
            remoteRootPath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
            ...(input.selfHostedSandbox ? { sandboxId: input.selfHostedSandbox.id } : {})
          }
        });
      }
    }
    if (input.selfHostedSandbox && nativeWorkspaceSyncAdapter.isEnabled()) {
      try {
        await uploadDirectoryTreeToSelfHostedSandboxNative({
          currentLocalPath: input.localSeedRoot,
          currentRemotePath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
          sandbox: input.selfHostedSandbox
        });
        return;
      } catch (error) {
        recordNativeWorkspaceSyncFallback({
          operation: "sync_local_to_sandbox_http",
          target: input.localSeedRoot,
          error,
          metadata: {
            remoteRootPath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
            sandboxId: input.selfHostedSandbox.id
          }
        });
      }
    }

    await uploadDirectoryTree({
      currentLocalPath: input.localSeedRoot,
      currentRemotePath: lease.workspace.rootPath,
      sandboxHost: input.sandboxHost
    });
  } finally {
    await lease.release({ dirty: true });
  }
}

function createSandboxSeedWorkspace(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
  remoteRootPath?: string | undefined;
}) {
  const now = new Date().toISOString();
  return {
    id: input.workspaceId,
    kind: "project" as const,
    readOnly: false,
    historyMirrorEnabled: true,
    defaultAgent: input.initialized.defaultAgent,
    projectAgentsMd: input.initialized.projectAgentsMd,
    settings: input.initialized.settings,
    workspaceModels: input.initialized.workspaceModels,
    agents: input.initialized.agents,
    actions: input.initialized.actions,
    skills: input.initialized.skills,
    toolServers: input.initialized.toolServers,
    hooks: input.initialized.hooks,
    catalog: {
      ...input.initialized.catalog,
      workspaceId: input.workspaceId
    },
    ...(input.request.externalRef ? { externalRef: input.request.externalRef } : {}),
    ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
    ...(input.request.serviceName ? { serviceName: input.request.serviceName } : {}),
    ...(input.request.runtime ? { runtime: input.request.runtime } : {}),
    name: input.request.name,
    rootPath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
    executionPolicy: input.request.executionPolicy ?? "local",
    status: "active" as const,
    createdAt: now,
    updatedAt: now
  };
}

async function createSelfHostedSandbox(input: {
  request: CreateWorkspaceRequest;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
}) {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/sandboxes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.headers ?? {})
    },
    body: JSON.stringify({
      name: input.request.name,
      runtime: input.request.runtime,
      executionPolicy: input.request.executionPolicy,
      ...(input.request.externalRef ? { externalRef: input.request.externalRef } : {}),
      ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
      ...(input.request.serviceName ? { serviceName: input.request.serviceName } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create self-hosted sandbox: ${response.status} ${response.statusText}`);
  }

  return sandboxSchema.parse(await response.json());
}

export function createSandboxBackedWorkspaceInitializer(options: {
  runtimeDir: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  platformModels: PlatformModelRegistry;
  platformAgents: Record<string, DiscoveredAgent>;
  sandboxHost: SandboxHost;
  selfHosted?: {
    baseUrl: string;
    headers?: Record<string, string> | undefined;
  } | undefined;
}) {
  async function prepareSeed(input: CreateWorkspaceRequest): Promise<PreparedSeedCacheEntry> {
    const cacheKey = await buildPreparedSeedCacheKey({
      runtimeDir: options.runtimeDir,
      runtimeName: input.runtime,
      platformToolDir: options.platformToolDir,
      platformSkillDir: options.platformSkillDir,
      toolDir: options.toolDir,
      agentsMd: input.agentsMd,
      toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
      skills: input.skills
    });

    let cached = preparedSeedCache.get(cacheKey);
    if (!cached) {
      cached = (async () => {
        const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-prepared-seed-"));
        const preparedWorkspaceRoot = path.join(cacheRoot, "workspace");

        await initializeWorkspaceFromRuntime({
          runtimeDir: options.runtimeDir,
          runtimeName: input.runtime,
          rootPath: preparedWorkspaceRoot,
          platformToolDir: options.platformToolDir,
          platformSkillDir: options.platformSkillDir,
          agentsMd: input.agentsMd,
          toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
          skills: input.skills
        });

        const discovered = await enrichWorkspaceModelsWithDiscoveredMetadata(
          await discoverWorkspace(preparedWorkspaceRoot, "project", {
            platformModels: options.platformModels,
            platformAgents: options.platformAgents,
            platformSkillDir: options.platformSkillDir,
            platformToolDir: options.toolDir
          })
        );

        return {
          cacheRoot,
          preparedWorkspaceRoot,
          discovered
        };
      })().catch((error) => {
        preparedSeedCache.delete(cacheKey);
        throw error;
      });
      preparedSeedCache.set(cacheKey, cached);
    }

    return cached;
  }

  return {
    async initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult> {
      const workspaceId = (
        input as CreateWorkspaceRequest & {
          workspaceId?: string | undefined;
        }
      ).workspaceId?.trim() || createId("ws");
      let remoteRootPath = SANDBOX_WORKSPACE_ROOT;
      let selfHostedSandbox:
        | {
            id: string;
            baseUrl: string;
            headers?: Record<string, string> | undefined;
          }
        | undefined;

      const prepared = await prepareSeed(input);

      if (options.selfHosted) {
        const sandbox = await createSelfHostedSandbox({
          request: input,
          baseUrl: options.selfHosted.baseUrl,
          headers: options.selfHosted.headers
        });
        remoteRootPath = sandbox.rootPath;
        selfHostedSandbox = {
          id: sandbox.id,
          baseUrl: options.selfHosted.baseUrl,
          ...(options.selfHosted.headers ? { headers: options.selfHosted.headers } : {})
        };
      }

      await uploadWorkspaceSeed({
        workspaceId,
        request: input,
        initialized: prepared.discovered,
        localSeedRoot: prepared.preparedWorkspaceRoot,
        resolveArchivePath: () => ensurePreparedSeedArchive(prepared),
        sandboxHost: options.sandboxHost,
        remoteRootPath,
        selfHostedSandbox
      });

      return {
        ...prepared.discovered,
        id: workspaceId,
        rootPath: remoteRootPath
      };
    }
  };
}
