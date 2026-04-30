import { lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  WorkerRegistry,
  WorkerRegistryEntry,
  WorkspacePlacementEntry,
  WorkspacePlacementRegistry,
  WorkspaceRecord
} from "@oah/engine-core";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function normalizeBaseUrl(input: string): URL | undefined {
  try {
    return new URL(input.trim());
  } catch {
    return undefined;
  }
}

function mergeSandboxBaseUrl(templateBaseUrl: string, targetBaseUrl: string): string | undefined {
  const template = normalizeBaseUrl(templateBaseUrl);
  const target = normalizeBaseUrl(targetBaseUrl);
  if (!template || !target) {
    return undefined;
  }

  return `${target.origin}${template.pathname}${template.search}`;
}

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  } catch {
    return [];
  }
}

async function resolveBaseUrlEndpoints(
  baseUrl: string,
  resolveHostAddresses: (hostname: string) => Promise<string[]>
): Promise<Set<string>> {
  const parsed = normalizeBaseUrl(baseUrl);
  if (!parsed) {
    return new Set();
  }

  const port = parsed.port || defaultPortForProtocol(parsed.protocol);
  const addresses = await resolveHostAddresses(parsed.hostname);
  const endpoints = new Set<string>([`${parsed.hostname}:${port}`]);
  for (const address of addresses) {
    endpoints.add(`${address}:${port}`);
  }
  return endpoints;
}

async function expandCandidateBaseUrls(
  baseUrl: string,
  resolveHostAddresses: (hostname: string) => Promise<string[]>
): Promise<string[]> {
  const parsed = normalizeBaseUrl(baseUrl);
  if (!parsed) {
    return [baseUrl];
  }

  const addresses = await resolveHostAddresses(parsed.hostname);
  if (addresses.length === 0) {
    return [baseUrl];
  }

  const candidates = new Set<string>();
  for (const address of addresses) {
    const candidate = new URL(parsed.toString());
    candidate.hostname = address;
    candidates.add(candidate.toString().replace(/\/+$/u, ""));
  }

  return [...candidates];
}

