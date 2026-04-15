import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRecord } from "@oah/runtime-core";
import type { WorkspaceLeaseRegistry, WorkspacePlacementRegistry } from "@oah/storage-redis";

import {
  computeLocalDirectoryFingerprint,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal,
  type DirectoryObjectStore
} from "../object-storage.js";

type WorkspaceMaterializationSource =
  | {
      kind: "object_store";
      bucket?: string | undefined;
      remotePrefix: string;
    }
  | {
      kind: "local_directory";
      rootPath: string;
    };

interface WorkspaceMaterializationEntry {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  source: WorkspaceMaterializationSource;
  localPath: string;
  dirty: boolean;
  refCount: number;
  materializedAt?: string | undefined;
  lastActivityAt: string;
  inFlight?: Promise<void> | undefined;
}

export class WorkspaceMaterializationDrainingError extends Error {
  constructor(message = "Workspace materialization is draining and cannot start a new object-store materialization.") {
    super(message);
    this.name = "WorkspaceMaterializationDrainingError";
  }
}

export type WorkspaceMaterializationFailureStage =
  | "materialize"
  | "idle_flush"
  | "idle_evict"
  | "drain_evict"
  | "drain_release"
  | "close";

export interface WorkspaceMaterializationFailureDiagnostic {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  sourceKind: "object_store" | "local_directory";
  localPath: string;
  remotePrefix?: string | undefined;
  stage: WorkspaceMaterializationFailureStage;
  operation: "materialize" | "flush" | "evict";
  at: string;
  errorMessage: string;
  dirty: boolean;
  refCount: number;
  draining: boolean;
}

export class WorkspaceMaterializationOperationError extends Error {
  readonly diagnostic: WorkspaceMaterializationFailureDiagnostic;
  readonly cause: unknown;

  constructor(diagnostic: WorkspaceMaterializationFailureDiagnostic, cause: unknown) {
    super(
      `Workspace materialization ${diagnostic.operation} failed during ${diagnostic.stage} for ${diagnostic.workspaceId}@${diagnostic.version}: ${diagnostic.errorMessage}`
    );
    this.name = "WorkspaceMaterializationOperationError";
    this.diagnostic = diagnostic;
    this.cause = cause;
  }
}

export class WorkspaceMaterializationAggregateError extends Error {
  readonly failures: WorkspaceMaterializationFailureDiagnostic[];

  constructor(failures: WorkspaceMaterializationFailureDiagnostic[]) {
    super(
      `Workspace materialization encountered ${failures.length} failure(s): ${failures
        .map((failure) => `${failure.workspaceId}@${failure.version}:${failure.stage}`)
        .join(", ")}`
    );
    this.name = "WorkspaceMaterializationAggregateError";
    this.failures = failures;
  }
}

export interface WorkspaceMaterializationSnapshot {
  cacheKey: string;
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  sourceKind: "object_store" | "local_directory";
  localPath: string;
  remotePrefix?: string | undefined;
  dirty: boolean;
  refCount: number;
  materializedAt?: string | undefined;
  lastActivityAt: string;
}

export interface WorkspaceMaterializationDiagnostics {
  draining: boolean;
  drainStartedAt?: string | undefined;
  cachedCopies: number;
  objectStoreCopies: number;
  dirtyCopies: number;
  busyCopies: number;
  idleCopies: number;
  failureCount: number;
  blockerCount: number;
  failures: WorkspaceMaterializationFailureDiagnostic[];
}

export interface WorkspaceMaterializationLease {
  workspaceId: string;
  version: string;
  ownerWorkerId: string;
  localPath: string;
  sourceKind: "object_store" | "local_directory";
  remotePrefix?: string | undefined;
  markDirty(): void;
  touch(): void;
  release(options?: { dirty?: boolean | undefined }): Promise<void>;
}

export interface WorkspaceMaterializationManagerOptions {
  cacheRoot: string;
  workerId: string;
  ownerBaseUrl?: string | undefined;
  store: DirectoryObjectStore;
  leaseRegistry?: WorkspaceLeaseRegistry | undefined;
  placementRegistry?: WorkspacePlacementRegistry | undefined;
  leaseTtlMs?: number | undefined;
  logger?: ((message: string) => void) | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRemotePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "workspace";
}

