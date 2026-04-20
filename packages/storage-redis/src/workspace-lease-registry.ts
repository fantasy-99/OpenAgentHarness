import { createClient, type RedisClientType } from "redis";

import type { WorkspaceLeaseEntry, WorkspaceLeaseInput, WorkspaceLeaseRegistry } from "@oah/engine-core";
import type { CreateRedisWorkspaceLeaseRegistryOptions } from "./registry-types.js";

const DEFAULT_WORKSPACE_LEASE_TTL_MS = 15_000;

function deriveRedisWorkspaceLeaseEntry(
  entry: WorkspaceLeaseInput & {
    leaseTtlMs?: number | undefined;
    expiresAt?: string | undefined;
  },
  nowMs: number
): WorkspaceLeaseEntry {
  const parsedLastSeenAtMs = Date.parse(entry.lastSeenAt);
  const lastSeenAtMs = Number.isFinite(parsedLastSeenAtMs) ? parsedLastSeenAtMs : 0;
  const leaseTtlMs =
    typeof entry.leaseTtlMs === "number" && Number.isFinite(entry.leaseTtlMs) && entry.leaseTtlMs > 0
      ? Math.floor(entry.leaseTtlMs)
      : DEFAULT_WORKSPACE_LEASE_TTL_MS;
  const parsedExpiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const expiresAtMs =
    Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs >= lastSeenAtMs ? parsedExpiresAtMs : lastSeenAtMs + leaseTtlMs;
  const lastSeenAgeMs = Math.max(0, nowMs - lastSeenAtMs);
  const lateThresholdMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));

  return {
    workspaceId: entry.workspaceId,
    version: entry.version,
    ownerWorkerId: entry.ownerWorkerId,
    ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
    sourceKind: entry.sourceKind,
    localPath: entry.localPath,
    dirty: entry.dirty,
    refCount: entry.refCount,
    lastActivityAt: entry.lastActivityAt,
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    leaseTtlMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    lastSeenAgeMs,
    health: expiresAtMs - nowMs <= lateThresholdMs ? "late" : "healthy",
    ...(entry.remotePrefix ? { remotePrefix: entry.remotePrefix } : {}),
    ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
  };
}

export class RedisWorkspaceLeaseRegistry implements WorkspaceLeaseRegistry {
  readonly #commands: RedisClientType;
  readonly #ownsCommands: boolean;
  readonly #keyPrefix: string;

  constructor(options: CreateRedisWorkspaceLeaseRegistryOptions) {
    this.#commands = options.commands ?? createClient({ url: options.url });
    this.#ownsCommands = !options.commands;
    this.#keyPrefix = options.keyPrefix ?? "oah";
  }

  async connect(): Promise<void> {
    if (!this.#commands.isOpen) {
      await this.#commands.connect();
    }
  }

