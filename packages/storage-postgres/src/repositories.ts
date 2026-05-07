import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import type {
  ArtifactRecord,
  ArtifactRepository,
  AgentTaskNotificationRecord,
  AgentTaskNotificationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  Message,
  MessageRepository,
  MessagePageCursor,
  EngineMessage,
  EngineMessageRepository,
  Run,
  RunRepository,
  RunStep,
  RunStepRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionPendingRunQueueEntry,
  SessionPendingRunQueueRepository,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/engine-core";
import { AppError, createId, nowIso, parseCursor, parseMessagePageCursor } from "@oah/engine-core";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { OahDatabase, OahTransaction } from "./schema.js";
import {
  archives,
  agentTaskNotifications,
  agentTasks,
  artifacts,
  historyEvents,
  hookRuns,
  messages,
  runSteps,
  runs,
  engineMessages,
  sessionEvents,
  sessionPendingRuns,
  sessions,
  toolCalls,
  workspaces
} from "./schema.js";
import {
  appendHistoryDeleteEvents,
  appendHistoryEventRecord,
  buildAgentTaskRow,
  buildAgentTaskNotificationRow,
  buildArtifactRow,
  buildHookRunRow,
  buildMessageRow,
  buildRunRow,
  buildEngineMessageRow,
  buildRunStepRow,
  buildSessionRow,
  buildToolCallRow,
  buildWorkspaceArchiveRow,
  buildWorkspaceRow,
  expectRow,
  nonNull,
  resolveWorkspaceIdForRun,
  resolveWorkspaceIdForSession,
  toArtifactRecord,
  toAgentTaskRecord,
  toAgentTaskNotificationRecord,
  toHistoryEventRecord,
  toHookRunAuditRecord,
  toMessage,
  toRun,
  toEngineMessageRecord,
  toRunStep,
  toSession,
  toSessionEvent,
  toToolCallAuditRecord,
  toWorkspaceArchiveRecord,
  toWorkspaceRecord
} from "./row-mappers.js";

const DEFAULT_POSTGRES_BOUNDED_READ_LIMIT = 5_000;
const DEFAULT_POSTGRES_EVENT_READ_LIMIT = 1_000;
const MAX_POSTGRES_BOUNDED_READ_LIMIT = 100_000;
const MAX_POSTGRES_ARCHIVE_COMPONENT_LIMIT = 500_000;
const POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE = 500;

const DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS = {
  sessions: 10_000,
  runs: 50_000,
  messages: 100_000,
  engineMessages: 100_000,
  runSteps: 100_000,
  toolCalls: 100_000,
  hookRuns: 100_000,
  artifacts: 100_000
} as const;

interface PostgresWorkspaceArchiveRepositoryOptions {
  payloadRoot?: string | undefined;
}

type ArchiveComponentName =
  | "sessions"
  | "runs"
  | "messages"
  | "engineMessages"
  | "runSteps"
  | "toolCalls"
  | "hookRuns"
  | "artifacts";

type ArchiveComponentLimits = Record<ArchiveComponentName, number>;

function resolvePostgresBoundedReadLimit(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim() || process.env.OAH_POSTGRES_BOUNDED_READ_LIMIT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_POSTGRES_BOUNDED_READ_LIMIT);
}

function resolvePostgresArchiveComponentLimit(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim() || process.env.OAH_POSTGRES_ARCHIVE_MAX_COMPONENT_ROWS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_POSTGRES_ARCHIVE_COMPONENT_LIMIT);
}

function assertArchiveComponentLimit(
  component: string,
  rows: readonly unknown[],
  limit: number,
  input: {
    workspace: WorkspaceRecord;
    scopeType: WorkspaceArchiveRecord["scopeType"];
    scopeId: string;
  }
): void {
  if (rows.length <= limit) {
    return;
  }

  throw new AppError(
    413,
    "workspace_archive_too_large",
    `Workspace archive ${input.scopeType}:${input.scopeId} for workspace ${input.workspace.id} exceeded the ${component} row limit (${limit}). ` +
      "Export or prune older metadata before retrying, or raise the matching OAH_POSTGRES_ARCHIVE_MAX_* limit."
  );
}

class JsonArchivePayloadWriter {
  readonly #stream: ReturnType<typeof createWriteStream>;
  #needsPropertySeparator = false;
  #currentArrayNeedsSeparator = false;