function buildCacheSuffix(input: { workspaceId: string; version: string; source: WorkspaceMaterializationSource }): string {
  const sourceKey = input.source.kind === "object_store" ? `${input.source.bucket ?? ""}:${input.source.remotePrefix}` : input.source.rootPath;
  return createHash("sha1").update(`${input.workspaceId}:${input.version}:${sourceKey}`).digest("hex").slice(0, 12);
}

function parseExternalWorkspaceRef(externalRef: string): { bucket?: string | undefined; remotePrefix: string } {
  const parsed = new URL(externalRef);
  if (parsed.protocol !== "s3:") {
    throw new Error(`Unsupported workspace externalRef protocol: ${parsed.protocol}`);
  }

  return {
    bucket: parsed.hostname || undefined,
    remotePrefix: normalizeRemotePrefix(parsed.pathname)
  };
}

function resolveWorkspaceMaterializationSource(
  workspace: Pick<WorkspaceRecord, "rootPath" | "externalRef">
): WorkspaceMaterializationSource {
  if (!workspace.externalRef) {
    return {
      kind: "local_directory",
      rootPath: workspace.rootPath
    };
  }

  const parsed = parseExternalWorkspaceRef(workspace.externalRef);
  return {
    kind: "object_store",
    bucket: parsed.bucket,
    remotePrefix: parsed.remotePrefix
  };
}

export class WorkspaceMaterializationManager {
  readonly #cacheRoot: string;
  readonly #workerId: string;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #store: DirectoryObjectStore;
  readonly #leaseRegistry?: WorkspaceLeaseRegistry | undefined;
  readonly #placementRegistry?: WorkspacePlacementRegistry | undefined;
  readonly #leaseTtlMs: number;
  readonly #logger: (message: string) => void;
  readonly #entries = new Map<string, WorkspaceMaterializationEntry>();
  readonly #failures = new Map<string, WorkspaceMaterializationFailureDiagnostic>();
  #draining = false;
  #drainStartedAt: string | undefined;

  constructor(options: WorkspaceMaterializationManagerOptions) {
    this.#cacheRoot = options.cacheRoot;
    this.#workerId = options.workerId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#store = options.store;
    this.#leaseRegistry = options.leaseRegistry;
    this.#placementRegistry = options.placementRegistry;
    this.#leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 15_000);
    this.#logger = options.logger ?? (() => undefined);
  }

  async acquireWorkspace(input: {
    workspace: Pick<WorkspaceRecord, "id" | "rootPath" | "externalRef">;
    version?: string | undefined;
  }): Promise<WorkspaceMaterializationLease> {
    const version = input.version?.trim() || "live";
    const source = resolveWorkspaceMaterializationSource(input.workspace);
    if (source.kind === "object_store" && source.bucket && this.#store.bucket && source.bucket !== this.#store.bucket) {
      throw new Error(
        `Workspace ${input.workspace.id} points to bucket ${source.bucket}, but the configured object store is ${this.#store.bucket}.`
      );
    }

    const cacheKey = this.#cacheKey(input.workspace.id, version, source);
    let entry = this.#entries.get(cacheKey);
    if (this.#draining && !entry && source.kind === "object_store") {
      throw new WorkspaceMaterializationDrainingError();
    }
    if (!entry) {
      entry = {
        cacheKey,
        workspaceId: input.workspace.id,
        version,
        ownerWorkerId: this.#workerId,
        source,
        localPath: this.#localPathForEntry(input.workspace.id, version, source),
        dirty: false,
        refCount: 0,
        lastActivityAt: nowIso()
      };
      this.#entries.set(cacheKey, entry);
    }

    await this.#ensureMaterialized(entry);
    const baselineFingerprint =
      entry.source.kind === "object_store" ? await computeLocalDirectoryFingerprint(entry.localPath) : undefined;
    entry.refCount += 1;
    this.#touchEntry(entry);
    await this.#publishEntry(entry);

    let released = false;
    return {
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      localPath: entry.localPath,
      sourceKind: entry.source.kind,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      markDirty: () => {
        entry!.dirty = true;
        this.#touchEntry(entry!);
      },
      touch: () => {
        this.#touchEntry(entry!);
      },
      release: async (options?: { dirty?: boolean | undefined }) => {
        if (released) {
          return;
        }

        released = true;
        if (options?.dirty) {
          if (baselineFingerprint !== undefined) {
            entry!.dirty ||= (await computeLocalDirectoryFingerprint(entry!.localPath)) !== baselineFingerprint;
          } else {
            entry!.dirty = true;
          }
        }
        entry!.refCount = Math.max(0, entry!.refCount - 1);
        this.#touchEntry(entry!);
        await this.#publishEntry(entry!);
        if (this.#draining && entry!.refCount === 0) {
          await this.#flushAndEvictEntry(entry!, "drain_release");
        }
      }
    };
  }

