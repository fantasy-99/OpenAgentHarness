import { createId } from "@oah/engine-core";
import { calculateWorkerLeaseTtlMs } from "./worker-registry.js";
import type { RedisRunWorkerLogger, RedisRunWorkerOptions } from "./worker-types.js";

export class RedisRunWorker {
  readonly #queue: RedisRunWorkerOptions["queue"];
  readonly #runtimeService: RedisRunWorkerOptions["runtimeService"];
  readonly #workerId: string;
  readonly #runtimeInstanceId?: string | undefined;
  readonly #ownerBaseUrl?: string | undefined;
  readonly #processKind: "embedded" | "standalone";
  readonly #lockTtlMs: number;
  readonly #pollTimeoutMs: number;
  readonly #recoveryGraceMs: number;
  readonly #leaseTtlMs: number;
  readonly #registry?: RedisRunWorkerOptions["registry"];
  readonly #recoverOnStart: boolean;
  readonly #logger?: RedisRunWorkerLogger | undefined;
  readonly #onStateChange: RedisRunWorkerOptions["onStateChange"];
  #loop: Promise<void> | undefined;
  #active = false;
  #state: "starting" | "idle" | "busy" | "stopping" = "starting";
  #currentSessionId: string | undefined;
  #currentRunId: string | undefined;
  #currentWorkspaceId: string | undefined;

  constructor(options: RedisRunWorkerOptions) {
    this.#queue = options.queue;
    this.#runtimeService = options.runtimeService;
    this.#workerId = options.workerId ?? createId("worker");
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#ownerBaseUrl = options.ownerBaseUrl;
    this.#processKind = options.processKind ?? "embedded";
    this.#lockTtlMs = Math.max(1_000, options.lockTtlMs ?? 30_000);
    this.#pollTimeoutMs = Math.max(250, options.pollTimeoutMs ?? 1_000);
    this.#recoveryGraceMs = Math.max(this.#lockTtlMs, options.recoveryGraceMs ?? this.#lockTtlMs * 2);
    this.#leaseTtlMs = calculateWorkerLeaseTtlMs(this.#lockTtlMs, this.#pollTimeoutMs);
    this.#registry = options.registry;
    this.#recoverOnStart = options.recoverOnStart ?? true;
    this.#logger = options.logger;
    this.#onStateChange = options.onStateChange;
  }

  start(): void {
    if (this.#loop) {
      return;
    }

    this.#active = true;
    this.#notifyStateChange();
    this.#loop = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#active = false;
    this.#setState("stopping");
    await this.#publishLease();
    await this.#loop;
  }