async function expandCandidateBaseUrlsFromActiveWorkers(
  baseUrl: string,
  activeWorkers: WorkerRegistryEntry[]
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const worker of activeWorkers) {
    if (worker.processKind !== "standalone" || worker.health !== "healthy") {
      continue;
    }

    const candidateBaseUrl = mergeSandboxBaseUrl(baseUrl, worker.ownerBaseUrl ?? "");
    if (candidateBaseUrl) {
      candidates.add(candidateBaseUrl.replace(/\/+$/u, ""));
    }
  }

  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function placementPriority(left: WorkspacePlacementEntry, right: WorkspacePlacementEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function stableHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

interface CandidateScore {
  baseUrl: string;
  foreignOwnerCount: number;
  workspaceCount: number;
  resourcePressure: number;
  resourcePressureExceeded: boolean;
  ownerlessReuseRank: number;
  tieBreak: number;
}

function placementOwnerId(placement: Pick<WorkspacePlacementEntry, "ownerId">): string | undefined {
  return trimToUndefined(placement.ownerId);
}

function placementLoad(placement: Pick<WorkspacePlacementEntry, "refCount" | "state">): number {
  if (placement.state === "evicted" || placement.state === "unassigned") {
    return 0;
  }

  if (typeof placement.refCount === "number") {
    return Math.max(0, placement.refCount);
  }

  return 1;
}

async function mapPinnedOwnerCandidates(options: {
  baseUrl: string;
  placements: WorkspacePlacementEntry[];
  candidateBaseUrls: string[];
  resolveHostAddresses: (hostname: string) => Promise<string[]>;
}): Promise<Map<string, string>> {
  const candidateEndpoints = new Map<string, Set<string>>(
    await Promise.all(
      options.candidateBaseUrls.map(
        async (candidateBaseUrl): Promise<readonly [string, Set<string>]> => [
          candidateBaseUrl,
          await resolveBaseUrlEndpoints(candidateBaseUrl, options.resolveHostAddresses)
        ]
      )
    )
  );
  const pinnedOwners = new Map<string, string>();

  for (const placement of [...options.placements].sort(placementPriority)) {
    const ownerId = placementOwnerId(placement);
    const ownerBaseUrl = trimToUndefined(placement.ownerBaseUrl);
    if (!ownerId || !ownerBaseUrl || pinnedOwners.has(ownerId)) {
      continue;
    }

    const placementEndpoints = await resolveBaseUrlEndpoints(
      mergeSandboxBaseUrl(options.baseUrl, ownerBaseUrl) ?? ownerBaseUrl,
      options.resolveHostAddresses
    );
    const matchedCandidate = options.candidateBaseUrls.find((candidateBaseUrl) => {
      const endpoints = candidateEndpoints.get(candidateBaseUrl);
      return endpoints ? [...placementEndpoints].some((endpoint) => endpoints.has(endpoint)) : false;
    });
    if (matchedCandidate) {
      pinnedOwners.set(ownerId, matchedCandidate);
    }
  }

  return pinnedOwners;
}

function listTrackedOwnerIds(placements: WorkspacePlacementEntry[]): string[] {
  return [...new Set(placements.map((placement) => placementOwnerId(placement)).filter((ownerId): ownerId is string => Boolean(ownerId)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function assignPendingOwnerCandidate(input: {
  ownerId: string;
  trackedOwnerIds: string[];
  pinnedOwners: Map<string, string>;
  candidateBaseUrls: string[];
}): { baseUrl: string | undefined; waitForReplica: boolean } {
  const pendingOwnerIds = input.trackedOwnerIds.filter((trackedOwnerId) => !input.pinnedOwners.has(trackedOwnerId));
  if (!pendingOwnerIds.includes(input.ownerId)) {
    return {
      baseUrl: input.pinnedOwners.get(input.ownerId),
      waitForReplica: false
    };
  }

  const pinnedCandidateBaseUrls = new Set(input.pinnedOwners.values());
  const availableCandidates = [...input.candidateBaseUrls]
    .filter((candidateBaseUrl) => !pinnedCandidateBaseUrls.has(candidateBaseUrl))
    .sort((left, right) => left.localeCompare(right));
  if (availableCandidates.length < pendingOwnerIds.length) {
    return {
      baseUrl: undefined,
      waitForReplica: true
    };
  }

  return {
    baseUrl: availableCandidates[pendingOwnerIds.indexOf(input.ownerId)],
    waitForReplica: false
  };
}

async function scoreCandidateBaseUrls(options: {
  baseUrl: string;
  ownerId?: string | undefined;
  placements: WorkspacePlacementEntry[];
  candidateBaseUrls: string[];
  maxWorkspacesPerSandbox?: number | undefined;
  activeWorkers?: WorkerRegistryEntry[] | undefined;
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
  resolveHostAddresses: (hostname: string) => Promise<string[]>;
}): Promise<CandidateScore[]> {
  const placementEndpoints = new Map<string, Set<string>>();
  for (const placement of options.placements) {
    const placementBaseUrl = trimToUndefined(placement.ownerBaseUrl);
    if (!placementBaseUrl) {
      continue;
    }
    placementEndpoints.set(
      placement.workspaceId,
      await resolveBaseUrlEndpoints(
        mergeSandboxBaseUrl(options.baseUrl, placementBaseUrl) ?? placementBaseUrl,
        options.resolveHostAddresses
      )
    );
  }

  return Promise.all(
    options.candidateBaseUrls.map(async (candidateBaseUrl) => {
      const endpoints = await resolveBaseUrlEndpoints(candidateBaseUrl, options.resolveHostAddresses);
      const resourcePressures = (options.activeWorkers ?? [])
        .filter((worker) => {
          const workerBaseUrl = mergeSandboxBaseUrl(options.baseUrl, worker.ownerBaseUrl ?? "");
          return workerBaseUrl ? workerBaseUrl.replace(/\/+$/u, "") === candidateBaseUrl.replace(/\/+$/u, "") : false;
        })
        .map((worker) => {
          const cpuThreshold = Math.max(0.01, options.resourceCpuPressureThreshold ?? 0.8);
          const memoryThreshold = Math.max(0.01, options.resourceMemoryPressureThreshold ?? 0.8);
          const diskThreshold = Math.max(0.01, options.resourceDiskPressureThreshold ?? 0.85);
          const cpuPressure =
            typeof worker.resourceCpuLoadRatio === "number" && Number.isFinite(worker.resourceCpuLoadRatio)
              ? worker.resourceCpuLoadRatio / cpuThreshold
              : undefined;
          const memoryPressure =
            typeof worker.resourceMemoryUsedRatio === "number" && Number.isFinite(worker.resourceMemoryUsedRatio)
              ? worker.resourceMemoryUsedRatio / memoryThreshold
              : undefined;
          const diskPressure =
            typeof worker.resourceDiskUsedRatio === "number" && Number.isFinite(worker.resourceDiskUsedRatio)
              ? worker.resourceDiskUsedRatio / diskThreshold
              : undefined;
          return Math.max(cpuPressure ?? 0, memoryPressure ?? 0, diskPressure ?? 0);
        });
      const resourcePressure = resourcePressures.length > 0 ? Math.max(...resourcePressures) : 0;
      const foreignOwners = new Set<string>();
      let workspaceCount = 0;

      for (const placement of options.placements) {
        const affinityOwnerId = placementOwnerId(placement);
        const knownEndpoints = placementEndpoints.get(placement.workspaceId);
        if (!knownEndpoints || knownEndpoints.size === 0) {
          continue;
        }

        const matchesCandidate = [...knownEndpoints].some((endpoint) => endpoints.has(endpoint));
        if (!matchesCandidate) {
          continue;
        }

        workspaceCount += placementLoad(placement);
        if (options.ownerId && affinityOwnerId && affinityOwnerId !== options.ownerId) {
          foreignOwners.add(affinityOwnerId);
        }
      }

      return {
        baseUrl: candidateBaseUrl,
        foreignOwnerCount: foreignOwners.size,
        workspaceCount,
        resourcePressure,
        resourcePressureExceeded: resourcePressure > 1,
        ownerlessReuseRank: options.ownerId
          ? 0
          : workspaceCount > 0 && workspaceCount < Math.max(1, options.maxWorkspacesPerSandbox ?? 32) && resourcePressure <= 1
            ? 2
            : workspaceCount === 0
              ? 1
              : 0,
        tieBreak: stableHash(`${options.ownerId}:${candidateBaseUrl}`)
      } satisfies CandidateScore;
    })
  );
}

function selectBestCandidate(scoredCandidates: CandidateScore[]): CandidateScore | undefined {
  return [...scoredCandidates].sort((left, right) => {
    if (left.ownerlessReuseRank !== right.ownerlessReuseRank) {
      return right.ownerlessReuseRank - left.ownerlessReuseRank;
    }
    if (left.foreignOwnerCount !== right.foreignOwnerCount) {
      return left.foreignOwnerCount - right.foreignOwnerCount;
    }
    if (left.workspaceCount !== right.workspaceCount) {
      return left.workspaceCount - right.workspaceCount;
    }
    if (left.resourcePressure !== right.resourcePressure) {
      return left.resourcePressure - right.resourcePressure;
    }
    if (left.tieBreak !== right.tieBreak) {
      return left.tieBreak - right.tieBreak;
    }
    return left.baseUrl.localeCompare(right.baseUrl);
  })[0];
}

function shouldWaitForDedicatedCandidate(input: {
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
  scoredCandidates: CandidateScore[];
}): boolean {
  if (!input.workerRegistry || typeof input.workerRegistry.listActive !== "function") {
    return false;
  }

  if (input.scoredCandidates.length === 0) {
    return true;
  }

  return input.scoredCandidates.every((candidate) => candidate.foreignOwnerCount > 0);
}

export async function resolveSelfHostedSandboxCreateBaseUrl(options: {
  baseUrl: string;
  workspace: Pick<WorkspaceRecord, "ownerId"> & { id?: string | undefined };
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
  resolveHostAddresses?: ((hostname: string) => Promise<string[]>) | undefined;
  waitForAvailableReplicaMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  sleepFn?: ((ms: number) => Promise<unknown>) | undefined;
}): Promise<string | undefined> {
  const ownerId = trimToUndefined(options.workspace.ownerId);
  if (!options.workspacePlacementRegistry) {
    return undefined;
  }

  const resolveHostAddresses = options.resolveHostAddresses ?? defaultResolveHostAddresses;
  const workspaceId = trimToUndefined(options.workspace.id);
  if (ownerId && workspaceId) {
    await options.workspacePlacementRegistry.assignOwnerAffinity(workspaceId, ownerId, {
      overwrite: false,
      updatedAt: new Date().toISOString()
    });
  }

  const waitForAvailableReplicaMs =
    typeof options.workerRegistry?.listActive === "function" ? Math.max(0, options.waitForAvailableReplicaMs ?? 30_000) : 0;
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
  const waitUntil = Date.now() + waitForAvailableReplicaMs;
  const sleepFn = options.sleepFn ?? sleep;
  let fallbackSelection:
    | {
        baseUrl: string | undefined;
        candidateCount: number;
        source: "worker_registry" | "dns";
      }
    | undefined;

  while (true) {
    const activeWorkers = options.workerRegistry && typeof options.workerRegistry.listActive === "function"
      ? await options.workerRegistry.listActive()
      : [];
    const workerRegistryCandidates = options.workerRegistry
      ? await expandCandidateBaseUrlsFromActiveWorkers(options.baseUrl, activeWorkers)
      : [];
    const candidateBaseUrls =
      workerRegistryCandidates.length > 0
        ? workerRegistryCandidates
        : await expandCandidateBaseUrls(options.baseUrl, resolveHostAddresses);
    const source = workerRegistryCandidates.length > 0 ? "worker_registry" : "dns";
    const placements = (await options.workspacePlacementRegistry.listAll()).filter((placement) => placement.state !== "evicted");
    const existingOwnerPlacement = ownerId
      ? placements
          .filter((placement) => placementOwnerId(placement) === ownerId && trimToUndefined(placement.ownerBaseUrl))
          .sort(placementPriority)[0]
      : undefined;
    if (existingOwnerPlacement?.ownerBaseUrl) {
      return mergeSandboxBaseUrl(options.baseUrl, existingOwnerPlacement.ownerBaseUrl) ?? undefined;
    }

    const scoredCandidates = await scoreCandidateBaseUrls({
      baseUrl: options.baseUrl,
      ...(ownerId ? { ownerId } : {}),
      placements,
      candidateBaseUrls,
      maxWorkspacesPerSandbox: options.maxWorkspacesPerSandbox,
      activeWorkers,
      resourceCpuPressureThreshold: options.resourceCpuPressureThreshold,
      resourceMemoryPressureThreshold: options.resourceMemoryPressureThreshold,
      resourceDiskPressureThreshold: options.resourceDiskPressureThreshold,
      resolveHostAddresses
    });
    const pinnedOwners = await mapPinnedOwnerCandidates({
      baseUrl: options.baseUrl,
      placements,
      candidateBaseUrls,
      resolveHostAddresses
    });
    const pendingOwnerSelection = ownerId
      ? assignPendingOwnerCandidate({
          ownerId,
          trackedOwnerIds: listTrackedOwnerIds(placements),
          pinnedOwners,
          candidateBaseUrls
        })
      : {
          baseUrl: undefined,
          waitForReplica: false
        };
    const assignedPendingBaseUrl =
      pendingOwnerSelection.baseUrl &&
      (source === "worker_registry" || candidateBaseUrls.length > 1)
        ? pendingOwnerSelection.baseUrl
        : undefined;
    const selected = selectBestCandidate(scoredCandidates);
    const resolvedBaseUrl =
      selected && (source === "worker_registry" || candidateBaseUrls.length > 1) ? selected.baseUrl : undefined;

    fallbackSelection = {
      baseUrl: resolvedBaseUrl,
      candidateCount: candidateBaseUrls.length,
      source
    };

    if (assignedPendingBaseUrl) {
      return assignedPendingBaseUrl;
    }

    if (pendingOwnerSelection.waitForReplica) {
      if (Date.now() >= waitUntil) {
        return fallbackSelection.baseUrl;
      }

      await sleepFn(pollIntervalMs);
      continue;
    }

    if (!shouldWaitForDedicatedCandidate({ workerRegistry: options.workerRegistry, scoredCandidates })) {
      return resolvedBaseUrl;
    }

    if (Date.now() >= waitUntil) {
      return fallbackSelection.baseUrl;
    }

    await sleepFn(pollIntervalMs);
  }
}
