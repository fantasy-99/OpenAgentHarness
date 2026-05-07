import type { SessionRunQueue, SessionRunQueuePressure, WorkerRegistry } from "@oah/engine-core";

export interface RedisRunWorkerLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface RedisRunWorkerOptions {
  queue: SessionRunQueue;
  runtimeService: {
    processQueuedRun(runId: string): Promise<void>;
    describeQueuedRun?(
      runId: string
    ): Promise<{ workspaceId?: string | undefined; preferredWorkerId?: string | undefined } | undefined>;
    recoverStaleRuns?(options?: {
      staleBefore?: string | undefined;
      limit?: number | undefined;
    }): Promise<{ recoveredRunIds: string[]; requeuedRunIds?: string[] }>;
  };
  workerId?: string | undefined;
  runtimeInstanceId?: string | undefined;
  ownerBaseUrl?: string | undefined;
  processKind?: "embedded" | "standalone" | undefined;
  lockTtlMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
  recoveryGraceMs?: number | undefined;
  registry?: WorkerRegistry | undefined;
  recoverOnStart?: boolean | undefined;
  logger?: RedisRunWorkerLogger | undefined;
  onStateChange?:
    | ((entry: {
        workerId: string;
        state: "starting" | "idle" | "busy" | "stopping";
        currentSessionId?: string | undefined;
        currentRunId?: string | undefined;
        currentWorkspaceId?: string | undefined;
      }) => void)
    | undefined;
}

export interface RedisRunWorkerPoolOptions extends Omit<RedisRunWorkerOptions, "workerId" | "queue"> {
  queue: SessionRunQueue;
  queueFactory?: (() => Promise<SessionRunQueue>) | undefined;
  minWorkers?: number | undefined;
  maxWorkers?: number | undefined;
  scaleIntervalMs?: number | undefined;
  readySessionsPerCapacityUnit?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  scaleUpCooldownMs?: number | undefined;
  scaleDownCooldownMs?: number | undefined;
  scaleUpSampleSize?: number | undefined;
  scaleDownSampleSize?: number | undefined;
  scaleUpBusyRatioThreshold?: number | undefined;
  scaleUpMaxReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolDecision {
  timestamp: string;
  reason: "startup" | "steady" | "scale_up" | "scale_down" | "cooldown_hold" | "shutdown";
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity?: number | undefined;
  reservedWorkers?: number | undefined;
  availableIdleCapacity?: number | undefined;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget?: number | undefined;
  subagentReserveDeficit?: number | undefined;
  desiredWorkers: number;
  activeWorkers: number;
  busyWorkers?: number | undefined;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  preferredReadySessionCount?: number | undefined;
  preferredReadyQueueDepth?: number | undefined;
  preferredSubagentReadySessionCount?: number | undefined;
  preferredSubagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface RedisRunWorkerPoolSlotSnapshot {
  slotId: string;
  workerId: string;
  processKind: "embedded" | "standalone";
  state: "starting" | "idle" | "busy" | "stopping";
  currentSessionId?: string | undefined;
  currentRunId?: string | undefined;
  currentWorkspaceId?: string | undefined;
}

export interface RedisRunWorkerPoolSnapshot {
  running: boolean;
  processKind: "embedded" | "standalone";
  sessionSerialBoundary: "session";
  minWorkers: number;
  maxWorkers: number;
  suggestedWorkers: number;
  globalSuggestedWorkers?: number | undefined;
  reservedSubagentCapacity: number;
  reservedWorkers?: number | undefined;
  availableIdleCapacity: number;
  readySessionsPerActiveWorker?: number | undefined;
  subagentReserveTarget: number;
  subagentReserveDeficit: number;
  desiredWorkers: number;
  slotCapacity: number;
  slots: RedisRunWorkerPoolSlotSnapshot[];
  activeWorkers: number;
  busySlots: number;
  idleSlots: number;
  busyWorkers: number;
  idleWorkers: number;
  globalActiveWorkers?: number | undefined;
  globalBusyWorkers?: number | undefined;
  remoteActiveWorkers?: number | undefined;
  remoteBusyWorkers?: number | undefined;
  readySessionsPerCapacityUnit: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
  readySessionCount?: number | undefined;
  readyQueueDepth?: number | undefined;
  uniqueReadySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  subagentReadyQueueDepth?: number | undefined;
  preferredReadySessionCount?: number | undefined;
  preferredReadyQueueDepth?: number | undefined;
  preferredSubagentReadySessionCount?: number | undefined;
  preferredSubagentReadyQueueDepth?: number | undefined;
  lockedReadySessionCount?: number | undefined;
  staleReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?:
    | "startup"
    | "steady"
    | "scale_up"
    | "scale_down"
    | "cooldown_hold"
    | "shutdown"
    | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  recentDecisions: RedisRunWorkerPoolDecision[];
}

export interface RedisRunWorkerPoolGlobalLoadSummary {
  globalSuggestedWorkers: number;
  globalActiveWorkers: number;
  globalBusyWorkers: number;
  remoteActiveWorkers: number;
  remoteBusyWorkers: number;
}

export type RedisRunWorkerPoolSchedulingPressure = SessionRunQueuePressure | undefined;