  constructor(filePath: string) {
    this.#stream = createWriteStream(filePath, {
      encoding: "utf8"
    });
  }

  async open(): Promise<void> {
    await this.write("{");
  }

  async writeProperty(name: string, value: unknown): Promise<void> {
    await this.writePropertyPrefix(name);
    await this.write(JSON.stringify(value ?? null));
  }

  async beginArray(name: ArchiveComponentName): Promise<void> {
    await this.writePropertyPrefix(name);
    this.#currentArrayNeedsSeparator = false;
    await this.write("[");
  }

  async writeArrayItem(value: unknown): Promise<void> {
    if (this.#currentArrayNeedsSeparator) {
      await this.write(",");
    }
    this.#currentArrayNeedsSeparator = true;
    await this.write(JSON.stringify(value ?? null));
  }

  async endArray(): Promise<void> {
    await this.write("]");
  }

  async close(): Promise<void> {
    await this.write("}");
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async destroy(): Promise<void> {
    this.#stream.destroy();
  }

  private async writePropertyPrefix(name: string): Promise<void> {
    if (this.#needsPropertySeparator) {
      await this.write(",");
    }
    this.#needsPropertySeparator = true;
    await this.write(`${JSON.stringify(name)}:`);
  }

  private async write(chunk: string): Promise<void> {
    if (this.#stream.write(chunk)) {
      return;
    }

    await once(this.#stream, "drain");
  }
}

function resolveArchivePayloadRoot(input?: string | undefined): string | undefined {
  const configured = input?.trim() || process.env.OAH_POSTGRES_ARCHIVE_PAYLOAD_DIR?.trim();
  return configured ? path.resolve(configured) : undefined;
}

function archivePayloadPath(root: string, archiveDate: string, archiveId: string): string {
  return path.join(root, archiveDate, `${archiveId}.json`);
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const [row] = await this.db.insert(workspaces).values(buildWorkspaceRow(input)).returning();
    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const values = buildWorkspaceRow(input);
    const [row] = await this.db
      .insert(workspaces)
      .values(values)
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          externalRef: values.externalRef,
          name: values.name,
          rootPath: values.rootPath,
          executionPolicy: values.executionPolicy,
          status: values.status,
          kind: values.kind,
          readOnly: values.readOnly,
          historyMirrorEnabled: values.historyMirrorEnabled,
          defaultAgent: values.defaultAgent,
          projectAgentsMd: values.projectAgentsMd,
          settings: values.settings,
          workspaceModels: values.workspaceModels,
          agents: values.agents,
          actions: values.actions,
          skills: values.skills,
          toolServers: values.toolServers,
          hooks: values.hooks,
          catalog: values.catalog,
          updatedAt: values.updatedAt
        }
      })
      .returning();

    return toWorkspaceRecord(expectRow(row, `workspace ${input.id}`));
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return row ? toWorkspaceRecord(row) : null;
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(workspaces)
      .orderBy(sql`${workspaces.updatedAt} desc`, sql`${workspaces.createdAt} desc`, sql`${workspaces.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toWorkspaceRecord);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(sessions).values(buildSessionRow(input)).returning();
      const created = toSession(expectRow(row, `session ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "session",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ? toSession(row) : null;
  }

  async update(input: Session): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(sessions).set(buildSessionRow(input)).where(eq(sessions.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
      }

      const updated = toSession(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "session",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(sql`${sessions.updatedAt} desc`, sql`${sessions.createdAt} desc`, sql`${sessions.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toSession);
  }

  async listChildrenByParentSessionId(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    const startIndex = parseCursor(cursor);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.parentSessionId, parentSessionId))
      .orderBy(sql`${sessions.updatedAt} desc`, sql`${sessions.createdAt} desc`, sql`${sessions.id} asc`)
      .limit(pageSize)
      .offset(startIndex);

    return rows.map(toSession);
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      if (!sessionRow) {
        return;
      }

      const workspaceId = sessionRow.workspaceId;
      const sessionRunRows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.sessionId, id));
      const runIds = sessionRunRows.map((row) => row.id);
      const [sessionMessageRows, runStepRows, toolCallRows, hookRunRows, artifactRows] = await Promise.all([
        tx.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, id)),
        runIds.length > 0 ? tx.select({ id: runSteps.id }).from(runSteps).where(inArray(runSteps.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: toolCalls.id }).from(toolCalls).where(inArray(toolCalls.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: hookRuns.id }).from(hookRuns).where(inArray(hookRuns.runId, runIds)) : Promise.resolve([]),
        runIds.length > 0 ? tx.select({ id: artifacts.id }).from(artifacts).where(inArray(artifacts.runId, runIds)) : Promise.resolve([])
      ]);

      await tx.delete(messages).where(eq(messages.sessionId, id));
      await tx.delete(sessions).where(eq(sessions.id, id));

      const occurredAt = nowIso();
      await appendHistoryDeleteEvents(
        tx,
        workspaceId,
        [
          ...artifactRows.map((row) => ({ entityType: "artifact" as const, entityId: row.id })),
          ...hookRunRows.map((row) => ({ entityType: "hook_run" as const, entityId: row.id })),
          ...toolCallRows.map((row) => ({ entityType: "tool_call" as const, entityId: row.id })),
          ...runStepRows.map((row) => ({ entityType: "run_step" as const, entityId: row.id })),
          ...sessionRunRows.map((row) => ({ entityType: "run" as const, entityId: row.id })),
          ...sessionMessageRows.map((row) => ({ entityType: "message" as const, entityId: row.id })),
          { entityType: "session", entityId: id }
        ],
        occurredAt
      );
    });
  }
}

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: OahDatabase) {}

  #buildMessageCursorPredicate(
    cursor: MessagePageCursor,
    direction: "forward" | "backward"
  ): ReturnType<typeof or> {
    if (direction === "backward") {
      return or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
      );
    }

    return or(
      gt(messages.createdAt, cursor.createdAt),
      and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id))
    );
  }

  async create(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(messages).values(buildMessageRow(input)).returning();
      const created = toMessage(expectRow(row, `message ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, created.sessionId),
        entityType: "message",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Message | null> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row ? toMessage(row) : null;
  }

  async update(input: Message): Promise<Message> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(messages).set(buildMessageRow(input)).where(eq(messages.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "message_not_found", `Message ${input.id} was not found.`);
      }

      const updated = toMessage(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForSession(tx, updated.sessionId),
        entityType: "message",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    const limit = resolvePostgresBoundedReadLimit(
      "OAH_POSTGRES_SESSION_MESSAGE_READ_LIMIT",
      DEFAULT_POSTGRES_BOUNDED_READ_LIMIT
    );
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);

    return rows.map(toMessage).reverse();
  }

  async listPageBySessionId(input: {
    sessionId: string;
    pageSize: number;
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
  }): Promise<{ items: Message[]; hasMore: boolean }> {
    const direction = input.direction ?? "forward";
    const cursor = parseMessagePageCursor(input.cursor);
    const whereClause = cursor
      ? and(eq(messages.sessionId, input.sessionId), this.#buildMessageCursorPredicate(cursor, direction))
      : eq(messages.sessionId, input.sessionId);
    const rows = await this.db
      .select()
      .from(messages)
      .where(whereClause)
      .orderBy(
        direction === "backward" ? desc(messages.createdAt) : asc(messages.createdAt),
        direction === "backward" ? desc(messages.id) : asc(messages.id)
      )
      .limit(input.pageSize + 1);

    const hasMore = rows.length > input.pageSize;
    const pageRows = hasMore ? rows.slice(0, input.pageSize) : rows;
    const orderedRows = direction === "backward" ? [...pageRows].reverse() : pageRows;

    return {
      items: orderedRows.map(toMessage),
      hasMore
    };
  }
}