  isDraining(): boolean {
    return this.#draining;
  }

  drainStartedAt(): string | undefined {
    return this.#drainStartedAt;
  }

  snapshot(): WorkspaceMaterializationSnapshot[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        cacheKey: entry.cacheKey,
        workspaceId: entry.workspaceId,
        version: entry.version,
        ownerWorkerId: entry.ownerWorkerId,
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        sourceKind: entry.source.kind,
        localPath: entry.localPath,
        ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
        dirty: entry.dirty,
        refCount: entry.refCount,
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
        lastActivityAt: entry.lastActivityAt
      }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) || left.version.localeCompare(right.version));
  }

  diagnostics(): WorkspaceMaterializationDiagnostics {
    const snapshots = this.snapshot();
    const failures = [...this.#failures.values()].sort((left, right) => left.at.localeCompare(right.at));
    return {
      draining: this.#draining,
      ...(this.#drainStartedAt ? { drainStartedAt: this.#drainStartedAt } : {}),
      cachedCopies: snapshots.length,
      objectStoreCopies: snapshots.filter((entry) => entry.sourceKind === "object_store").length,
      dirtyCopies: snapshots.filter((entry) => entry.dirty).length,
      busyCopies: snapshots.filter((entry) => entry.refCount > 0).length,
      idleCopies: snapshots.filter((entry) => entry.refCount === 0).length,
      failureCount: failures.length,
      blockerCount: failures.filter((failure) => failure.dirty || failure.refCount > 0 || failure.stage.startsWith("drain")).length,
      failures
    };
  }

  async beginDrain(): Promise<{
    drainStartedAt: string;
    flushed: WorkspaceMaterializationSnapshot[];
    evicted: WorkspaceMaterializationSnapshot[];
  }> {
    if (!this.#draining) {
      this.#draining = true;
      this.#drainStartedAt = nowIso();
      this.#logger("[workspace-materialization] drain started; blocking new object-store materializations");
      await Promise.all([...this.#entries.values()].map((entry) => this.#publishEntry(entry)));
    }

    const drained = await this.#flushAndEvictIdleEntries(Date.now(), "drain_evict");
    const drainStartedAt = this.#drainStartedAt ?? nowIso();
    this.#drainStartedAt = drainStartedAt;
    return {
      drainStartedAt,
      flushed: drained.flushed,
      evicted: drained.evicted
    };
  }

  async flushIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const flushed: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of this.#entries.values()) {
      if (!this.#isIdle(entry, thresholdMs) || !entry.dirty) {
        continue;
      }
      try {
        await this.#flushEntry(entry, "idle_flush");
        await this.#publishEntry(entry);
        flushed.push(this.#toSnapshot(entry));
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "idle_flush", "flush"));
      }
    }

    this.#throwIfFailures(failures);
    return flushed;
  }

  async evictIdleCopies(options?: { idleBefore?: string | undefined }): Promise<WorkspaceMaterializationSnapshot[]> {
    const thresholdMs = options?.idleBefore ? Date.parse(options.idleBefore) : Date.now();
    const evicted: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of [...this.#entries.values()]) {
      if (!this.#isIdle(entry, thresholdMs)) {
        continue;
      }

      try {
        await this.#flushAndEvictEntry(entry, "idle_evict");
        evicted.push(this.#toSnapshot(entry));
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "idle_evict", entry.dirty ? "flush" : "evict"));
      }
    }

    this.#throwIfFailures(failures);
    return evicted;
  }

  async close(): Promise<void> {
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];
    for (const entry of [...this.#entries.values()]) {
      try {
        await this.#flushAndEvictEntry(entry, "close");
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, "close", entry.dirty ? "flush" : "evict"));
      }
    }
    this.#throwIfFailures(failures);
  }

  async refreshLeases(): Promise<void> {
    for (const entry of this.#entries.values()) {
      await this.#publishEntry(entry);
    }
  }

  async #ensureMaterialized(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (entry.source.kind !== "object_store") {
      entry.materializedAt ??= nowIso();
      this.#failures.delete(entry.cacheKey);
      return;
    }

    if (entry.materializedAt) {
      return;
    }

    const source = entry.source;
    if (!entry.inFlight) {
      entry.inFlight = (async () => {
        try {
          await mkdir(path.dirname(entry.localPath), { recursive: true });
          this.#logger(
            `[workspace-materialization] materializing workspace ${entry.workspaceId} (${entry.version}) from ${source.remotePrefix} into ${entry.localPath}`
          );
          await syncRemotePrefixToLocal(this.#store, source.remotePrefix, entry.localPath, this.#logger, entry.workspaceId);
          entry.materializedAt = nowIso();
          this.#failures.delete(entry.cacheKey);
        } catch (error) {
          throw this.#recordOperationFailure(entry, "materialize", "materialize", error);
        }
      })().finally(() => {
        entry.inFlight = undefined;
      });
    }

    await entry.inFlight;
  }

  async #flushEntry(entry: WorkspaceMaterializationEntry, stage: WorkspaceMaterializationFailureStage): Promise<void> {
    if (entry.source.kind !== "object_store" || !entry.dirty) {
      return;
    }

    try {
      this.#logger(
        `[workspace-materialization] flushing workspace ${entry.workspaceId} (${entry.version}) from ${entry.localPath} back to ${entry.source.remotePrefix}`
      );
      await syncLocalDirectoryToRemote(this.#store, entry.source.remotePrefix, entry.localPath, this.#logger, entry.workspaceId);
      entry.dirty = false;
      this.#touchEntry(entry);
      this.#failures.delete(entry.cacheKey);
    } catch (error) {
      throw this.#recordOperationFailure(entry, stage, "flush", error);
    }
  }

  async #flushAndEvictIdleEntries(thresholdMs: number, stage: Extract<WorkspaceMaterializationFailureStage, "idle_evict" | "drain_evict">): Promise<{
    flushed: WorkspaceMaterializationSnapshot[];
    evicted: WorkspaceMaterializationSnapshot[];
  }> {
    const flushed: WorkspaceMaterializationSnapshot[] = [];
    const evicted: WorkspaceMaterializationSnapshot[] = [];
    const failures: WorkspaceMaterializationFailureDiagnostic[] = [];

    for (const entry of [...this.#entries.values()]) {
      if (!this.#isIdle(entry, thresholdMs)) {
        continue;
      }

      const wasDirty = entry.dirty;
      try {
        await this.#flushAndEvictEntry(entry, stage);
        const snapshot = this.#toSnapshot(entry);
        if (wasDirty) {
          flushed.push(snapshot);
        }
        evicted.push(snapshot);
      } catch (error) {
        failures.push(this.#toFailureDiagnostic(error, entry, stage, wasDirty ? "flush" : "evict"));
      }
    }

    this.#throwIfFailures(failures);
    return {
      flushed,
      evicted
    };
  }

  async #flushAndEvictEntry(entry: WorkspaceMaterializationEntry, stage: Exclude<WorkspaceMaterializationFailureStage, "materialize" | "idle_flush">): Promise<void> {
    if (entry.dirty) {
      await this.#flushEntry(entry, stage);
    }
    try {
      await this.#removeEntryLease(entry);
      if (entry.source.kind === "object_store") {
        await rm(entry.localPath, { recursive: true, force: true });
      }
      this.#entries.delete(entry.cacheKey);
      this.#failures.delete(entry.cacheKey);
    } catch (error) {
      throw this.#recordOperationFailure(entry, stage, "evict", error);
    }
  }

  #touchEntry(entry: WorkspaceMaterializationEntry): void {
    entry.lastActivityAt = nowIso();
  }

  async #publishEntry(entry: WorkspaceMaterializationEntry): Promise<void> {
    if (this.#leaseRegistry) {
      await this.#leaseRegistry.heartbeat(
        {
          workspaceId: entry.workspaceId,
          version: entry.version,
          ownerWorkerId: entry.ownerWorkerId,
          ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
          sourceKind: entry.source.kind,
          localPath: entry.localPath,
          dirty: entry.dirty,
          refCount: entry.refCount,
          lastActivityAt: entry.lastActivityAt,
          lastSeenAt: nowIso(),
          ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
          ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
        },
        this.#leaseTtlMs
      );
    }

    if (this.#placementRegistry) {
      await this.#placementRegistry.upsert({
        workspaceId: entry.workspaceId,
        version: entry.version,
        state: this.#draining ? "draining" : entry.refCount > 0 ? "active" : "idle",
        ownerWorkerId: entry.ownerWorkerId,
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        sourceKind: entry.source.kind,
        localPath: entry.localPath,
        ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
        dirty: entry.dirty,
        refCount: entry.refCount,
        lastActivityAt: entry.lastActivityAt,
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
        updatedAt: nowIso()
      });
    }
  }

  async #removeEntryLease(entry: WorkspaceMaterializationEntry): Promise<void> {
    await this.#leaseRegistry?.remove(entry.workspaceId, entry.version, entry.ownerWorkerId);
    await this.#placementRegistry?.upsert({
      workspaceId: entry.workspaceId,
      version: entry.version,
      state: "evicted",
      ownerWorkerId: entry.ownerWorkerId,
      ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      dirty: false,
      refCount: 0,
      lastActivityAt: entry.lastActivityAt,
      ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
      updatedAt: nowIso()
    });
  }

  #cacheKey(workspaceId: string, version: string, source: WorkspaceMaterializationSource): string {
    return `${workspaceId}:${version}:${buildCacheSuffix({ workspaceId, version, source })}`;
  }

  #localPathForEntry(workspaceId: string, version: string, source: WorkspaceMaterializationSource): string {
    if (source.kind === "local_directory") {
      return source.rootPath;
    }

    const workspaceSegment = safeSegment(workspaceId);
    const versionSegment = safeSegment(version);
    const suffix = buildCacheSuffix({ workspaceId, version, source });
    return path.join(this.#cacheRoot, workspaceSegment, `${versionSegment}-${suffix}`);
  }

  #isIdle(entry: WorkspaceMaterializationEntry, thresholdMs: number): boolean {
    return entry.refCount === 0 && Date.parse(entry.lastActivityAt) <= thresholdMs;
  }

  #toSnapshot(entry: WorkspaceMaterializationEntry): WorkspaceMaterializationSnapshot {
    return {
      cacheKey: entry.cacheKey,
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      dirty: entry.dirty,
      refCount: entry.refCount,
      ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
      lastActivityAt: entry.lastActivityAt
    };
  }

  #recordOperationFailure(
    entry: WorkspaceMaterializationEntry,
    stage: WorkspaceMaterializationFailureStage,
    operation: WorkspaceMaterializationFailureDiagnostic["operation"],
    error: unknown
  ): WorkspaceMaterializationOperationError {
    const diagnostic: WorkspaceMaterializationFailureDiagnostic = {
      cacheKey: entry.cacheKey,
      workspaceId: entry.workspaceId,
      version: entry.version,
      ownerWorkerId: entry.ownerWorkerId,
      sourceKind: entry.source.kind,
      localPath: entry.localPath,
      ...(entry.source.kind === "object_store" ? { remotePrefix: entry.source.remotePrefix } : {}),
      stage,
      operation,
      at: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error),
      dirty: entry.dirty,
      refCount: entry.refCount,
      draining: this.#draining
    };
    this.#failures.set(entry.cacheKey, diagnostic);
    this.#logger(
      `[workspace-materialization] ${operation} failed during ${stage} for workspace ${entry.workspaceId} (${entry.version}): ${diagnostic.errorMessage}`
    );
    return new WorkspaceMaterializationOperationError(diagnostic, error);
  }

  #toFailureDiagnostic(
    error: unknown,
    entry: WorkspaceMaterializationEntry,
    stage: WorkspaceMaterializationFailureStage,
    operation: WorkspaceMaterializationFailureDiagnostic["operation"]
  ): WorkspaceMaterializationFailureDiagnostic {
    if (error instanceof WorkspaceMaterializationOperationError) {
      return error.diagnostic;
    }

    return this.#recordOperationFailure(entry, stage, operation, error).diagnostic;
  }

  #throwIfFailures(failures: WorkspaceMaterializationFailureDiagnostic[]): void {
    if (failures.length > 0) {
      throw new WorkspaceMaterializationAggregateError(failures);
    }
  }
}
