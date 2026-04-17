import type {
  RunQueue,
  RunQueuePriority,
  RunRepository,
  SessionEvent,
  SessionEventStore,
  SessionRepository,
  WorkspaceActivityTracker
} from "../types.js";
import { doesSessionEventAffectRuntimeMessages } from "./runtime-messages.js";
import type { RuntimeMessageSyncService } from "./runtime-message-sync.js";

export interface RuntimeLifecycleServiceDependencies {
  sessionEventStore: SessionEventStore;
  runtimeMessageSync: Pick<RuntimeMessageSyncService, "scheduleRuntimeMessageSync">;
  workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  runRepository: RunRepository;
  sessionRepository: SessionRepository;
  runQueue?: RunQueue | undefined;
  processRun: (runId: string) => Promise<void>;
}

export class RuntimeLifecycleService {
  readonly #sessionEventStore: SessionEventStore;
  readonly #runtimeMessageSync: Pick<RuntimeMessageSyncService, "scheduleRuntimeMessageSync">;
  readonly #workspaceActivityTracker: WorkspaceActivityTracker | undefined;
  readonly #runRepository: RunRepository;
  readonly #sessionRepository: SessionRepository;
  readonly #runQueue: RunQueue | undefined;
  readonly #processRun: (runId: string) => Promise<void>;
  readonly #sessionChains = new Map<string, Promise<void>>();

  constructor(dependencies: RuntimeLifecycleServiceDependencies) {
    this.#sessionEventStore = dependencies.sessionEventStore;
    this.#runtimeMessageSync = dependencies.runtimeMessageSync;
    this.#workspaceActivityTracker = dependencies.workspaceActivityTracker;
    this.#runRepository = dependencies.runRepository;
    this.#sessionRepository = dependencies.sessionRepository;
    this.#runQueue = dependencies.runQueue;
    this.#processRun = dependencies.processRun;
  }

  async appendEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#sessionEventStore.append(input);
    await this.#touchWorkspaceActivityForEvent(input);
    if (doesSessionEventAffectRuntimeMessages(event)) {
      await this.#runtimeMessageSync.scheduleRuntimeMessageSync(input.sessionId);
    }
    return event;
  }

  async enqueueRun(
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined }
  ): Promise<void> {
    if (this.#runQueue) {
      await this.#runQueue.enqueue(sessionId, runId, options);
      return;
    }

    const previous = this.#sessionChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#processRun(runId);
      })
      .finally(() => {
        if (this.#sessionChains.get(sessionId) === next) {
          this.#sessionChains.delete(sessionId);
        }
      });

    this.#sessionChains.set(sessionId, next);
  }

  async #touchWorkspaceActivity(workspaceId: string): Promise<void> {
    await this.#workspaceActivityTracker?.touchWorkspace(workspaceId);
  }

  async #touchWorkspaceActivityForEvent(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<void> {
    if (
      input.event !== "run.queued" &&
      input.event !== "run.started" &&
      input.event !== "run.completed" &&
      input.event !== "run.failed" &&
      input.event !== "run.cancelled"
    ) {
      return;
    }

    if (input.runId) {
      const run = await this.#runRepository.getById(input.runId);
      if (run) {
        await this.#touchWorkspaceActivity(run.workspaceId);
        return;
      }
    }

    const session = await this.#sessionRepository.getById(input.sessionId);
    if (session) {
      await this.#touchWorkspaceActivity(session.workspaceId);
    }
  }
}
