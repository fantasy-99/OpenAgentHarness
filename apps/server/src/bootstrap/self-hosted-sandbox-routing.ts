import { lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  WorkerRegistry,
  WorkerRegistryEntry,
  WorkspacePlacementEntry,
  WorkspacePlacementRegistry,
  WorkspaceRecord
} from "@oah/runtime-core";

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
  workerRegistry: Pick<WorkerRegistry, "listActive">
): Promise<string[]> {
  if (typeof workerRegistry.listActive !== "function") {
    return [];
  }

  const activeWorkers = await workerRegistry.listActive();
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
  tieBreak: number;
}

async function scoreCandidateBaseUrls(options: {
  baseUrl: string;
  ownerId: string;
  placements: WorkspacePlacementEntry[];
  candidateBaseUrls: string[];
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
      const foreignOwners = new Set<string>();
      let workspaceCount = 0;

      for (const placement of options.placements) {
        const placementOwnerId = trimToUndefined(placement.userId);
        const knownEndpoints = placementEndpoints.get(placement.workspaceId);
        if (!knownEndpoints || knownEndpoints.size === 0) {
          continue;
        }

        const matchesCandidate = [...knownEndpoints].some((endpoint) => endpoints.has(endpoint));
        if (!matchesCandidate) {
          continue;
        }

        workspaceCount += 1;
        if (placementOwnerId && placementOwnerId !== options.ownerId) {
          foreignOwners.add(placementOwnerId);
        }
      }

      return {
        baseUrl: candidateBaseUrl,
        foreignOwnerCount: foreignOwners.size,
        workspaceCount,
        tieBreak: stableHash(`${options.ownerId}:${candidateBaseUrl}`)
      } satisfies CandidateScore;
    })
  );
}

function selectBestCandidate(scoredCandidates: CandidateScore[]): CandidateScore | undefined {
  return [...scoredCandidates].sort((left, right) => {
    if (left.foreignOwnerCount !== right.foreignOwnerCount) {
      return left.foreignOwnerCount - right.foreignOwnerCount;
    }
    if (left.workspaceCount !== right.workspaceCount) {
      return left.workspaceCount - right.workspaceCount;
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
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignUser"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
  resolveHostAddresses?: ((hostname: string) => Promise<string[]>) | undefined;
  waitForAvailableReplicaMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  sleepFn?: ((ms: number) => Promise<unknown>) | undefined;
}): Promise<string | undefined> {
  const ownerId = trimToUndefined(options.workspace.ownerId);
  if (!ownerId || !options.workspacePlacementRegistry) {
    return undefined;
  }

  const resolveHostAddresses = options.resolveHostAddresses ?? defaultResolveHostAddresses;
  const placements = (await options.workspacePlacementRegistry.listAll()).filter((placement) => placement.state !== "evicted");

  const existingOwnerPlacement = placements
    .filter((placement) => placement.userId === ownerId && trimToUndefined(placement.ownerBaseUrl))
    .sort(placementPriority)[0];
  if (existingOwnerPlacement?.ownerBaseUrl) {
    return mergeSandboxBaseUrl(options.baseUrl, existingOwnerPlacement.ownerBaseUrl) ?? undefined;
  }

  const workspaceId = trimToUndefined(options.workspace.id);
  if (workspaceId && typeof options.workspacePlacementRegistry.assignUser === "function") {
    await options.workspacePlacementRegistry.assignUser(workspaceId, ownerId, {
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
    const workerRegistryCandidates = options.workerRegistry
      ? await expandCandidateBaseUrlsFromActiveWorkers(options.baseUrl, options.workerRegistry)
      : [];
    const candidateBaseUrls =
      workerRegistryCandidates.length > 0
        ? workerRegistryCandidates
        : await expandCandidateBaseUrls(options.baseUrl, resolveHostAddresses);
    const source = workerRegistryCandidates.length > 0 ? "worker_registry" : "dns";
    const scoredCandidates = await scoreCandidateBaseUrls({
      baseUrl: options.baseUrl,
      ownerId,
      placements,
      candidateBaseUrls,
      resolveHostAddresses
    });
    const selected = selectBestCandidate(scoredCandidates);
    const resolvedBaseUrl =
      selected && (source === "worker_registry" || candidateBaseUrls.length > 1) ? selected.baseUrl : undefined;

    fallbackSelection = {
      baseUrl: resolvedBaseUrl,
      candidateCount: candidateBaseUrls.length,
      source
    };

    if (!shouldWaitForDedicatedCandidate({ workerRegistry: options.workerRegistry, scoredCandidates })) {
      return resolvedBaseUrl;
    }

    if (Date.now() >= waitUntil) {
      return fallbackSelection.baseUrl;
    }

    await sleepFn(pollIntervalMs);
  }
}
