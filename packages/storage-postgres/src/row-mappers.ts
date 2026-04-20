import type {
  ArtifactRecord,
  HistoryEventEntityType,
  HistoryEventOperation,
  HistoryEventRecord,
  HookRunAuditRecord,
  Message,
  EngineMessage,
  Run,
  RunStep,
  Session,
  SessionEvent,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceRecord
} from "@oah/engine-core";
import { isMessageContentForRole, isMessageRole, isEngineMessageKind } from "@oah/engine-core";
import { eq } from "drizzle-orm";
import type { OahExecutor } from "./schema.js";
import {
  archives,
  artifacts,
  historyEvents,
  hookRuns,
  messages,
  runSteps,
  runs,
  engineMessages,
  sessionEvents,
  sessions,
  toolCalls,
  workspaces
} from "./schema.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMessage(input: {
  id: string;
  sessionId: string;
  runId?: string | undefined;
  role: unknown;
  content: unknown;
  metadata?: unknown;
  createdAt: string;
}): Message {
  const role: Message["role"] = isMessageRole(input.role) ? input.role : "assistant";
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt
  };

  switch (role) {
    case "system":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "user":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "assistant":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : ""
      };
    case "tool":
      return {
        ...base,
        role,
        content: isMessageContentForRole(role, input.content) ? input.content : []
      };
  }
}

export function nonNull<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

export function expectRow<T>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`Expected row for ${label}.`);
  }

  return value;
}

