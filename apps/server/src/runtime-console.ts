import path from "node:path";
import { stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type {
  RuntimeLogCategory,
  RuntimeLogEventContext,
  RuntimeLogEventData,
  RuntimeLogLevel
} from "@oah/api-contracts";
import { runtimeLogEventDataSchema } from "@oah/api-contracts";
import type {
  RuntimeLogger,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";

const localSessionEventSchemaStatements = [
  `create table if not exists session_events (
    id text primary key,
    session_id text not null,
    run_id text,
    cursor integer not null,
    created_at text not null,
    payload text not null
  )`,
  `create unique index if not exists session_events_session_cursor_idx on session_events (session_id, cursor)`,
  `create index if not exists session_events_session_run_cursor_idx on session_events (session_id, run_id, cursor)`
] as const;

const sensitiveKeyPattern = /(^|_)(authorization|token|api_?key|secret|password)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitiveDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveDetails(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[redacted]" : redactSensitiveDetails(nestedValue)
    ])
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveRuntimeLogCategory(message: string, details: Record<string, unknown> | undefined): RuntimeLogCategory {
  const detailCategory = readString(details?.category);
  if (
    detailCategory === "run" ||
    detailCategory === "model" ||
    detailCategory === "tool" ||
    detailCategory === "hook" ||
    detailCategory === "agent" ||
    detailCategory === "http" ||
    detailCategory === "system"
  ) {
    return detailCategory;
  }

  if (readString(details?.toolName) || readString(details?.toolCallId) || /tool/iu.test(message)) {
    return "tool";
  }

  if (readString(details?.hookName) || /hook/iu.test(message)) {
    return "hook";
  }

  if (readString(details?.provider) || readString(details?.canonicalModelRef) || /model/iu.test(message)) {
    return "model";
  }

  if (readString(details?.agentName) || /agent/iu.test(message)) {
    return "agent";
  }

  if (details && ("status" in details || "errorCode" in details || "runId" in details)) {
    return "run";
  }

  return "system";
}

function resolveRuntimeLogContext(details: Record<string, unknown> | undefined): RuntimeLogEventContext | undefined {
  if (!details) {
    return undefined;
  }

  const context = {
    ...(readString(details.workspaceId) ? { workspaceId: readString(details.workspaceId) } : {}),
    ...(readString(details.sessionId) ? { sessionId: readString(details.sessionId) } : {}),
    ...(readString(details.runId) ? { runId: readString(details.runId) } : {}),
    ...(readString(details.stepId) ? { stepId: readString(details.stepId) } : {}),
    ...(readString(details.toolCallId) ? { toolCallId: readString(details.toolCallId) } : {}),
    ...(readString(details.agentName) ? { agentName: readString(details.agentName) } : {})
  };

  return Object.keys(context).length > 0 ? context : undefined;
}

function buildRuntimeLogEventData(input: {
  level: RuntimeLogLevel;
  category: RuntimeLogCategory;
  message: string;
  details?: unknown;
  context?: RuntimeLogEventContext | undefined;
  source: "server" | "web";
  timestamp: string;
}): RuntimeLogEventData {
  return runtimeLogEventDataSchema.parse({
    level: input.level,
    category: input.category,
    message: input.message,
    ...(input.details !== undefined ? { details: redactSensitiveDetails(input.details) } : {}),
    ...(input.context ? { context: input.context } : {}),
    source: input.source,
    timestamp: input.timestamp
  });
}

export async function appendRuntimeLogEvent(
  sessionEventStore: SessionEventStore,
  input: {
    sessionId: string;
    runId?: string | undefined;
    level: RuntimeLogLevel;
    category: RuntimeLogCategory;
    message: string;
    details?: unknown;
    context?: RuntimeLogEventContext | undefined;
    timestamp: string;
  }
): Promise<void> {
  const data = buildRuntimeLogEventData({
    level: input.level,
    category: input.category,
    message: input.message,
    details: input.details,
    context: {
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.context ?? {})
    },
    source: "server",
    timestamp: input.timestamp
  });

  await sessionEventStore.append({
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    event: "runtime.log",
    data
  });
}

