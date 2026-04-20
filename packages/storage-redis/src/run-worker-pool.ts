import type { SessionRunQueuePressure } from "@oah/engine-core";
import { createId } from "@oah/engine-core";
import { RedisRunWorker } from "./run-worker.js";
import {
  calculateRedisWorkerPoolSuggestion,
  summarizeRedisWorkerLoad
} from "./worker-pool-policy.js";
import { summarizeRedisRunWorkerPoolPressure } from "./worker-pool-pressure.js";
import {
  appendRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolDecision,
  buildRedisRunWorkerPoolSnapshot,
  formatRedisRunWorkerPoolRebalanceLog,
  shouldLogRedisRunWorkerPoolRebalance
} from "./worker-pool-observability.js";
import type {
  RedisRunWorkerPoolDecision,
  RedisRunWorkerPoolGlobalLoadSummary,
  RedisRunWorkerPoolOptions,
  RedisRunWorkerPoolSchedulingPressure,
  RedisRunWorkerPoolSlotSnapshot,
  RedisRunWorkerPoolSnapshot,
  RedisRunWorkerOptions
} from "./worker-types.js";

export class RedisRunWorkerPool {
  readonly #queue: RedisRunWorkerPoolOptions["queue"];
  readonly #queueFactory?: RedisRunWorkerPoolOptions["queueFactory"];
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #runtimeInstanceId?: string | undefined;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #registry?: RedisRunWorkerPoolOptions["registry"];
  readonly #logger?: RedisRunWorkerPoolOptions["logger"];
  readonly #minWorkers: number;
  readonly #maxWorkers: number;
  readonly #scaleIntervalMs: number;
  readonly #readySessionsPerCapacityUnit: number;
  readonly #reservedSubagentCapacity: number;
  readonly #scaleUpCooldownMs: number;
  readonly #scaleDownCooldownMs: number;
  readonly #scaleUpSampleSize: number;
  readonly #scaleDownSampleSize: number;
  readonly #scaleUpBusyRatioThreshold: number;
  readonly #scaleUpMaxReadyAgeMs: number;
  readonly #workers: Array<{
    workerId: string;
    worker: RedisRunWorker;
    queue: RedisRunWorkerPoolOptions["queue"];
    ownsQueue: boolean;
  }> = [];
  readonly #workerSlots = new Map<string, RedisRunWorkerPoolSlotSnapshot>();
  #active = false;
  #scaleTimer: NodeJS.Timeout | undefined;
  #rebalancePromise: Promise<void> | undefined;
  #lastLoggedState:
    | {
        desiredWorkers: number;
        activeWorkers: number;
      }
    | undefined;
  #lastReadySessionCount: number | undefined;
  #lastReadyQueueDepth: number | undefined;
  #lastUniqueReadySessionCount: number | undefined;
  #lastSubagentReadySessionCount: number | undefined;
  #lastSubagentReadyQueueDepth: number | undefined;
  #lastLockedReadySessionCount: number | undefined;
  #lastStaleReadySessionCount: number | undefined;
  #lastOldestSchedulableReadyAgeMs: number | undefined;
  #lastReservedWorkers: number | undefined;
  #lastGlobalSuggestedWorkers: number | undefined;
  #lastGlobalActiveWorkers: number | undefined;
  #lastGlobalBusyWorkers: number | undefined;
  #lastRemoteActiveWorkers: number | undefined;
  #lastRemoteBusyWorkers: number | undefined;
  #lastRebalanceAtMs: number | undefined;
  #lastRebalanceReason: RedisRunWorkerPoolSnapshot["lastRebalanceReason"];
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #suggestedWorkers = 0;
  #desiredWorkers = 0;
  #recentDecisions: RedisRunWorkerPoolDecision[] = [];

  constructor(options: RedisRunWorkerPoolOptions) {
    this.#queue = options.queue;
    this.#queueFactory = options.queueFactory;
    this.#runtimeService = options.runtimeService;
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#minWorkers = Math.max(1, Math.floor(options.minWorkers ?? 1));
    this.#maxWorkers = Math.max(this.#minWorkers, Math.floor(options.maxWorkers ?? this.#minWorkers));
    this.#scaleIntervalMs = Math.max(1_000, Math.floor(options.scaleIntervalMs ?? 5_000));
    this.#readySessionsPerCapacityUnit = Math.max(1, Math.floor(options.readySessionsPerCapacityUnit ?? 1));
    this.#reservedSubagentCapacity = Math.max(0, Math.floor(options.reservedSubagentCapacity ?? 1));
    this.#scaleUpCooldownMs = Math.max(0, Math.floor(options.scaleUpCooldownMs ?? 1_000));
    this.#scaleDownCooldownMs = Math.max(0, Math.floor(options.scaleDownCooldownMs ?? 15_000));
    this.#scaleUpSampleSize = Math.max(1, Math.floor(options.scaleUpSampleSize ?? 2));
    this.#scaleDownSampleSize = Math.max(1, Math.floor(options.scaleDownSampleSize ?? 3));
    this.#scaleUpBusyRatioThreshold = Math.min(1, Math.max(0, options.scaleUpBusyRatioThreshold ?? 0.75));
    this.#scaleUpMaxReadyAgeMs = Math.max(0, Math.floor(options.scaleUpMaxReadyAgeMs ?? 2_000));
  }

  start(): void {
    if (this.#active) {
      return;
    }

    this.#active = true;
    void this.#scheduleRebalance("startup");
    this.#scaleTimer = setInterval(() => {
      void this.#scheduleRebalance("interval");
    }, this.#scaleIntervalMs);
    this.#scaleTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#active = false;
    if (this.#scaleTimer) {
      clearInterval(this.#scaleTimer);
      this.#scaleTimer = undefined;
    }

    await this.#rebalancePromise;

    const workers = this.#workers.splice(0, this.#workers.length).reverse();
    await Promise.all(
      workers.map(async ({ worker, queue, ownsQueue }) => {
        await worker.close();
        if (ownsQueue) {
          await queue.close();
        }
      })
    );
    this.#workerSlots.clear();

    this.#desiredWorkers = 0;
    this.#lastRebalanceAtMs = Date.now();
    this.#lastRebalanceReason = "shutdown";
    this.#recordDecision("shutdown");
    this.#logRebalanceIfChanged(0, "shutdown");
  }

  snapshot(nowMs = Date.now()): RedisRunWorkerPoolSnapshot {
    const scaleDownCooldownReferenceMs = this.#lastCapacityChangeAtMs();
    const schedulingPressure = this.#lastSchedulingPressure();
    const busyWorkers = this.#busyWorkerCount();
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers: this.#workers.length,
      busyWorkers,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure
    });
    return buildRedisRunWorkerPoolSnapshot({
      running: this.#active,
      processKind: this.#processKind,
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
      availableIdleCapacity: pressureSummary.availableIdleCapacity,
      ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
        ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
        : {}),
      subagentReserveTarget: pressureSummary.subagentReserveTarget,
      subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
      desiredWorkers: this.#desiredWorkers,
      slots: this.#slotSnapshots(),
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      readySessionsPerCapacityUnit: this.#readySessionsPerCapacityUnit,
      scaleIntervalMs: this.#scaleIntervalMs,
      scaleUpCooldownMs: this.#scaleUpCooldownMs,
      scaleDownCooldownMs: this.#scaleDownCooldownMs,
      scaleUpSampleSize: this.#scaleUpSampleSize,
      scaleDownSampleSize: this.#scaleDownSampleSize,
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {}),
      ...(this.#lastRebalanceAtMs ? { lastRebalanceAt: new Date(this.#lastRebalanceAtMs).toISOString() } : {}),
      ...(this.#lastRebalanceReason ? { lastRebalanceReason: this.#lastRebalanceReason } : {}),
      scaleUpPressureStreak: this.#scaleUpPressureStreak,
      scaleDownPressureStreak: this.#scaleDownPressureStreak,
      scaleUpCooldownRemainingMs: this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs),
      scaleDownCooldownRemainingMs: this.#cooldownRemainingMs(scaleDownCooldownReferenceMs, this.#scaleDownCooldownMs, nowMs),
      recentDecisions: [...this.#recentDecisions]
    });
  }

  async #scheduleRebalance(reason: "startup" | "interval"): Promise<void> {
    if (this.#rebalancePromise) {
      return this.#rebalancePromise;
    }

    const task = this.#rebalance(reason).finally(() => {
      if (this.#rebalancePromise === task) {
        this.#rebalancePromise = undefined;
      }
    });
    this.#rebalancePromise = task;
    return task;
  }

  async #rebalance(reason: "startup" | "interval"): Promise<void> {
    const schedulingPressure = await this.#readSchedulingPressure();
    const readySessionCount = schedulingPressure?.readySessionCount;
    const globalWorkerLoad = await this.#readGlobalWorkerLoad();
    const currentWorkers = this.#workers.length;
    this.#lastReservedWorkers = undefined;
    const suggestedWorkers = this.#rawDesiredWorkerCount(schedulingPressure, globalWorkerLoad);
    this.#suggestedWorkers = suggestedWorkers;
    const desiredWorkers = this.#desiredWorkerCount(suggestedWorkers, currentWorkers, reason);
    this.#desiredWorkers = desiredWorkers;
    this.#lastReadySessionCount = readySessionCount;
    this.#lastReadyQueueDepth = schedulingPressure?.readyQueueDepth;
    this.#lastUniqueReadySessionCount = schedulingPressure?.uniqueReadySessionCount;
    this.#lastSubagentReadySessionCount = schedulingPressure?.subagentReadySessionCount;
    this.#lastSubagentReadyQueueDepth = schedulingPressure?.subagentReadyQueueDepth;
    this.#lastLockedReadySessionCount = schedulingPressure?.lockedReadySessionCount;
    this.#lastStaleReadySessionCount = schedulingPressure?.staleReadySessionCount;
    this.#lastOldestSchedulableReadyAgeMs = schedulingPressure?.oldestSchedulableReadyAgeMs;
    this.#lastGlobalSuggestedWorkers = globalWorkerLoad?.globalSuggestedWorkers;
    this.#lastGlobalActiveWorkers = globalWorkerLoad?.globalActiveWorkers;
    this.#lastGlobalBusyWorkers = globalWorkerLoad?.globalBusyWorkers;
    this.#lastRemoteActiveWorkers = globalWorkerLoad?.remoteActiveWorkers;
    this.#lastRemoteBusyWorkers = globalWorkerLoad?.remoteBusyWorkers;

    while (this.#active && this.#workers.length < desiredWorkers) {
      const queue = this.#queueFactory ? await this.#queueFactory() : this.#queue;
      const ownsQueue = Boolean(this.#queueFactory);
      const workerId = createId("worker");
      const worker = new RedisRunWorker({
        workerId,
        ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {}),
        ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
        queue,
        runtimeService: this.#runtimeService,
        processKind: this.#processKind,
        lockTtlMs: this.#lockTtlMs,
        pollTimeoutMs: this.#pollTimeoutMs,
        recoveryGraceMs: this.#recoveryGraceMs,
        registry: this.#registry,
        recoverOnStart: this.#workers.length === 0,
        logger: this.#logger,
        onStateChange: ({ workerId: stateWorkerId, state, currentSessionId, currentRunId, currentWorkspaceId }) => {
          this.#workerSlots.set(stateWorkerId, {
            slotId: stateWorkerId,
            workerId: stateWorkerId,
            processKind: this.#processKind,
            state,
            ...(currentSessionId ? { currentSessionId } : {}),
            ...(currentRunId ? { currentRunId } : {}),
            ...(currentWorkspaceId ? { currentWorkspaceId } : {})
          });
        }
      });
      this.#workers.push({
        workerId,
        worker,
        queue,
        ownsQueue
      });
      worker.start();
    }

    let scaledDown = false;
    while (this.#workers.length > desiredWorkers) {
      const removed = this.#workers.pop();
      if (!removed) {
        break;
      }

      await removed.worker.close();
      if (removed.ownsQueue) {
        await removed.queue.close();
      }
      this.#workerSlots.delete(removed.workerId);
      scaledDown = true;
    }

    const activeWorkers = this.#workers.length;
    const rebalanceReason =
      reason === "startup"
        ? "startup"
        : activeWorkers > currentWorkers
          ? "scale_up"
          : scaledDown
            ? "scale_down"
            : desiredWorkers !== suggestedWorkers
              ? "cooldown_hold"
              : "steady";
    const nowMs = Date.now();
    if (activeWorkers > currentWorkers) {
      this.#lastScaleUpAtMs = nowMs;
    }
    if (scaledDown) {
      this.#lastScaleDownAtMs = nowMs;
    }
    this.#lastRebalanceAtMs = nowMs;
    this.#lastRebalanceReason = rebalanceReason;
    if (globalWorkerLoad) {
      this.#lastGlobalActiveWorkers = globalWorkerLoad.remoteActiveWorkers + activeWorkers;
      this.#lastGlobalBusyWorkers = globalWorkerLoad.remoteBusyWorkers + this.#busyWorkerCount();
    }
    this.#recordDecision(rebalanceReason);
    this.#logRebalanceIfChanged(desiredWorkers, rebalanceReason, schedulingPressure);
  }

  async #readSchedulingPressure(): Promise<RedisRunWorkerPoolSchedulingPressure> {
    if (typeof this.#queue.getSchedulingPressure === "function") {
      try {
        return await this.#queue.getSchedulingPressure();
      } catch (error) {
        this.#logger?.warn("Failed to read Redis scheduling pressure for worker pool rebalance.", error);
      }
    }

    if (typeof this.#queue.getReadySessionCount !== "function") {
      return undefined;
    }

    try {
      return {
        readySessionCount: await this.#queue.getReadySessionCount()
      };
    } catch (error) {
      this.#logger?.warn("Failed to read Redis ready-session depth for worker pool rebalance.", error);
      return undefined;
    }
  }

  async #readGlobalWorkerLoad(): Promise<RedisRunWorkerPoolGlobalLoadSummary | undefined> {
    if (typeof this.#registry?.listActive !== "function") {
      return undefined;
    }

    try {
      const activeWorkers = await this.#registry.listActive(Date.now());
      return summarizeRedisWorkerLoad({
        activeWorkers,
        localWorkerIds: this.#workers.map((entry) => entry.workerId),
        localActiveWorkers: this.#workers.length,
        localBusyWorkers: this.#busyWorkerCount()
      });
    } catch (error) {
      this.#logger?.warn("Failed to read global Redis worker load for worker pool rebalance.", error);
      return undefined;
    }
  }

  #desiredWorkerCount(suggestedWorkers: number, currentWorkers: number, reason: "startup" | "interval"): number {
    if (!this.#queueFactory) {
      return 1;
    }

    if (suggestedWorkers > currentWorkers) {
      this.#scaleUpPressureStreak += 1;
    } else {
      this.#scaleUpPressureStreak = 0;
    }
    if (suggestedWorkers < currentWorkers) {
      this.#scaleDownPressureStreak += 1;
    } else {
      this.#scaleDownPressureStreak = 0;
    }

    const targetWorkers =
      suggestedWorkers > currentWorkers
        ? this.#scaleUpPressureStreak >= this.#scaleUpSampleSize
          ? suggestedWorkers
          : currentWorkers
        : suggestedWorkers < currentWorkers
          ? this.#scaleDownPressureStreak >= this.#scaleDownSampleSize
            ? suggestedWorkers
            : currentWorkers
          : suggestedWorkers;
    if (reason === "startup") {
      return suggestedWorkers;
    }

    const nowMs = Date.now();
    if (targetWorkers > currentWorkers && this.#cooldownRemainingMs(this.#lastScaleUpAtMs, this.#scaleUpCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }
    if (targetWorkers < currentWorkers && this.#cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#scaleDownCooldownMs, nowMs) > 0) {
      return currentWorkers;
    }

    return targetWorkers;
  }

  #rawDesiredWorkerCount(
    schedulingPressure: RedisRunWorkerPoolSchedulingPressure,
    globalWorkerLoad?: RedisRunWorkerPoolGlobalLoadSummary
  ): number {
    const sizing = calculateRedisWorkerPoolSuggestion({
      minWorkers: this.#minWorkers,
      maxWorkers: this.#maxWorkers,
      readySessionsPerCapacityUnit: this.#readySessionsPerCapacityUnit,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      localActiveWorkers: this.#workers.length,
      localBusyWorkers: this.#busyWorkerCount(),
      scaleUpBusyRatioThreshold: this.#scaleUpBusyRatioThreshold,
      scaleUpMaxReadyAgeMs: this.#scaleUpMaxReadyAgeMs,
      schedulingPressure,
      globalWorkerLoad
    });
    if (globalWorkerLoad) {
      globalWorkerLoad.globalSuggestedWorkers = sizing.globalSuggestedWorkers;
    }
    this.#lastReservedWorkers = sizing.reservedWorkers;

    return sizing.localSuggestedWorkers;
  }

  #cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
    if (!lastChangeAtMs || cooldownMs <= 0) {
      return 0;
    }

    return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #recordDecision(reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>): void {
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers: this.#workers.length,
      busyWorkers: this.#busyWorkerCount(),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure: this.#lastSchedulingPressure()
    });
    const decision = buildRedisRunWorkerPoolDecision({
      timestamp: new Date(this.#lastRebalanceAtMs ?? Date.now()).toISOString(),
      reason,
      suggestedWorkers: this.#suggestedWorkers,
      ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
      availableIdleCapacity: pressureSummary.availableIdleCapacity,
      ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
        ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
        : {}),
      subagentReserveTarget: pressureSummary.subagentReserveTarget,
      subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
      desiredWorkers: this.#desiredWorkers,
      activeWorkers: this.#workers.length,
      busyWorkers: this.#busyWorkerCount(),
      ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
      ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
      ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
      ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : {}),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {})
    });
    this.#recentDecisions = appendRedisRunWorkerPoolDecision(this.#recentDecisions, decision);
  }

  #logRebalanceIfChanged(
    desiredWorkers: number,
    reason: NonNullable<RedisRunWorkerPoolSnapshot["lastRebalanceReason"]>,
    schedulingPressure?: SessionRunQueuePressure
  ): void {
    const activeWorkers = this.#workers.length;
    const busyWorkers = this.#busyWorkerCount();
    const pressureSummary = summarizeRedisRunWorkerPoolPressure({
      activeWorkers,
      busyWorkers,
      reservedSubagentCapacity: this.#reservedSubagentCapacity,
      schedulingPressure
    });
    if (
      !shouldLogRedisRunWorkerPoolRebalance(this.#lastLoggedState, {
        desiredWorkers,
        activeWorkers,
        reason
      })
    ) {
      return;
    }

    this.#lastLoggedState = {
      desiredWorkers,
      activeWorkers
    };
    this.#logger?.info?.(
      formatRedisRunWorkerPoolRebalanceLog({
        reason,
        activeWorkers,
        desiredWorkers,
        suggestedWorkers: this.#suggestedWorkers,
        ...(typeof this.#lastGlobalSuggestedWorkers === "number" ? { globalSuggestedWorkers: this.#lastGlobalSuggestedWorkers } : {}),
        reservedSubagentCapacity: this.#reservedSubagentCapacity,
        ...(typeof this.#lastReservedWorkers === "number" ? { reservedWorkers: this.#lastReservedWorkers } : {}),
        availableIdleCapacity: pressureSummary.availableIdleCapacity,
        ...(typeof pressureSummary.readySessionsPerActiveWorker === "number"
          ? { readySessionsPerActiveWorker: pressureSummary.readySessionsPerActiveWorker }
          : {}),
        subagentReserveTarget: pressureSummary.subagentReserveTarget,
        subagentReserveDeficit: pressureSummary.subagentReserveDeficit,
        ...(typeof this.#lastGlobalActiveWorkers === "number" ? { globalActiveWorkers: this.#lastGlobalActiveWorkers } : {}),
        ...(typeof this.#lastGlobalBusyWorkers === "number" ? { globalBusyWorkers: this.#lastGlobalBusyWorkers } : {}),
        ...(typeof this.#lastRemoteActiveWorkers === "number" ? { remoteActiveWorkers: this.#lastRemoteActiveWorkers } : {}),
        ...(typeof this.#lastRemoteBusyWorkers === "number" ? { remoteBusyWorkers: this.#lastRemoteBusyWorkers } : {}),
        busyWorkers,
        minWorkers: this.#minWorkers,
        maxWorkers: this.#maxWorkers,
        scaleUpPressureStreak: this.#scaleUpPressureStreak,
        scaleUpSampleSize: this.#scaleUpSampleSize,
        scaleDownPressureStreak: this.#scaleDownPressureStreak,
        scaleDownSampleSize: this.#scaleDownSampleSize,
        schedulingPressure
      })
    );
  }

  #busyWorkerCount(): number {
    return this.#slotSnapshots().filter((slot) => slot.state === "busy").length;
  }

  #slotSnapshots(): RedisRunWorkerPoolSlotSnapshot[] {
    return [...this.#workerSlots.values()].sort((left, right) => left.slotId.localeCompare(right.slotId));
  }

  #lastSchedulingPressure(): SessionRunQueuePressure | undefined {
    const hasAnySignal = [
      this.#lastReadySessionCount,
      this.#lastReadyQueueDepth,
      this.#lastUniqueReadySessionCount,
      this.#lastSubagentReadySessionCount,
      this.#lastSubagentReadyQueueDepth,
      this.#lastLockedReadySessionCount,
      this.#lastStaleReadySessionCount,
      this.#lastOldestSchedulableReadyAgeMs
    ].some((value) => typeof value === "number");

    if (!hasAnySignal) {
      return undefined;
    }

    return {
      ...(typeof this.#lastReadySessionCount === "number" ? { readySessionCount: this.#lastReadySessionCount } : { readySessionCount: 0 }),
      ...(typeof this.#lastReadyQueueDepth === "number" ? { readyQueueDepth: this.#lastReadyQueueDepth } : {}),
      ...(typeof this.#lastUniqueReadySessionCount === "number"
        ? { uniqueReadySessionCount: this.#lastUniqueReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadySessionCount === "number"
        ? { subagentReadySessionCount: this.#lastSubagentReadySessionCount }
        : {}),
      ...(typeof this.#lastSubagentReadyQueueDepth === "number"
        ? { subagentReadyQueueDepth: this.#lastSubagentReadyQueueDepth }
        : {}),
      ...(typeof this.#lastLockedReadySessionCount === "number"
        ? { lockedReadySessionCount: this.#lastLockedReadySessionCount }
        : {}),
      ...(typeof this.#lastStaleReadySessionCount === "number"
        ? { staleReadySessionCount: this.#lastStaleReadySessionCount }
        : {}),
      ...(typeof this.#lastOldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: this.#lastOldestSchedulableReadyAgeMs }
        : {})
    };
  }
}
