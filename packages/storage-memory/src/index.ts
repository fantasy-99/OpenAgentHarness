import type {
  Message,
  RuntimeMessage,
  RuntimeMessageRepository,
  Run,
  RunStep,
  Session,
  SessionEvent,
  SessionEventStore,
  WorkspaceRecord,
  WorkspaceRepository,
  SessionRepository,
  MessageRepository,
  RunRepository,
  RunStepRepository
} from "@oah/runtime-core";
import { AppError, createId, nowIso, parseCursor } from "@oah/runtime-core";

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly #items = new Map<string, WorkspaceRecord>();

  constructor(private readonly onDelete?: (workspaceId: string) => Promise<void>) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.#items.set(input.id, input);
    return input;
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    return this.#items.get(id) ?? null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = parseCursor(cursor);
    return [...this.#items.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(startIndex, startIndex + pageSize);
  }

  async delete(id: string): Promise<void> {
    await this.onDelete?.(id);
    this.#items.delete(id);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #items = new Map<string, Session>();

  constructor(private readonly onDelete?: (sessionId: string) => Promise<void>) {}

  async create(input: Session): Promise<Session> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<Session | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Session): Promise<Session> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    return [...this.#items.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(startIndex, startIndex + pageSize);
  }

  async delete(id: string): Promise<void> {
    if (!this.#items.has(id)) {
      return;
    }

    await this.onDelete?.(id);
    this.#items.delete(id);
  }

  async deleteByWorkspaceId(workspaceId: string): Promise<string[]> {
    const deletedSessionIds: string[] = [];

    for (const session of this.#items.values()) {
      if (session.workspaceId === workspaceId) {
        deletedSessionIds.push(session.id);
      }
    }

    for (const sessionId of deletedSessionIds) {
      await this.delete(sessionId);
    }

    return deletedSessionIds;
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  readonly #items = new Map<string, Message>();
  readonly #sessionMessageIds = new Map<string, string[]>();

  async create(input: Message): Promise<Message> {
    this.#items.set(input.id, input);
    const existing = this.#sessionMessageIds.get(input.sessionId) ?? [];
    existing.push(input.id);
    this.#sessionMessageIds.set(input.sessionId, existing);
    return input;
  }

  async getById(id: string): Promise<Message | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Message): Promise<Message> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    const ids = this.#sessionMessageIds.get(sessionId) ?? [];
    return ids
      .map((id) => this.#items.get(id))
      .filter((value): value is Message => value !== undefined);
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messageIds = this.#sessionMessageIds.get(sessionId) ?? [];
      for (const messageId of messageIds) {
        this.#items.delete(messageId);
      }

      this.#sessionMessageIds.delete(sessionId);
    }
  }
}

export class InMemoryRuntimeMessageRepository implements RuntimeMessageRepository {
  readonly #itemsBySession = new Map<string, RuntimeMessage[]>();

  async replaceBySessionId(sessionId: string, messages: RuntimeMessage[]): Promise<void> {
    this.#itemsBySession.set(sessionId, [...messages]);
  }