export class PostgresEngineMessageRepository implements EngineMessageRepository {
  constructor(private readonly db: OahDatabase) {}

  async replaceBySessionId(sessionId: string, messagesForSession: EngineMessage[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(engineMessages).where(eq(engineMessages.sessionId, sessionId));
      if (messagesForSession.length === 0) {
        return;
      }

      await tx.insert(engineMessages).values(messagesForSession.map((message) => buildEngineMessageRow(message)));
    });
  }

  async listBySessionId(sessionId: string): Promise<EngineMessage[]> {
    const limit = resolvePostgresBoundedReadLimit(
      "OAH_POSTGRES_SESSION_ENGINE_MESSAGE_READ_LIMIT",
      DEFAULT_POSTGRES_BOUNDED_READ_LIMIT
    );
    const rows = await this.db
      .select()
      .from(engineMessages)
      .where(eq(engineMessages.sessionId, sessionId))
      .orderBy(desc(engineMessages.createdAt), desc(engineMessages.id))
      .limit(limit);

    return rows.map(toEngineMessageRecord).reverse();
  }
}

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runs).values(buildRunRow(input)).returning();
      const created = toRun(expectRow(row, `run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: created.workspaceId,
        entityType: "run",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async getById(id: string): Promise<Run | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async update(input: Run): Promise<Run> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runs).set(buildRunRow(input)).where(eq(runs.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
      }

      const updated = toRun(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: updated.workspaceId,
        entityType: "run",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_SESSION_RUN_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit);
    return rows.map(toRun);
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["running", "waiting_tool"]),
          sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt}) <= ${staleBefore}`
        )
      )
      .orderBy(asc(sql`coalesce(${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt})`), asc(runs.id))
      .limit(Math.max(1, limit));

    return rows.map(toRun);
  }
}

