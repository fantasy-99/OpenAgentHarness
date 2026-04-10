import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  HookRunAuditRecord,
  Message,
  Run,
  RunStep,
  RuntimeMessage,
  Session,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository
} from "@oah/runtime-core";
import { nowIso } from "@oah/runtime-core";

export interface WorkspaceArchiveExporterLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
  error?(message: string, error?: unknown): void;
}

export interface WorkspaceArchiveExporterOptions {
  repository: WorkspaceArchiveRepository;
  exportRoot: string;
  timeZone?: string | undefined;
  pollIntervalMs?: number | undefined;
  batchLimit?: number | undefined;
  logger?: WorkspaceArchiveExporterLogger | undefined;
}

const archiveSchemaStatements = [
  `create table if not exists archive_manifest (
    archive_date text primary key,
    timezone text not null,
    exported_at text not null,
    archive_count integer not null
  )`,
  `create table if not exists archives (
    archive_id text primary key,
    workspace_id text not null,
    scope_type text not null,
    scope_id text not null,
    archive_date text not null,
    archived_at text not null,
    deleted_at text not null,
    timezone text not null,
    exported_at text,
    export_path text,
    workspace_name text not null,
    root_path text not null,
    workspace_snapshot text not null
  )`,
  `create table if not exists sessions (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    subject_ref text not null,
    model_ref text,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at text,
    created_at text not null,
    updated_at text not null,
    payload text not null,
    primary key (archive_id, id)
  )`,
  `create table if not exists runs (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    session_id text,
    parent_run_id text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    status text not null,
    created_at text not null,
    started_at text,
    heartbeat_at text,
    ended_at text,
    payload text not null,
    primary key (archive_id, id)
  )`,
  `create table if not exists messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )`,
  `create table if not exists runtime_messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    kind text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )`,
  `create table if not exists run_steps (
    archive_id text not null,
    id text not null,
    run_id text not null,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    started_at text,
    ended_at text,
    input text,
    output text,
    primary key (archive_id, id)
  )`,
  `create table if not exists tool_calls (
    archive_id text not null,
    id text not null,
    run_id text not null,
    step_id text,
    source_type text not null,
    tool_name text not null,
    status text not null,
    duration_ms integer,
    started_at text not null,
    ended_at text not null,
    request text,
    response text,
    primary key (archive_id, id)
  )`,
  `create table if not exists hook_runs (
    archive_id text not null,
    id text not null,
    run_id text not null,
    hook_name text not null,
    event_name text not null,
    status text not null,
    started_at text not null,
    ended_at text not null,
    capabilities text not null,
    patch text,
    error_message text,
    primary key (archive_id, id)
  )`,
  `create table if not exists artifacts (
    archive_id text not null,
    id text not null,
    run_id text not null,
    type text not null,
    path text,
    content_ref text,
    created_at text not null,
    metadata text,
    primary key (archive_id, id)
  )`
] as const;