export function normalizeTimestamp(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

export function buildWorkspaceRow(input: WorkspaceRecord) {
  return {
    id: input.id,
    externalRef: input.externalRef ?? null,
    ownerId: input.ownerId ?? null,
    serviceName: input.serviceName ?? null,
    name: input.name,
    rootPath: input.rootPath,
    executionPolicy: input.executionPolicy,
    status: input.status,
    kind: input.kind,
    readOnly: input.readOnly,
    historyMirrorEnabled: input.historyMirrorEnabled,
    defaultAgent: input.defaultAgent ?? null,
    projectAgentsMd: input.projectAgentsMd ?? null,
    settings: input.settings,
    workspaceModels: input.workspaceModels,
    agents: input.agents,
    actions: input.actions,
    skills: input.skills,
    toolServers: input.toolServers,
    hooks: input.hooks,
    catalog: input.catalog,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function toWorkspaceRecord(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  const toolServers = row.toolServers ?? {};

  return {
    id: row.id,
    ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    ...(row.serviceName ? { serviceName: row.serviceName } : {}),
    name: row.name,
    rootPath: row.rootPath,
    executionPolicy: row.executionPolicy as WorkspaceRecord["executionPolicy"],
    status: row.status as WorkspaceRecord["status"],
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt,
    kind: row.kind as WorkspaceRecord["kind"],
    readOnly: row.readOnly,
    historyMirrorEnabled: row.historyMirrorEnabled,
    ...(row.defaultAgent ? { defaultAgent: row.defaultAgent } : {}),
    ...(row.projectAgentsMd ? { projectAgentsMd: row.projectAgentsMd } : {}),
    settings: row.settings,
    workspaceModels: row.workspaceModels,
    agents: row.agents,
    actions: row.actions,
    skills: row.skills,
    toolServers,
    hooks: row.hooks,
    catalog: row.catalog
  };
}

export function buildSessionRow(input: Session) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    parentSessionId: input.parentSessionId ?? null,
    subjectRef: input.subjectRef,
    modelRef: input.modelRef ?? null,
    agentName: input.agentName ?? null,
    activeAgentName: input.activeAgentName,
    title: input.title ?? null,
    status: input.status,
    lastRunAt: input.lastRunAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
    subjectRef: row.subjectRef,
    ...(row.modelRef ? { modelRef: row.modelRef } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    activeAgentName: row.activeAgentName,
    ...(row.title ? { title: row.title } : {}),
    status: row.status as Session["status"],
    ...(row.lastRunAt ? { lastRunAt: normalizeTimestamp(row.lastRunAt) ?? row.lastRunAt } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: normalizeTimestamp(row.updatedAt) ?? row.updatedAt
  };
}

export function buildMessageRow(input: Message) {
  return {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    content: input.content,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

export function toMessage(row: typeof messages.$inferSelect): Message {
  return createMessage({
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? undefined,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  });
}

export function buildEngineMessageRow(input: EngineMessage) {
  return {
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    kind: input.kind,
    content: input.content,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

export function toEngineMessageRecord(row: typeof engineMessages.$inferSelect): EngineMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    role: isMessageRole(row.role) ? row.role : "assistant",
    kind: isEngineMessageKind(row.kind) ? row.kind : "assistant_text",
    content: row.content,
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

export function buildRunRow(input: Run) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId ?? null,
    parentRunId: input.parentRunId ?? null,
    initiatorRef: input.initiatorRef ?? null,
    triggerType: input.triggerType,
    triggerRef: input.triggerRef ?? null,
    agentName: input.agentName ?? null,
    effectiveAgentName: input.effectiveAgentName,
    switchCount: input.switchCount ?? null,
    status: input.status,
    cancelRequestedAt: input.cancelRequestedAt ?? null,
    startedAt: input.startedAt ?? null,
    heartbeatAt: input.heartbeatAt ?? null,
    endedAt: input.endedAt ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

export function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    ...(row.initiatorRef ? { initiatorRef: row.initiatorRef } : {}),
    triggerType: row.triggerType as Run["triggerType"],
    ...(row.triggerRef ? { triggerRef: row.triggerRef } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    effectiveAgentName: row.effectiveAgentName,
    ...(row.switchCount !== null ? { switchCount: row.switchCount } : {}),
    status: row.status as Run["status"],
    ...(row.cancelRequestedAt ? { cancelRequestedAt: normalizeTimestamp(row.cancelRequestedAt) ?? row.cancelRequestedAt } : {}),
    ...(row.startedAt ? { startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt } : {}),
    ...(row.heartbeatAt ? { heartbeatAt: normalizeTimestamp(row.heartbeatAt) ?? row.heartbeatAt } : {}),
    ...(row.endedAt ? { endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {})
  };
}

export function buildRunStepRow(input: RunStep) {
  return {
    id: input.id,
    runId: input.runId,
    seq: input.seq,
    stepType: input.stepType,
    name: input.name ?? null,
    agentName: input.agentName ?? null,
    status: input.status,
    input: input.input ?? null,
    output: input.output ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null
  };
}

export function toRunStep(row: typeof runSteps.$inferSelect): RunStep {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    stepType: row.stepType as RunStep["stepType"],
    ...(row.name ? { name: row.name } : {}),
    ...(row.agentName ? { agentName: row.agentName } : {}),
    status: row.status as RunStep["status"],
    ...(row.input ? { input: row.input } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.startedAt ? { startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt } : {}),
    ...(row.endedAt ? { endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt } : {})
  };
}

export function toSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    cursor: String(row.cursor),
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    event: row.event as SessionEvent["event"],
    data: row.data,
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

export function buildToolCallRow(input: ToolCallAuditRecord) {
  return {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId ?? null,
    sourceType: input.sourceType,
    toolName: input.toolName,
    request: input.request ?? null,
    response: input.response ?? null,
    status: input.status,
    durationMs: input.durationMs ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt
  };
}

export function buildHookRunRow(input: HookRunAuditRecord) {
  return {
    id: input.id,
    runId: input.runId,
    hookName: input.hookName,
    eventName: input.eventName,
    capabilities: input.capabilities,
    patch: input.patch ?? null,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    errorMessage: input.errorMessage ?? null
  };
}

export function toToolCallAuditRecord(row: typeof toolCalls.$inferSelect): ToolCallAuditRecord {
  return {
    id: row.id,
    runId: row.runId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    sourceType: row.sourceType as ToolCallAuditRecord["sourceType"],
    toolName: row.toolName,
    ...(row.request ? { request: row.request } : {}),
    ...(row.response ? { response: row.response } : {}),
    status: row.status as ToolCallAuditRecord["status"],
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt,
    endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt
  };
}

export function toHookRunAuditRecord(row: typeof hookRuns.$inferSelect): HookRunAuditRecord {
  return {
    id: row.id,
    runId: row.runId,
    hookName: row.hookName,
    eventName: row.eventName,
    capabilities: row.capabilities,
    ...(row.patch ? { patch: row.patch } : {}),
    status: row.status as HookRunAuditRecord["status"],
    startedAt: normalizeTimestamp(row.startedAt) ?? row.startedAt,
    endedAt: normalizeTimestamp(row.endedAt) ?? row.endedAt,
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {})
  };
}

export function buildArtifactRow(input: ArtifactRecord) {
  return {
    id: input.id,
    runId: input.runId,
    type: input.type,
    path: input.path ?? null,
    contentRef: input.contentRef ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt
  };
}

export function toArtifactRecord(row: typeof artifacts.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    type: row.type,
    ...(row.path ? { path: row.path } : {}),
    ...(row.contentRef ? { contentRef: row.contentRef } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    createdAt: normalizeTimestamp(row.createdAt) ?? row.createdAt
  };
}

export function toHistoryEventRecord(row: typeof historyEvents.$inferSelect): HistoryEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityType: row.entityType as HistoryEventEntityType,
    entityId: row.entityId,
    op: row.op as HistoryEventOperation,
    payload: row.payload,
    occurredAt: normalizeTimestamp(row.occurredAt) ?? row.occurredAt
  };
}

export function buildWorkspaceArchiveRow(input: WorkspaceArchiveRecord) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    archiveDate: input.archiveDate,
    archivedAt: input.archivedAt,
    deletedAt: input.deletedAt,
    timezone: input.timezone,
    exportedAt: input.exportedAt ?? null,
    exportPath: input.exportPath ?? null,
    workspace: input.workspace,
    sessions: input.sessions,
    runs: input.runs,
    messages: input.messages,
    engineMessages: input.engineMessages,
    runSteps: input.runSteps,
    toolCalls: input.toolCalls,
    hookRuns: input.hookRuns,
    artifacts: input.artifacts
  };
}

export function toWorkspaceArchiveRecord(row: typeof archives.$inferSelect): WorkspaceArchiveRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeType: row.scopeType as WorkspaceArchiveRecord["scopeType"],
    scopeId: row.scopeId,
    archiveDate: row.archiveDate,
    archivedAt: normalizeTimestamp(row.archivedAt) ?? row.archivedAt,
    deletedAt: normalizeTimestamp(row.deletedAt) ?? row.deletedAt,
    timezone: row.timezone,
    ...(row.exportedAt ? { exportedAt: normalizeTimestamp(row.exportedAt) ?? row.exportedAt } : {}),
    ...(row.exportPath ? { exportPath: row.exportPath } : {}),
    workspace: row.workspace,
    sessions: row.sessions,
    runs: row.runs,
    messages: row.messages,
    engineMessages: row.engineMessages,
    runSteps: row.runSteps,
    toolCalls: row.toolCalls,
    hookRuns: row.hookRuns,
    artifacts: row.artifacts
  };
}