  async listBySessionId(sessionId: string): Promise<RuntimeMessage[]> {
    return [...(this.#itemsBySession.get(sessionId) ?? [])];
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.#itemsBySession.delete(sessionId);
    }
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly #items = new Map<string, Run>();

  async create(input: Run): Promise<Run> {
    this.#items.set(input.id, input);
    return input;
  }

  async getById(id: string): Promise<Run | null> {
    return this.#items.get(id) ?? null;
  }

  async update(input: Run): Promise<Run> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    return [...this.#items.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    return [...this.#items.values()]
      .filter((run) => {
        if (run.status !== "running" && run.status !== "waiting_tool") {
          return false;
        }

        const candidateTimestamp = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
        return candidateTimestamp <= staleBefore;
      })
      .sort((left, right) => {
        const leftTimestamp = left.heartbeatAt ?? left.startedAt ?? left.createdAt;
        const rightTimestamp = right.heartbeatAt ?? right.startedAt ?? right.createdAt;
        return leftTimestamp.localeCompare(rightTimestamp);
      })
      .slice(0, Math.max(1, limit));
  }

  deleteBySessionIds(sessionIds: string[]): string[] {
    const sessionIdSet = new Set(sessionIds);
    const deletedRunIds: string[] = [];

    for (const [runId, run] of this.#items.entries()) {
      if (!run.sessionId || !sessionIdSet.has(run.sessionId)) {
        continue;
      }

      deletedRunIds.push(runId);
      this.#items.delete(runId);
    }

    return deletedRunIds;
  }

  deleteByWorkspaceId(workspaceId: string): string[] {
    const deletedRunIds: string[] = [];

    for (const [runId, run] of this.#items.entries()) {
      if (run.workspaceId !== workspaceId) {
        continue;
      }

      deletedRunIds.push(runId);
      this.#items.delete(runId);
    }

    return deletedRunIds;
  }
}

export class InMemoryRunStepRepository implements RunStepRepository {
  readonly #items = new Map<string, RunStep>();
  readonly #runStepIds = new Map<string, string[]>();

  async create(input: RunStep): Promise<RunStep> {
    this.#items.set(input.id, input);
    const existing = this.#runStepIds.get(input.runId) ?? [];
    existing.push(input.id);
    this.#runStepIds.set(input.runId, existing);
    return input;
  }

  async update(input: RunStep): Promise<RunStep> {
    if (!this.#items.has(input.id)) {
      throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
    }

    this.#items.set(input.id, input);
    return input;
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const ids = this.#runStepIds.get(runId) ?? [];
    return ids
      .map((id) => this.#items.get(id))
      .filter((value): value is RunStep => value !== undefined);
  }

  deleteByRunIds(runIds: string[]): void {
    for (const runId of runIds) {
      const stepIds = this.#runStepIds.get(runId) ?? [];
      for (const stepId of stepIds) {
        this.#items.delete(stepId);
      }

      this.#runStepIds.delete(runId);
    }
  }
}

export class InMemorySessionEventStore implements SessionEventStore {
  readonly #eventsBySession = new Map<string, SessionEvent[]>();
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  readonly #nextCursorBySession = new Map<string, number>();

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const currentEvents = this.#eventsBySession.get(input.sessionId) ?? [];
    const nextCursor = this.#nextCursorBySession.get(input.sessionId) ?? 0;
    const event: SessionEvent = {
      ...input,
      id: createId("evt"),
      cursor: String(nextCursor),
      createdAt: nowIso()
    };

    currentEvents.push(event);
    this.#eventsBySession.set(input.sessionId, currentEvents);
    this.#nextCursorBySession.set(input.sessionId, nextCursor + 1);

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const events = this.#eventsBySession.get(sessionId) ?? [];

    return events.filter((event) => {
      const eventCursor = Number.parseInt(event.cursor, 10);
      return Number.isFinite(eventCursor) && eventCursor > normalizedCursor && (!runId || event.runId === runId);
    });
  }

  async deleteById(eventId: string): Promise<void> {
    for (const [sessionId, events] of this.#eventsBySession.entries()) {
      const nextEvents = events.filter((event) => event.id !== eventId);
      if (nextEvents.length !== events.length) {
        this.#eventsBySession.set(sessionId, nextEvents);
        return;
      }
    }
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);

    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current) {
        return;
      }

      current.delete(listener);
      if (current.size === 0) {
        this.#listeners.delete(sessionId);
      }
    };
  }

  deleteBySessionIds(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.#eventsBySession.delete(sessionId);
      this.#listeners.delete(sessionId);
      this.#nextCursorBySession.delete(sessionId);
    }
  }
}

export interface MemoryRuntimePersistence {
  workspaceRepository: InMemoryWorkspaceRepository;
  sessionRepository: InMemorySessionRepository;
  messageRepository: InMemoryMessageRepository;
  runtimeMessageRepository: InMemoryRuntimeMessageRepository;
  runRepository: InMemoryRunRepository;
  runStepRepository: InMemoryRunStepRepository;
  sessionEventStore: InMemorySessionEventStore;
}

export function createMemoryRuntimePersistence(): MemoryRuntimePersistence {
  const messageRepository = new InMemoryMessageRepository();
  const runtimeMessageRepository = new InMemoryRuntimeMessageRepository();
  const runRepository = new InMemoryRunRepository();
  const runStepRepository = new InMemoryRunStepRepository();
  const sessionEventStore = new InMemorySessionEventStore();
  const deleteSessionArtifacts = async (sessionId: string) => {
    const deletedRunIds = runRepository.deleteBySessionIds([sessionId]);
    sessionEventStore.deleteBySessionIds([sessionId]);
    messageRepository.deleteBySessionIds([sessionId]);
    runtimeMessageRepository.deleteBySessionIds([sessionId]);
    runStepRepository.deleteByRunIds(deletedRunIds);
  };
  const sessionRepository = new InMemorySessionRepository(deleteSessionArtifacts);
  const workspaceRepository = new InMemoryWorkspaceRepository(async (workspaceId) => {
    await sessionRepository.deleteByWorkspaceId(workspaceId);
    const deletedRunIds = runRepository.deleteByWorkspaceId(workspaceId);
    runStepRepository.deleteByRunIds(deletedRunIds);
  });

  return {
    workspaceRepository,
    sessionRepository,
    messageRepository,
    runtimeMessageRepository,
    runRepository,
    runStepRepository,
    sessionEventStore
  };
}
