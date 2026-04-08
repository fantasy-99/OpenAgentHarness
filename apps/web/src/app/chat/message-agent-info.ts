import type { Message, Run, RunStep, Session, SessionEventContract, WorkspaceCatalog } from "@oah/api-contracts";

import { readMessageAgentSnapshot, type AgentMode } from "../support";

export interface MessageAgentInfo {
  name: string;
  mode?: AgentMode;
}

interface ResolveMessageAgentInfoParams {
  message: Message;
  catalog: WorkspaceCatalog | null | undefined;
  runSteps: RunStep[];
  run: Run | null;
  session: Session | null;
  sessionEvents: SessionEventContract[];
}

function readEventCursorValue(cursor: string) {
  const numericCursor = Number.parseInt(cursor, 10);
  return Number.isFinite(numericCursor) ? numericCursor : Number.MAX_SAFE_INTEGER;
}

function resolveUnderlyingMessageId(messageId: string) {
  if (messageId.startsWith("live:")) {
    return messageId.slice("live:".length);
  }

  if (messageId.startsWith("segment:")) {
    const parts = messageId.split(":");
    if (parts.length >= 3) {
      return parts.slice(1, -1).join(":");
    }
  }

  return messageId;
}

function resolveAgentNameFromEvents(message: Message, events: SessionEventContract[]) {
  if (!message.runId) {
    return undefined;
  }

  const runEvents = events.filter((event) => event.runId === message.runId);
  if (runEvents.length === 0) {
    return undefined;
  }

  const switchEvents = runEvents
    .filter(
      (event): event is SessionEventContract & { data: { toAgent: string } } =>
        event.event === "agent.switched" && typeof event.data.toAgent === "string" && event.data.toAgent.trim().length > 0
    )
    .sort((left, right) => readEventCursorValue(left.cursor) - readEventCursorValue(right.cursor));

  if (switchEvents.length === 0) {
    return undefined;
  }

  const sourceMessageId = resolveUnderlyingMessageId(message.id);
  const deltaEvents = runEvents
    .filter(
      (event): event is SessionEventContract & { data: { messageId: string } } =>
        event.event === "message.delta" && typeof event.data.messageId === "string" && event.data.messageId === sourceMessageId
    )
    .sort((left, right) => readEventCursorValue(left.cursor) - readEventCursorValue(right.cursor));

  const anchorEvent =
    deltaEvents[0] ??
    runEvents.find(
      (event) => event.event === "message.completed" && typeof event.data.messageId === "string" && event.data.messageId === sourceMessageId
    );

  if (!anchorEvent) {
    return switchEvents.at(-1)?.data.toAgent;
  }

  const anchorCursor = readEventCursorValue(anchorEvent.cursor);
  for (let index = switchEvents.length - 1; index >= 0; index -= 1) {
    const event = switchEvents[index];
    if (event && readEventCursorValue(event.cursor) <= anchorCursor) {
      return event.data.toAgent;
    }
  }

  return undefined;
}

export function resolveMessageAgentInfo(params: ResolveMessageAgentInfoParams): MessageAgentInfo | null {
  const { message, catalog, runSteps, run, session, sessionEvents } = params;
  if (message.role !== "assistant" && message.role !== "tool") {
    return null;
  }

  const agentModeByName = new Map((catalog?.agents ?? []).map((agent) => [agent.name, agent.mode]));
  const snapshot = readMessageAgentSnapshot(message);
  const eventAgentName = resolveAgentNameFromEvents(message, sessionEvents);
  const latestStepForMessageRun =
    message.runId
      ? [...runSteps]
          .reverse()
          .find((step) => step.runId === message.runId && typeof step.agentName === "string" && step.agentName.trim())
      : undefined;

  const agentName =
    snapshot?.name ??
    eventAgentName ??
    latestStepForMessageRun?.agentName ??
    (message.runId && run?.id === message.runId ? run.effectiveAgentName ?? run.agentName : undefined) ??
    session?.activeAgentName ??
    undefined;

  if (!agentName) {
    return null;
  }

  const mode = snapshot?.mode ?? agentModeByName.get(agentName);
  return {
    name: agentName,
    ...(mode ? { mode } : {})
  };
}