  async heartbeat(entry: WorkspaceLeaseInput, ttlMs: number): Promise<void> {
    const leaseTtlMs = Math.max(1_000, Math.floor(ttlMs));
    const lastSeenAtMs = Number.isFinite(Date.parse(entry.lastSeenAt)) ? Date.parse(entry.lastSeenAt) : 0;
    const expiresAt = new Date(lastSeenAtMs + leaseTtlMs).toISOString();
    const leaseId = this.#leaseId(entry.workspaceId, entry.version, entry.ownerWorkerId);
    const transaction = this.#commands
      .multi()
      .sAdd(this.#registrySetKey(), leaseId)
      .sAdd(this.#workspaceLeaseSetKey(entry.workspaceId), leaseId)
      .hSet(this.#leaseKey(leaseId), {
        workspaceId: entry.workspaceId,
        version: entry.version,
        ownerWorkerId: entry.ownerWorkerId,
        ...(entry.ownerBaseUrl ? { ownerBaseUrl: entry.ownerBaseUrl } : {}),
        sourceKind: entry.sourceKind,
        localPath: entry.localPath,
        dirty: entry.dirty ? "1" : "0",
        refCount: String(Math.max(0, Math.floor(entry.refCount))),
        lastActivityAt: entry.lastActivityAt,
        lastSeenAt: entry.lastSeenAt,
        leaseTtlMs: String(leaseTtlMs),
        expiresAt,
        ...(entry.remotePrefix ? { remotePrefix: entry.remotePrefix } : {}),
        ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {})
      });

    if (!entry.remotePrefix) {
      transaction.hDel(this.#leaseKey(leaseId), "remotePrefix");
    }
    if (!entry.ownerBaseUrl) {
      transaction.hDel(this.#leaseKey(leaseId), "ownerBaseUrl");
    }
    if (!entry.materializedAt) {
      transaction.hDel(this.#leaseKey(leaseId), "materializedAt");
    }

    await transaction.pExpire(this.#leaseKey(leaseId), leaseTtlMs).exec();
  }

  async remove(workspaceId: string, version: string, ownerWorkerId: string): Promise<void> {
    const leaseId = this.#leaseId(workspaceId, version, ownerWorkerId);
    await this.#commands
      .multi()
      .sRem(this.#registrySetKey(), leaseId)
      .sRem(this.#workspaceLeaseSetKey(workspaceId), leaseId)
      .del(this.#leaseKey(leaseId))
      .exec();
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (normalizedWorkspaceId.length === 0) {
      return;
    }

    const workspaceSetKey = this.#workspaceLeaseSetKey(normalizedWorkspaceId);
    const leaseIds = await this.#commands.sMembers(workspaceSetKey);
    const transaction = this.#commands.multi().del(workspaceSetKey);

    if (leaseIds.length > 0) {
      transaction.sRem(this.#registrySetKey(), leaseIds);
      for (const leaseId of leaseIds) {
        transaction.del(this.#leaseKey(leaseId));
      }
    }

    await transaction.exec();
  }

  async listActive(nowMs = Date.now()): Promise<WorkspaceLeaseEntry[]> {
    const leaseIds = await this.#commands.sMembers(this.#registrySetKey());
    if (leaseIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      leaseIds.map(async (leaseId) => ({
        leaseId,
        fields: await this.#commands.hGetAll(this.#leaseKey(leaseId))
      }))
    );

    const activeEntries: WorkspaceLeaseEntry[] = [];
    const missingLeaseIds: string[] = [];
    const emptyWorkspaceSets = new Set<string>();

    for (const record of records) {
      if (Object.keys(record.fields).length === 0) {
        missingLeaseIds.push(record.leaseId);
        const workspaceId = this.#workspaceIdFromLeaseId(record.leaseId);
        if (workspaceId) {
          emptyWorkspaceSets.add(workspaceId);
        }
        continue;
      }

      activeEntries.push(
        deriveRedisWorkspaceLeaseEntry(
          {
            workspaceId: record.fields.workspaceId ?? this.#workspaceIdFromLeaseId(record.leaseId) ?? "unknown",
            version: record.fields.version ?? "live",
            ownerWorkerId: record.fields.ownerWorkerId ?? "unknown",
            ...(record.fields.ownerBaseUrl ? { ownerBaseUrl: record.fields.ownerBaseUrl } : {}),
            sourceKind: record.fields.sourceKind === "local_directory" ? "local_directory" : "object_store",
            localPath: record.fields.localPath ?? "",
            dirty: record.fields.dirty === "1",
            refCount: record.fields.refCount ? Number(record.fields.refCount) : 0,
            lastActivityAt: record.fields.lastActivityAt ?? new Date(0).toISOString(),
            lastSeenAt: record.fields.lastSeenAt ?? new Date(0).toISOString(),
            leaseTtlMs: record.fields.leaseTtlMs ? Number(record.fields.leaseTtlMs) : undefined,
            expiresAt: record.fields.expiresAt,
            ...(record.fields.remotePrefix ? { remotePrefix: record.fields.remotePrefix } : {}),
            ...(record.fields.materializedAt ? { materializedAt: record.fields.materializedAt } : {})
          },
          nowMs
        )
      );
    }

    if (missingLeaseIds.length > 0) {
      const cleanup = this.#commands.multi().sRem(this.#registrySetKey(), missingLeaseIds);
      for (const leaseId of missingLeaseIds) {
        const workspaceId = this.#workspaceIdFromLeaseId(leaseId);
        if (workspaceId) {
          cleanup.sRem(this.#workspaceLeaseSetKey(workspaceId), leaseId);
        }
      }
      await cleanup.exec();
    }

    for (const workspaceId of emptyWorkspaceSets) {
      const members = await this.#commands.sMembers(this.#workspaceLeaseSetKey(workspaceId));
      if (members.length === 0) {
        await this.#commands.del(this.#workspaceLeaseSetKey(workspaceId));
      }
    }

    return activeEntries.sort(
      (left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) ||
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.ownerWorkerId.localeCompare(right.ownerWorkerId)
    );
  }

  async getByWorkspaceId(workspaceId: string, nowMs = Date.now()): Promise<WorkspaceLeaseEntry | undefined> {
    const activeEntries = await this.listActive(nowMs);
    return activeEntries.find((entry) => entry.workspaceId === workspaceId);
  }

  async close(): Promise<void> {
    if (this.#ownsCommands && this.#commands.isOpen) {
      await this.#commands.quit();
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.#commands.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  #registrySetKey(): string {
    return `${this.#keyPrefix}:workspace-leases:registry`;
  }

  #workspaceLeaseSetKey(workspaceId: string): string {
    return `${this.#keyPrefix}:workspace-leases:workspace:${workspaceId}`;
  }

  #leaseKey(leaseId: string): string {
    return `${this.#keyPrefix}:workspace-lease:${leaseId}`;
  }

  #leaseId(workspaceId: string, version: string, ownerWorkerId: string): string {
    return `${workspaceId}:${version}:${ownerWorkerId}`;
  }

  #workspaceIdFromLeaseId(leaseId: string): string | undefined {
    return leaseId.split(":")[0];
  }
}

export async function createRedisWorkspaceLeaseRegistry(
  options: CreateRedisWorkspaceLeaseRegistryOptions
): Promise<RedisWorkspaceLeaseRegistry> {
  const registry = new RedisWorkspaceLeaseRegistry(options);
  await registry.connect();
  return registry;
}