export function buildRuntimeConsoleLogger(options: {
  enabled: boolean;
  echoToStdout?: boolean | undefined;
  sessionEventStore?: SessionEventStore | undefined;
  now: () => string;
}): RuntimeLogger | undefined {
  if (!options.enabled) {
    return undefined;
  }

  const emit = (level: RuntimeLogLevel, message: string, details?: Record<string, unknown>) => {
    const sanitizedDetails = details ? (redactSensitiveDetails(details) as Record<string, unknown>) : undefined;
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;

    if (options.echoToStdout !== false) {
      if (sanitizedDetails) {
        consoleMethod(`[oah-runtime-debug] ${message}`, sanitizedDetails);
      } else {
        consoleMethod(`[oah-runtime-debug] ${message}`);
      }
    }

    const sessionId = readString(sanitizedDetails?.sessionId);
    if (!sessionId || !options.sessionEventStore) {
      return;
    }

    void appendRuntimeLogEvent(options.sessionEventStore, {
      sessionId,
      ...(readString(sanitizedDetails?.runId) ? { runId: readString(sanitizedDetails?.runId) } : {}),
      level,
      category: resolveRuntimeLogCategory(message, sanitizedDetails),
      message,
      details: sanitizedDetails,
      context: resolveRuntimeLogContext(sanitizedDetails),
      timestamp: options.now()
    }).catch((error) => {
      console.error(
        `[oah-runtime-debug] Failed to append runtime.log for session ${sessionId}.`,
        error
      );
    });
  };

  return {
    debug(message, details) {
      emit("debug", message, details);
    },
    warn(message, details) {
      emit("warn", message, details);
    },
    error(message, details) {
      emit("error", message, details);
    }
  };
}

async function ensureLocalSessionEventSchema(dbPath: string): Promise<void> {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of localSessionEventSchemaStatements) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

async function appendPersistedSessionEventToHistoryDb(workspace: WorkspaceRecord, event: SessionEvent): Promise<void> {
  const dbPath = path.join(workspace.rootPath, ".openharness", "data", "history.db");
  await ensureLocalSessionEventSchema(dbPath);

  const db = new DatabaseSync(dbPath);
  try {
    const cursor = Number.parseInt(event.cursor, 10);
    if (!Number.isFinite(cursor) || cursor < 0) {
      throw new Error(`Invalid session event cursor "${event.cursor}" for event ${event.id}.`);
    }

    db.prepare(
      `insert or replace into session_events (id, session_id, run_id, cursor, created_at, payload)
       values (?, ?, ?, ?, ?, ?)`
    ).run(event.id, event.sessionId, event.runId ?? null, cursor, event.createdAt, JSON.stringify(event));
  } finally {
    db.close();
  }
}

async function isLocalWorkspaceHistoryWritable(workspace: WorkspaceRecord): Promise<boolean> {
  try {
    return (await stat(workspace.rootPath)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveLocalWorkspaceForEvent(
  sessionRepository: SessionRepository,
  workspaceRepository: WorkspaceRepository,
  sessionId: string
): Promise<WorkspaceRecord | null> {
  const session = await sessionRepository.getById(sessionId);
  if (!session) {
    return null;
  }

  const workspace = await workspaceRepository.getById(session.workspaceId);
  if (!workspace || workspace.kind !== "project") {
    return null;
  }

  return workspace;
}

export class DualWriteSessionEventStore implements SessionEventStore {
  readonly #primary: SessionEventStore;
  readonly #sessionRepository: SessionRepository;
  readonly #workspaceRepository: WorkspaceRepository;
  readonly #logger:
    | {
        warn?(message: string, error?: unknown): void;
      }
    | undefined;

  constructor(options: {
    primary: SessionEventStore;
    sessionRepository: SessionRepository;
    workspaceRepository: WorkspaceRepository;
    logger?:
      | {
          warn?(message: string, error?: unknown): void;
        }
      | undefined;
  }) {
    this.#primary = options.primary;
    this.#sessionRepository = options.sessionRepository;
    this.#workspaceRepository = options.workspaceRepository;
    this.#logger = options.logger;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#primary.append(input);
    const workspace = await resolveLocalWorkspaceForEvent(this.#sessionRepository, this.#workspaceRepository, input.sessionId);

    if (!workspace) {
      return event;
    }

    if (!(await isLocalWorkspaceHistoryWritable(workspace))) {
      return event;
    }

    try {
      await appendPersistedSessionEventToHistoryDb(workspace, event);
    } catch (error) {
      this.#logger?.warn?.(
        `Failed to mirror session event ${event.id} to ${workspace.id} history.db; continuing with central event only.`,
        error
      );
    }

    return event;
  }

  async deleteById(eventId: string): Promise<void> {
    await this.#primary.deleteById(eventId);
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    return this.#primary.listSince(sessionId, cursor, runId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    return this.#primary.subscribe(sessionId, listener);
  }
}

export function normalizeRuntimeLogDetails(details: unknown): unknown {
  return redactSensitiveDetails(details);
}

export function buildHttpErrorRuntimeLogContext(input: {
  sessionId: string;
  runId?: string | undefined;
  workspaceId?: string | undefined;
}): RuntimeLogEventContext {
  return {
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
  };
}

export type { RuntimeLogEventData };