  async #runLoop(): Promise<void> {
    await this.#publishLease();
    const leaseHeartbeat = setInterval(() => {
      void this.#publishLease();
    }, Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)));
    leaseHeartbeat.unref?.();

    if (this.#recoverOnStart && this.#runtimeService.recoverStaleRuns) {
      try {
        await this.#runtimeService.recoverStaleRuns({
          staleBefore: new Date(Date.now() - this.#recoveryGraceMs).toISOString()
        });
      } catch (error) {
        this.#logger?.warn("Failed to recover stale runs during worker startup.", error);
      }
    }

    this.#setState("idle");
    await this.#publishLease();

    try {
      while (this.#active) {
        let sessionId: string | undefined;
        try {
          sessionId = await this.#queue.claimNextSession(this.#pollTimeoutMs, {
            workerId: this.#workerId,
            ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {})
          });
        } catch (error) {
          this.#logger?.warn("Failed to claim next Redis run queue item.", error);
          continue;
        }

        if (!sessionId) {
          continue;
        }

        const lockToken = `${this.#workerId}:${createId("lock")}`;
        let acquired = false;
        try {
          acquired = await this.#queue.tryAcquireSessionLock(sessionId, lockToken, this.#lockTtlMs);
        } catch (error) {
          this.#logger?.warn(`Failed to acquire Redis session lock for ${sessionId}.`, error);
          continue;
        }

        if (!acquired) {
          await this.#restoreClaimedSession(sessionId);
          continue;
        }

        this.#setState("busy", sessionId);
        await this.#publishLease();

        const heartbeat = setInterval(() => {
          void this.#queue.renewSessionLock(sessionId, lockToken, this.#lockTtlMs).then(
            (renewed) => {
              if (!renewed) {
                this.#logger?.warn(`Redis session lock renewal lost for ${sessionId}.`);
              }
            },
            (error) => {
              this.#logger?.warn(`Failed to renew Redis session lock for ${sessionId}.`, error);
            }
          );
        }, Math.max(1_000, Math.floor(this.#lockTtlMs / 3)));
        heartbeat.unref?.();

        try {
          while (this.#active) {
            const runId = await this.#queue.dequeueRun(sessionId);
            if (!runId) {
              break;
            }

            try {
              const queuedRun = this.#runtimeService.describeQueuedRun
                ? await this.#runtimeService.describeQueuedRun(runId)
                : undefined;
              this.#setState("busy", sessionId, runId, queuedRun?.workspaceId);
              await this.#publishLease();
              await this.#runtimeService.processQueuedRun(runId);
            } catch (error) {
              this.#logger?.error(`Failed to process queued run ${runId}.`, error);
            } finally {
              this.#setState("busy", sessionId);
              await this.#publishLease();
            }
          }
        } finally {
          clearInterval(heartbeat);
          this.#setState(this.#active ? "idle" : "stopping");
          await this.#publishLease();
          try {
            await this.#queue.releaseSessionLock(sessionId, lockToken);
          } catch (error) {
            this.#logger?.warn(`Failed to release Redis session lock for ${sessionId}.`, error);
          }
        }
      }
    } finally {
      clearInterval(leaseHeartbeat);
      await this.#registry?.remove(this.#workerId).catch((error) => {
        this.#logger?.warn(`Failed to remove worker lease for ${this.#workerId}.`, error);
      });
    }
  }

  async #publishLease(): Promise<void> {
    if (!this.#registry) {
      return;
    }

    try {
      await this.#registry.heartbeat(
        {
          workerId: this.#workerId,
          ...(this.#runtimeInstanceId ? { runtimeInstanceId: this.#runtimeInstanceId } : {}),
          ...(this.#ownerBaseUrl ? { ownerBaseUrl: this.#ownerBaseUrl } : {}),
          processKind: this.#processKind,
          state: this.#state,
          lastSeenAt: new Date().toISOString(),
          ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {}),
          ...(this.#currentRunId ? { currentRunId: this.#currentRunId } : {}),
          ...(this.#currentWorkspaceId ? { currentWorkspaceId: this.#currentWorkspaceId } : {})
        },
        this.#leaseTtlMs
      );
    } catch (error) {
      this.#logger?.warn(`Failed to publish worker lease for ${this.#workerId}.`, error);
    }
  }

  async #restoreClaimedSession(sessionId: string): Promise<void> {
    if (typeof this.#queue.requeueSessionIfPending !== "function") {
      return;
    }

    try {
      await this.#queue.requeueSessionIfPending(sessionId);
    } catch (error) {
      this.#logger?.warn(`Failed to restore claimed Redis session ${sessionId} back to the ready queue.`, error);
    }
  }

  #setState(
    nextState: "starting" | "idle" | "busy" | "stopping",
    currentSessionId?: string,
    currentRunId?: string,
    currentWorkspaceId?: string
  ): void {
    if (
      this.#state === nextState &&
      this.#currentSessionId === currentSessionId &&
      this.#currentRunId === currentRunId &&
      this.#currentWorkspaceId === currentWorkspaceId
    ) {
      return;
    }

    this.#state = nextState;
    this.#currentSessionId = currentSessionId;
    this.#currentRunId = currentRunId;
    this.#currentWorkspaceId = currentWorkspaceId;
    this.#notifyStateChange();
  }

  #notifyStateChange(): void {
    this.#onStateChange?.({
      workerId: this.#workerId,
      state: this.#state,
      ...(this.#currentSessionId ? { currentSessionId: this.#currentSessionId } : {}),
      ...(this.#currentRunId ? { currentRunId: this.#currentRunId } : {}),
      ...(this.#currentWorkspaceId ? { currentWorkspaceId: this.#currentWorkspaceId } : {})
    });
  }
}