export class PostgresRunStepRepository implements RunStepRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(runSteps).values(buildRunStepRow(input)).returning();
      const created = toRunStep(expectRow(row, `run step ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "run_step",
        entityId: created.id,
        op: "upsert",
        payload: created as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async update(input: RunStep): Promise<RunStep> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(runSteps).set(buildRunStepRow(input)).where(eq(runSteps.id, input.id)).returning();
      if (!row) {
        throw new AppError(404, "run_step_not_found", `Run step ${input.id} was not found.`);
      }

      const updated = toRunStep(row);
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, updated.runId),
        entityType: "run_step",
        entityId: updated.id,
        op: "upsert",
        payload: updated as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return updated;
    });
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    const rows = await this.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
    return rows.map(toRunStep);
  }
}

export class PostgresSessionPendingRunQueueRepository implements SessionPendingRunQueueRepository {
  constructor(private readonly db: OahDatabase) {}

  async enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry> {
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select({
          maxPosition: sql<number>`coalesce(max(${sessionPendingRuns.position}), 0)`
        })
        .from(sessionPendingRuns)
        .where(eq(sessionPendingRuns.sessionId, input.sessionId));
      const position = nonNull(current[0]?.maxPosition, 0) + 1;

      await tx
        .insert(sessionPendingRuns)
        .values({
          runId: input.runId,
          sessionId: input.sessionId,
          position,
          createdAt: input.createdAt
        })
        .onConflictDoNothing();

      return (
        (await this.getByRunId(input.runId)) ?? {
          sessionId: input.sessionId,
          runId: input.runId,
          position,
          createdAt: input.createdAt
        }
      );
    });
  }

  async listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]> {
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_PENDING_RUN_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(sessionPendingRuns)
      .where(eq(sessionPendingRuns.sessionId, sessionId))
      .orderBy(asc(sessionPendingRuns.position), asc(sessionPendingRuns.createdAt), asc(sessionPendingRuns.runId))
      .limit(limit);

    return rows.map((row) => ({
      sessionId: row.sessionId,
      runId: row.runId,
      position: row.position,
      createdAt: row.createdAt
    }));
  }

  async getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null> {
    const [row] = await this.db.select().from(sessionPendingRuns).where(eq(sessionPendingRuns.runId, runId)).limit(1);
    if (!row) {
      return null;
    }

    return {
      sessionId: row.sessionId,
      runId: row.runId,
      position: row.position,
      createdAt: row.createdAt
    };
  }

  async promote(runId: string): Promise<void> {
    const entry = await this.getByRunId(runId);
    if (!entry) {
      return;
    }

    const current = await this.db
      .select({
        minPosition: sql<number>`coalesce(min(${sessionPendingRuns.position}), 0)`
      })
      .from(sessionPendingRuns)
      .where(eq(sessionPendingRuns.sessionId, entry.sessionId));
    await this.db
      .update(sessionPendingRuns)
      .set({
        position: nonNull(current[0]?.minPosition, 0) - 1
      })
      .where(eq(sessionPendingRuns.runId, runId));
  }

  async dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessionPendingRuns)
        .where(eq(sessionPendingRuns.sessionId, sessionId))
        .orderBy(asc(sessionPendingRuns.position), asc(sessionPendingRuns.createdAt), asc(sessionPendingRuns.runId))
        .limit(1);
      if (!row) {
        return null;
      }

      await tx.delete(sessionPendingRuns).where(eq(sessionPendingRuns.runId, row.runId));
      return {
        sessionId: row.sessionId,
        runId: row.runId,
        position: row.position,
        createdAt: row.createdAt
      };
    });
  }

  async remove(runId: string): Promise<void> {
    await this.db.delete(sessionPendingRuns).where(eq(sessionPendingRuns.runId, runId));
  }
}

export class PostgresSessionEventStore implements SessionEventStore {
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.db.transaction(async (tx) => {
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, input.sessionId)).for("update").execute();
      const current = await tx
        .select({
          maxCursor: sql<number>`coalesce(max(${sessionEvents.cursor}), -1)`
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId));
      const nextCursor = nonNull(current[0]?.maxCursor, -1) + 1;
      const [row] = await tx
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          cursor: nextCursor,
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          event: input.event,
          data: input.data,
          createdAt: nowIso()
        })
        .returning();

      return toSessionEvent(expectRow(row, `session event ${nextCursor}`));
    });

    for (const listener of this.#listeners.get(input.sessionId) ?? []) {
      listener(event);
    }

    return event;
  }

  async listSince(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : -1;
    const normalizedCursor = Number.isFinite(parsedCursor) && parsedCursor >= -1 ? parsedCursor : -1;
    const readLimit = Math.max(
      1,
      Math.min(
        limit ?? resolvePostgresBoundedReadLimit("OAH_POSTGRES_SESSION_EVENT_READ_LIMIT", DEFAULT_POSTGRES_EVENT_READ_LIMIT),
        MAX_POSTGRES_BOUNDED_READ_LIMIT
      )
    );
    const filters = [eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.cursor, normalizedCursor)];
    if (runId) {
      filters.push(eq(sessionEvents.runId, runId));
    }

    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(...filters))
      .orderBy(asc(sessionEvents.cursor))
      .limit(readLimit);
    return rows.map(toSessionEvent);
  }

  async deleteById(eventId: string): Promise<void> {
    await this.db.delete(sessionEvents).where(eq(sessionEvents.id, eventId));
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
}

export class PostgresToolCallAuditRepository implements ToolCallAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(toolCalls).values(buildToolCallRow(input)).returning();
      const created = toToolCallAuditRecord(expectRow(row, `tool call ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "tool_call",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

export class PostgresHookRunAuditRepository implements HookRunAuditRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(hookRuns).values(buildHookRunRow(input)).returning();
      const created = toHookRunAuditRecord(expectRow(row, `hook run ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "hook_run",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(artifacts).values(buildArtifactRow(input)).returning();
      const created = toArtifactRecord(expectRow(row, `artifact ${input.id}`));
      await appendHistoryEventRecord(tx, {
        workspaceId: await resolveWorkspaceIdForRun(tx, created.runId),
        entityType: "artifact",
        entityId: created.id,
        op: "upsert",
        payload: created as unknown as Record<string, unknown>,
        occurredAt: nowIso()
      });
      return created;
    });
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactRecord);
  }
}

export class PostgresAgentTaskRepository implements AgentTaskRepository {
  constructor(private readonly db: OahDatabase) {}

  async upsert(input: AgentTaskRecord): Promise<AgentTaskRecord> {
    const values = buildAgentTaskRow(input);
    const [row] = await this.db
      .insert(agentTasks)
      .values(values)
      .onConflictDoUpdate({
        target: agentTasks.taskId,
        set: {
          workspaceId: values.workspaceId,
          parentSessionId: values.parentSessionId,
          parentRunId: values.parentRunId,
          childSessionId: values.childSessionId,
          childRunId: values.childRunId,
          toolUseId: values.toolUseId,
          targetAgentName: values.targetAgentName,
          parentAgentName: values.parentAgentName,
          status: values.status,
          description: values.description,
          handoffSummary: values.handoffSummary,
          outputRef: values.outputRef,
          outputFile: values.outputFile,
          finalText: values.finalText,
          errorMessage: values.errorMessage,
          usage: values.usage,
          taskState: values.taskState,
          notifiedAt: values.notifiedAt,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt
        }
      })
      .returning();
    return toAgentTaskRecord(expectRow(row, `agent task ${input.taskId}`));
  }

  async getByTaskId(taskId: string): Promise<AgentTaskRecord | null> {
    const [row] = await this.db.select().from(agentTasks).where(eq(agentTasks.taskId, taskId)).limit(1);
    return row ? toAgentTaskRecord(row) : null;
  }

  async update(input: {
    taskId: string;
    status: AgentTaskRecord["status"];
    updatedAt: string;
    toolUseId?: string | undefined;
    outputRef?: string | undefined;
    outputFile?: string | undefined;
    finalText?: string | undefined;
    errorMessage?: string | undefined;
    usage?: Record<string, unknown> | undefined;
    taskState?: AgentTaskRecord["taskState"] | undefined;
    notifiedAt?: string | undefined;
  }): Promise<AgentTaskRecord> {
    const [row] = await this.db
      .update(agentTasks)
      .set({
        status: input.status,
        updatedAt: input.updatedAt,
        ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
        ...(input.outputRef !== undefined ? { outputRef: input.outputRef } : {}),
        ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
        ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        ...(input.taskState !== undefined ? { taskState: input.taskState } : {}),
        ...(input.notifiedAt !== undefined ? { notifiedAt: input.notifiedAt } : {})
      })
      .where(eq(agentTasks.taskId, input.taskId))
      .returning();
    if (!row) {
      throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
    }

    return toAgentTaskRecord(row);
  }
}

export class PostgresAgentTaskNotificationRepository implements AgentTaskNotificationRepository {
  constructor(private readonly db: OahDatabase) {}

  async create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord> {
    const values = buildAgentTaskNotificationRow(input);
    const [row] = await this.db
      .insert(agentTaskNotifications)
      .values(values)
      .onConflictDoUpdate({
        target: agentTaskNotifications.id,
        set: {
          workspaceId: values.workspaceId,
          parentSessionId: values.parentSessionId,
          parentRunId: values.parentRunId,
          taskId: values.taskId,
          toolUseId: values.toolUseId,
          childRunId: values.childRunId,
          childSessionId: values.childSessionId,
          updateType: values.updateType,
          content: values.content,
          metadata: values.metadata,
          status: values.status,
          createdAt: values.createdAt,
          consumedAt: values.consumedAt
        }
      })
      .returning();
    return toAgentTaskNotificationRecord(expectRow(row, `agent task notification ${input.id}`));
  }

  async listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]> {
    const rows = await this.db
      .select()
      .from(agentTaskNotifications)
      .where(and(eq(agentTaskNotifications.parentSessionId, parentSessionId), eq(agentTaskNotifications.status, "pending")))
      .orderBy(asc(agentTaskNotifications.createdAt), asc(agentTaskNotifications.id));
    return rows.map(toAgentTaskNotificationRecord);
  }

  async markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void> {
    if (input.ids.length === 0) {
      return;
    }

    await this.db
      .update(agentTaskNotifications)
      .set({
        status: "consumed",
        consumedAt: input.consumedAt
      })
      .where(inArray(agentTaskNotifications.id, input.ids));
  }
}

export class PostgresHistoryEventRepository implements HistoryEventRepository {
  constructor(private readonly db: OahDatabase) {}

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    return appendHistoryEventRecord(this.db, input);
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const filters = [eq(historyEvents.workspaceId, workspaceId)];
    if (afterId !== undefined) {
      filters.push(gt(historyEvents.id, afterId));
    }

    const rows = await this.db
      .select()
      .from(historyEvents)
      .where(and(...filters))
      .orderBy(asc(historyEvents.id))
      .limit(limit);

    return rows.map(toHistoryEventRecord);
  }

  async pruneByWorkspace(workspaceId: string, maxEventId: number, occurredBefore: string): Promise<number> {
    if (maxEventId <= 0) {
      return 0;
    }

    const rows = await this.db
      .delete(historyEvents)
      .where(
        and(
          eq(historyEvents.workspaceId, workspaceId),
          sql`${historyEvents.id} <= ${maxEventId}`,
          sql`${historyEvents.occurredAt} < ${occurredBefore}`
        )
      )
      .returning({ id: historyEvents.id });

    return rows.length;
  }
}

export class PostgresWorkspaceArchiveRepository implements WorkspaceArchiveRepository {
  readonly #payloadRoot: string | undefined;

  constructor(private readonly db: OahDatabase, options: PostgresWorkspaceArchiveRepositoryOptions = {}) {
    this.#payloadRoot = resolveArchivePayloadRoot(options.payloadRoot);
  }

  async #writePagedArchiveArray<Row, Value>(
    writer: JsonArchivePayloadWriter,
    component: ArchiveComponentName,
    limit: number,
    loadPage: (offset: number, pageSize: number) => Promise<Row[]>,
    mapRow: (row: Row) => Value
  ): Promise<void> {
    await writer.beginArray(component);
    let count = 0;
    let offset = 0;

    while (true) {
      const rows = await loadPage(offset, POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        count += 1;
        if (count > limit) {
          throw new AppError(
            413,
            "workspace_archive_too_large",
            `Workspace archive exceeded the ${component} row limit (${limit}). ` +
              "Export or prune older metadata before retrying, or raise the matching OAH_POSTGRES_ARCHIVE_MAX_* limit."
          );
        }
        await writer.writeArrayItem(mapRow(row));
      }

      if (rows.length < POSTGRES_ARCHIVE_PAYLOAD_PAGE_SIZE) {
        break;
      }
      offset += rows.length;
    }

    await writer.endArray();
  }

  async #writeExternalArchivePayload(
    tx: OahTransaction,
    input: {
      archiveId: string;
      workspace: WorkspaceRecord;
      archiveDate: string;
      sessionIds?: string[] | undefined;
      limits: ArchiveComponentLimits;
    }
  ): Promise<{ payloadRef: string; payloadBytes: number }> {
    const payloadRoot = this.#payloadRoot;
    if (!payloadRoot) {
      throw new Error("Postgres archive payload root is not configured.");
    }

    const payloadPath = archivePayloadPath(payloadRoot, input.archiveDate, input.archiveId);
    const tempPath = `${payloadPath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(payloadPath), { recursive: true });
    await rm(tempPath, { force: true });

    const writer = new JsonArchivePayloadWriter(tempPath);
    try {
      await writer.open();
      await writer.writeProperty("workspace", input.workspace);

      const sessionFilterIds = input.sessionIds?.length ? input.sessionIds : undefined;

      await this.#writePagedArchiveArray(
        writer,
        "sessions",
        input.limits.sessions,
        (offset, pageSize) =>
          sessionFilterIds
            ? tx
                .select()
                .from(sessions)
                .where(inArray(sessions.id, sessionFilterIds))
                .orderBy(desc(sessions.createdAt), asc(sessions.id))
                .limit(pageSize)
                .offset(offset)
            : tx
                .select()
                .from(sessions)
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(sessions.createdAt), asc(sessions.id))
                .limit(pageSize)
                .offset(offset),
        toSession
      );

      await this.#writePagedArchiveArray(
        writer,
        "runs",
        input.limits.runs,
        (offset, pageSize) =>
          sessionFilterIds
            ? tx
                .select()
                .from(runs)
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(runs.createdAt), asc(runs.id))
                .limit(pageSize)
                .offset(offset)
            : tx
                .select()
                .from(runs)
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(runs.createdAt), asc(runs.id))
                .limit(pageSize)
                .offset(offset),
        toRun
      );

      await this.#writePagedArchiveArray(
        writer,
        "messages",
        input.limits.messages,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ message: messages })
                .from(messages)
                .where(inArray(messages.sessionId, sessionFilterIds))
                .orderBy(desc(messages.createdAt), asc(messages.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ message: messages })
                .from(messages)
                .innerJoin(sessions, eq(messages.sessionId, sessions.id))
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(messages.createdAt), asc(messages.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.message);
        },
        toMessage
      );

      await this.#writePagedArchiveArray(
        writer,
        "engineMessages",
        input.limits.engineMessages,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ engineMessage: engineMessages })
                .from(engineMessages)
                .where(inArray(engineMessages.sessionId, sessionFilterIds))
                .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ engineMessage: engineMessages })
                .from(engineMessages)
                .innerJoin(sessions, eq(engineMessages.sessionId, sessions.id))
                .where(eq(sessions.workspaceId, input.workspace.id))
                .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.engineMessage);
        },
        toEngineMessageRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "runSteps",
        input.limits.runSteps,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ runStep: runSteps })
                .from(runSteps)
                .innerJoin(runs, eq(runSteps.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ runStep: runSteps })
                .from(runSteps)
                .innerJoin(runs, eq(runSteps.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.runStep);
        },
        toRunStep
      );

      await this.#writePagedArchiveArray(
        writer,
        "toolCalls",
        input.limits.toolCalls,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ toolCall: toolCalls })
                .from(toolCalls)
                .innerJoin(runs, eq(toolCalls.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ toolCall: toolCalls })
                .from(toolCalls)
                .innerJoin(runs, eq(toolCalls.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.toolCall);
        },
        toToolCallAuditRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "hookRuns",
        input.limits.hookRuns,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ hookRun: hookRuns })
                .from(hookRuns)
                .innerJoin(runs, eq(hookRuns.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ hookRun: hookRuns })
                .from(hookRuns)
                .innerJoin(runs, eq(hookRuns.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.hookRun);
        },
        toHookRunAuditRecord
      );

      await this.#writePagedArchiveArray(
        writer,
        "artifacts",
        input.limits.artifacts,
        async (offset, pageSize) => {
          const rows = sessionFilterIds
            ? await tx
                .select({ artifact: artifacts })
                .from(artifacts)
                .innerJoin(runs, eq(artifacts.runId, runs.id))
                .where(inArray(runs.sessionId, sessionFilterIds))
                .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
                .limit(pageSize)
                .offset(offset)
            : await tx
                .select({ artifact: artifacts })
                .from(artifacts)
                .innerJoin(runs, eq(artifacts.runId, runs.id))
                .where(eq(runs.workspaceId, input.workspace.id))
                .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
                .limit(pageSize)
                .offset(offset);
          return rows.map((row) => row.artifact);
        },
        toArtifactRecord
      );

      await writer.close();
      await rm(payloadPath, { force: true });
      await rename(tempPath, payloadPath);
      const payloadStat = await stat(payloadPath);
      return {
        payloadRef: payloadPath,
        payloadBytes: payloadStat.size
      };
    } catch (error) {
      await writer.destroy();
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  #archiveComponentLimits(): ArchiveComponentLimits {
    return {
      sessions: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_SESSIONS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.sessions
      ),
      runs: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUNS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.runs
      ),
      messages: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_MESSAGES",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.messages
      ),
      engineMessages: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUNTIME_MESSAGES",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.engineMessages
      ),
      runSteps: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_RUN_STEPS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.runSteps
      ),
      toolCalls: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_TOOL_CALLS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.toolCalls
      ),
      hookRuns: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_HOOK_RUNS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.hookRuns
      ),
      artifacts: resolvePostgresArchiveComponentLimit(
        "OAH_POSTGRES_ARCHIVE_MAX_ARTIFACTS",
        DEFAULT_POSTGRES_ARCHIVE_COMPONENT_LIMITS.artifacts
      )
    };
  }

  async #buildArchive(
    tx: OahTransaction,
    input: {
      workspace: WorkspaceRecord;
      scopeType: WorkspaceArchiveRecord["scopeType"];
      scopeId: string;
      archiveDate: string;
      archivedAt: string;
      deletedAt: string;
      timezone: string;
      sessionIds?: string[] | undefined;
    }
  ): Promise<WorkspaceArchiveRecord> {
    const archiveId = createId("warc");
    const limits = this.#archiveComponentLimits();

    if (this.#payloadRoot) {
      const payload = await this.#writeExternalArchivePayload(tx, {
        archiveId,
        workspace: input.workspace,
        archiveDate: input.archiveDate,
        ...(input.sessionIds ? { sessionIds: input.sessionIds } : {}),
        limits
      });

      return {
        id: archiveId,
        workspaceId: input.workspace.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        archiveDate: input.archiveDate,
        archivedAt: input.archivedAt,
        deletedAt: input.deletedAt,
        timezone: input.timezone,
        payloadRef: payload.payloadRef,
        payloadFormat: "json_v1",
        payloadBytes: payload.payloadBytes,
        workspace: input.workspace,
        sessions: [],
        runs: [],
        messages: [],
        engineMessages: [],
        runSteps: [],
        toolCalls: [],
        hookRuns: [],
        artifacts: []
      };
    }

    const sessionLimit = limits.sessions;
    const runLimit = limits.runs;
    const messageLimit = limits.messages;
    const engineMessageLimit = limits.engineMessages;
    const runStepLimit = limits.runSteps;
    const toolCallLimit = limits.toolCalls;
    const hookRunLimit = limits.hookRuns;
    const artifactLimit = limits.artifacts;

    const sessionRows =
      input.sessionIds && input.sessionIds.length > 0
        ? await tx
            .select()
            .from(sessions)
            .where(inArray(sessions.id, input.sessionIds))
            .orderBy(desc(sessions.createdAt), asc(sessions.id))
            .limit(sessionLimit + 1)
        : await tx
            .select()
            .from(sessions)
            .where(eq(sessions.workspaceId, input.workspace.id))
            .orderBy(desc(sessions.createdAt), asc(sessions.id))
            .limit(sessionLimit + 1);
    assertArchiveComponentLimit("sessions", sessionRows, sessionLimit, input);
    const sessionsForArchive = sessionRows.map(toSession);
    const sessionIds = sessionsForArchive.map((session) => session.id);

    const runRows =
      input.sessionIds && input.sessionIds.length > 0
        ? sessionIds.length > 0
          ? await tx
              .select()
              .from(runs)
              .where(inArray(runs.sessionId, sessionIds))
              .orderBy(desc(runs.createdAt), asc(runs.id))
              .limit(runLimit + 1)
          : []
        : await tx
            .select()
            .from(runs)
            .where(eq(runs.workspaceId, input.workspace.id))
            .orderBy(desc(runs.createdAt), asc(runs.id))
            .limit(runLimit + 1);
    assertArchiveComponentLimit("runs", runRows, runLimit, input);
    const runsForArchive = runRows.map(toRun);
    const runIds = runsForArchive.map((run) => run.id);

    const messageRows =
      sessionIds.length > 0
        ? await tx
            .select()
            .from(messages)
            .where(inArray(messages.sessionId, sessionIds))
            .orderBy(desc(messages.createdAt), asc(messages.id))
            .limit(messageLimit + 1)
        : [];
    assertArchiveComponentLimit("messages", messageRows, messageLimit, input);
    const messagesForArchive = messageRows.map(toMessage);

    const engineMessageRows =
      sessionIds.length > 0
        ? await tx
            .select()
            .from(engineMessages)
            .where(inArray(engineMessages.sessionId, sessionIds))
            .orderBy(desc(engineMessages.createdAt), asc(engineMessages.id))
            .limit(engineMessageLimit + 1)
        : [];
    assertArchiveComponentLimit("runtime_messages", engineMessageRows, engineMessageLimit, input);
    const engineMessagesForArchive = engineMessageRows.map(toEngineMessageRecord);

    const runStepRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(runSteps)
            .where(inArray(runSteps.runId, runIds))
            .orderBy(desc(runSteps.startedAt), desc(runSteps.endedAt), desc(runSteps.seq), asc(runSteps.id))
            .limit(runStepLimit + 1)
        : [];
    assertArchiveComponentLimit("run_steps", runStepRows, runStepLimit, input);
    const runStepsForArchive = runStepRows.map(toRunStep);

    const toolCallRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(toolCalls)
            .where(inArray(toolCalls.runId, runIds))
            .orderBy(desc(toolCalls.startedAt), asc(toolCalls.id))
            .limit(toolCallLimit + 1)
        : [];
    assertArchiveComponentLimit("tool_calls", toolCallRows, toolCallLimit, input);
    const toolCallsForArchive = toolCallRows.map(toToolCallAuditRecord);

    const hookRunRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(hookRuns)
            .where(inArray(hookRuns.runId, runIds))
            .orderBy(desc(hookRuns.startedAt), asc(hookRuns.id))
            .limit(hookRunLimit + 1)
        : [];
    assertArchiveComponentLimit("hook_runs", hookRunRows, hookRunLimit, input);
    const hookRunsForArchive = hookRunRows.map(toHookRunAuditRecord);

    const artifactRows =
      runIds.length > 0
        ? await tx
            .select()
            .from(artifacts)
            .where(inArray(artifacts.runId, runIds))
            .orderBy(desc(artifacts.createdAt), asc(artifacts.id))
            .limit(artifactLimit + 1)
        : [];
    assertArchiveComponentLimit("artifacts", artifactRows, artifactLimit, input);
    const artifactsForArchive = artifactRows.map(toArtifactRecord);

    return {
      id: archiveId,
      workspaceId: input.workspace.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      archiveDate: input.archiveDate,
      archivedAt: input.archivedAt,
      deletedAt: input.deletedAt,
      timezone: input.timezone,
      workspace: input.workspace,
      sessions: sessionsForArchive,
      runs: runsForArchive,
      messages: messagesForArchive,
      engineMessages: engineMessagesForArchive,
      runSteps: runStepsForArchive,
      toolCalls: toolCallsForArchive,
      hookRuns: hookRunsForArchive,
      artifacts: artifactsForArchive
    };
  }

  async archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return this.db.transaction(async (tx) => {
      const archive = await this.#buildArchive(tx, {
        ...input,
        scopeType: "workspace",
        scopeId: input.workspace.id
      });

      await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return archive;
    });
  }

  async archiveSessionTree(input: {
    workspace: WorkspaceRecord;
    rootSessionId: string;
    sessionIds: string[];
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return this.db.transaction(async (tx) => {
      const archive = await this.#buildArchive(tx, {
        workspace: input.workspace,
        scopeType: "session",
        scopeId: input.rootSessionId,
        sessionIds: input.sessionIds,
        archiveDate: input.archiveDate,
        archivedAt: input.archivedAt,
        deletedAt: input.deletedAt,
        timezone: input.timezone
      });

      await tx.insert(archives).values(buildWorkspaceArchiveRow(archive)).returning();
      return archive;
    });
  }

  async listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ archiveDate: archives.archiveDate })
      .from(archives)
      .where(and(sql`${archives.exportedAt} is null`, sql`${archives.archiveDate} < ${beforeArchiveDate}`))
      .orderBy(asc(archives.archiveDate))
      .limit(limit);

    return rows.map((row) => row.archiveDate);
  }

  async listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]> {
    const limit = resolvePostgresBoundedReadLimit("OAH_POSTGRES_ARCHIVE_DATE_READ_LIMIT", DEFAULT_POSTGRES_BOUNDED_READ_LIMIT);
    const rows = await this.db
      .select()
      .from(archives)
      .where(eq(archives.archiveDate, archiveDate))
      .orderBy(asc(archives.archivedAt), asc(archives.id))
      .limit(limit);

    return rows.map(toWorkspaceArchiveRecord);
  }

  async forEachByArchiveDate(
    archiveDate: string,
    visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
    options?: {
      pageSize?: number | undefined;
    }
  ): Promise<number> {
    const pageSize = Math.max(1, options?.pageSize ?? 4);
    let lastArchivedAt: string | undefined;
    let lastId: string | undefined;
    let count = 0;

    while (true) {
      const cursorFilter =
        lastArchivedAt && lastId
          ? or(gt(archives.archivedAt, lastArchivedAt), and(eq(archives.archivedAt, lastArchivedAt), gt(archives.id, lastId)))
          : undefined;
      const rows = await this.db
        .select()
        .from(archives)
        .where(cursorFilter ? and(eq(archives.archiveDate, archiveDate), cursorFilter) : eq(archives.archiveDate, archiveDate))
        .orderBy(asc(archives.archivedAt), asc(archives.id))
        .limit(pageSize);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        await visitor(toWorkspaceArchiveRecord(row));
        count += 1;
      }

      if (rows.length < pageSize) {
        break;
      }

      const lastRow = rows[rows.length - 1]!;
      lastArchivedAt = lastRow.archivedAt;
      lastId = lastRow.id;
    }

    return count;
  }

  async markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .update(archives)
      .set({
        exportedAt: input.exportedAt,
        exportPath: input.exportPath
      })
      .where(inArray(archives.id, ids));
  }

  async pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number> {
    if (limit <= 0) {
      return 0;
    }

    const victims = await this.db
      .select({ id: archives.id, payloadRef: archives.payloadRef })
      .from(archives)
      .where(and(sql`${archives.exportedAt} is not null`, sql`${archives.archiveDate} < ${beforeArchiveDate}`))
      .orderBy(asc(archives.archiveDate), asc(archives.archivedAt), asc(archives.id))
      .limit(limit);

    if (victims.length === 0) {
      return 0;
    }

    const deleted = await this.db
      .delete(archives)
      .where(inArray(archives.id, victims.map((row) => row.id)))
      .returning({ id: archives.id });

    await Promise.allSettled(
      victims
        .map((row) => row.payloadRef)
        .filter((payloadRef): payloadRef is string => typeof payloadRef === "string" && payloadRef.length > 0)
        .map((payloadRef) => rm(payloadRef, { force: true }))
    );

    return deleted.length;
  }
}