function resolveArchiveTimeZone(input?: string | undefined): string {
  return input?.trim() || process.env.OAH_ARCHIVE_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatArchiveDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function archiveExportDbPath(exportRoot: string, archiveDate: string): string {
  return path.join(exportRoot, `${archiveDate}.sqlite`);
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function applyArchiveSchema(db: DatabaseSync): void {
  for (const statement of archiveSchemaStatements) {
    db.exec(statement);
  }
}

function insertSessionRows(db: DatabaseSync, archiveId: string, sessions: Session[]): void {
  const statement = db.prepare(
    `insert or replace into sessions (
      archive_id, id, workspace_id, subject_ref, model_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at, payload
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const session of sessions) {
    statement.run(
      archiveId,
      session.id,
      session.workspaceId,
      session.subjectRef,
      session.modelRef ?? null,
      session.agentName ?? null,
      session.activeAgentName,
      session.title ?? null,
      session.status,
      session.lastRunAt ?? null,
      session.createdAt,
      session.updatedAt,
      jsonText(session)
    );
  }
}

function insertRunRows(db: DatabaseSync, archiveId: string, runs: Run[]): void {
  const statement = db.prepare(
    `insert or replace into runs (
      archive_id, id, workspace_id, session_id, parent_run_id, trigger_type, trigger_ref, agent_name, effective_agent_name, status, created_at, started_at, heartbeat_at, ended_at, payload
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const run of runs) {
    statement.run(
      archiveId,
      run.id,
      run.workspaceId,
      run.sessionId ?? null,
      run.parentRunId ?? null,
      run.triggerType,
      run.triggerRef ?? null,
      run.agentName ?? null,
      run.effectiveAgentName,
      run.status,
      run.createdAt,
      run.startedAt ?? null,
      run.heartbeatAt ?? null,
      run.endedAt ?? null,
      jsonText(run)
    );
  }
}

function insertMessageRows(db: DatabaseSync, archiveId: string, messages: Message[]): void {
  const statement = db.prepare(
    `insert or replace into messages (
      archive_id, id, session_id, run_id, role, created_at, content, metadata
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const message of messages) {
    statement.run(
      archiveId,
      message.id,
      message.sessionId,
      message.runId ?? null,
      message.role,
      message.createdAt,
      jsonText(message.content),
      message.metadata ? jsonText(message.metadata) : null
    );
  }
}

function insertRuntimeMessageRows(db: DatabaseSync, archiveId: string, runtimeMessages: RuntimeMessage[]): void {
  const statement = db.prepare(
    `insert or replace into runtime_messages (
      archive_id, id, session_id, run_id, role, kind, created_at, content, metadata
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const message of runtimeMessages) {
    statement.run(
      archiveId,
      message.id,
      message.sessionId,
      message.runId ?? null,
      message.role,
      message.kind,
      message.createdAt,
      jsonText(message.content),
      message.metadata ? jsonText(message.metadata) : null
    );
  }
}

function insertRunStepRows(db: DatabaseSync, archiveId: string, runSteps: RunStep[]): void {
  const statement = db.prepare(
    `insert or replace into run_steps (
      archive_id, id, run_id, seq, step_type, name, agent_name, status, started_at, ended_at, input, output
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const step of runSteps) {
    statement.run(
      archiveId,
      step.id,
      step.runId,
      step.seq,
      step.stepType,
      step.name ?? null,
      step.agentName ?? null,
      step.status,
      step.startedAt ?? null,
      step.endedAt ?? null,
      step.input !== undefined ? jsonText(step.input) : null,
      step.output !== undefined ? jsonText(step.output) : null
    );
  }
}

function insertToolCallRows(db: DatabaseSync, archiveId: string, toolCalls: ToolCallAuditRecord[]): void {
  const statement = db.prepare(
    `insert or replace into tool_calls (
      archive_id, id, run_id, step_id, source_type, tool_name, status, duration_ms, started_at, ended_at, request, response
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const toolCall of toolCalls) {
    statement.run(
      archiveId,
      toolCall.id,
      toolCall.runId,
      toolCall.stepId ?? null,
      toolCall.sourceType,
      toolCall.toolName,
      toolCall.status,
      toolCall.durationMs ?? null,
      toolCall.startedAt,
      toolCall.endedAt,
      toolCall.request ? jsonText(toolCall.request) : null,
      toolCall.response ? jsonText(toolCall.response) : null
    );
  }
}

function insertHookRunRows(db: DatabaseSync, archiveId: string, hookRuns: HookRunAuditRecord[]): void {
  const statement = db.prepare(
    `insert or replace into hook_runs (
      archive_id, id, run_id, hook_name, event_name, status, started_at, ended_at, capabilities, patch, error_message
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const hookRun of hookRuns) {
    statement.run(
      archiveId,
      hookRun.id,
      hookRun.runId,
      hookRun.hookName,
      hookRun.eventName,
      hookRun.status,
      hookRun.startedAt,
      hookRun.endedAt,
      jsonText(hookRun.capabilities),
      hookRun.patch ? jsonText(hookRun.patch) : null,
      hookRun.errorMessage ?? null
    );
  }
}

function insertArtifactRows(db: DatabaseSync, archiveId: string, artifacts: ArtifactRecord[]): void {
  const statement = db.prepare(
    `insert or replace into artifacts (
      archive_id, id, run_id, type, path, content_ref, created_at, metadata
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const artifact of artifacts) {
    statement.run(
      archiveId,
      artifact.id,
      artifact.runId,
      artifact.type,
      artifact.path ?? null,
      artifact.contentRef ?? null,
      artifact.createdAt,
      artifact.metadata ? jsonText(artifact.metadata) : null
    );
  }
}

function insertArchiveRows(db: DatabaseSync, archiveDate: string, exportPath: string, exportedAt: string, archives: WorkspaceArchiveRecord[]): void {
  db.prepare(
    `insert or replace into archive_manifest (archive_date, timezone, exported_at, archive_count)
     values (?, ?, ?, ?)`
  ).run(archiveDate, archives[0]?.timezone ?? "UTC", exportedAt, archives.length);

  const archiveStatement = db.prepare(
    `insert or replace into archives (
      archive_id, workspace_id, scope_type, scope_id, archive_date, archived_at, deleted_at, timezone, exported_at, export_path, workspace_name, root_path, workspace_snapshot
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const archive of archives) {
    archiveStatement.run(
      archive.id,
      archive.workspaceId,
      archive.scopeType,
      archive.scopeId,
      archive.archiveDate,
      archive.archivedAt,
      archive.deletedAt,
      archive.timezone,
      exportedAt,
      exportPath,
      archive.workspace.name,
      archive.workspace.rootPath,
      jsonText(archive.workspace)
    );

    insertSessionRows(db, archive.id, archive.sessions);
    insertRunRows(db, archive.id, archive.runs);
    insertMessageRows(db, archive.id, archive.messages);
    insertRuntimeMessageRows(db, archive.id, archive.runtimeMessages);
    insertRunStepRows(db, archive.id, archive.runSteps);
    insertToolCallRows(db, archive.id, archive.toolCalls);
    insertHookRunRows(db, archive.id, archive.hookRuns);
    insertArtifactRows(db, archive.id, archive.artifacts);
  }
}

export class WorkspaceArchiveExporter {
  readonly #repository: WorkspaceArchiveRepository;
  readonly #exportRoot: string;
  readonly #timeZone: string;
  readonly #pollIntervalMs: number;
  readonly #batchLimit: number;
  readonly #logger: WorkspaceArchiveExporterLogger;
  #activeExport: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: WorkspaceArchiveExporterOptions) {
    this.#repository = options.repository;
    this.#exportRoot = options.exportRoot;
    this.#timeZone = resolveArchiveTimeZone(options.timeZone);
    this.#pollIntervalMs = Math.max(60_000, options.pollIntervalMs ?? 15 * 60_000);
    this.#batchLimit = Math.max(1, options.batchLimit ?? 32);
    this.#logger = options.logger ?? {};
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.exportPending();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.exportPending();
  }

  async close(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    if (this.#activeExport) {
      try {
        await this.#activeExport;
      } catch {
        // Ignore background export failures during shutdown.
      }
    }
  }

  async exportPending(): Promise<void> {
    if (this.#activeExport) {
      return this.#activeExport;
    }

    const task = (async () => {
      const today = formatArchiveDate(nowIso(), this.#timeZone);
      const pendingArchiveDates = await this.#repository.listPendingArchiveDates(today, this.#batchLimit);
      for (const archiveDate of pendingArchiveDates) {
        await this.#exportArchiveDate(archiveDate);
      }
    })();

    this.#activeExport = task;
    try {
      await task;
    } finally {
      if (this.#activeExport === task) {
        this.#activeExport = undefined;
      }
    }
  }

  async #exportArchiveDate(archiveDate: string): Promise<void> {
    const archives = await this.#repository.listByArchiveDate(archiveDate);
    if (archives.length === 0) {
      return;
    }

    const exportPath = archiveExportDbPath(this.#exportRoot, archiveDate);
    const tempPath = `${exportPath}.tmp`;
    const exportedAt = nowIso();

    await mkdir(path.dirname(exportPath), { recursive: true });
    await rm(tempPath, { force: true });

    const db = new DatabaseSync(tempPath);
    try {
      applyArchiveSchema(db);
      db.exec("begin immediate");
      try {
        insertArchiveRows(db, archiveDate, exportPath, exportedAt, archives);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    } finally {
      db.close();
    }

    await rm(exportPath, { force: true });
    await rename(tempPath, exportPath);
    await this.#repository.markExported(
      archives.map((archive) => archive.id),
      {
        exportedAt,
        exportPath
      }
    );
    this.#logger.info?.(`Exported ${archives.length} workspace archives for ${archiveDate} to ${exportPath}.`);
  }
}