export async function resolveWorkspaceIdForSession(db: OahExecutor, sessionId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: sessions.workspaceId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return expectRow(row, `workspace for session ${sessionId}`).workspaceId;
}

export async function resolveWorkspaceIdForRun(db: OahExecutor, runId: string): Promise<string> {
  const [row] = await db.select({ workspaceId: runs.workspaceId }).from(runs).where(eq(runs.id, runId)).limit(1);
  return expectRow(row, `workspace for run ${runId}`).workspaceId;
}

export async function appendHistoryEventRecord(
  db: OahExecutor,
  input: Omit<HistoryEventRecord, "id">
): Promise<HistoryEventRecord> {
  const [row] = await db
    .insert(historyEvents)
    .values({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      payload: input.payload,
      occurredAt: input.occurredAt
    })
    .returning();

  return toHistoryEventRecord(expectRow(row, `history event ${input.entityType}:${input.entityId}`));
}

export async function appendHistoryDeleteEvents(
  db: OahExecutor,
  workspaceId: string,
  entities: Array<{ entityType: HistoryEventEntityType; entityId: string }>,
  occurredAt: string
): Promise<void> {
  for (const entity of entities) {
    await appendHistoryEventRecord(db, {
      workspaceId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      op: "delete",
      payload: {},
      occurredAt
    });
  }
}
