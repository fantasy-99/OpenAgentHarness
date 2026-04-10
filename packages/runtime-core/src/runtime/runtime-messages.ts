import type { Message } from "@oah/api-contracts";
import type { SessionEvent } from "../types.js";

export const RUNTIME_MESSAGE_KINDS = [
  "system_note",
  "user_input",
  "assistant_text",
  "assistant_reasoning",
  "tool_call",
  "tool_result",
  "tool_approval_request",
  "tool_approval_response",
  "compact_boundary",
  "compact_summary",
  "runtime_reminder",
  "handoff_summary",
  "agent_switch_note"
] as const;

export type RuntimeMessageRole = Message["role"];
export type RuntimeMessageKind = (typeof RUNTIME_MESSAGE_KINDS)[number];

export interface RuntimeMessageMetadata extends Record<string, unknown> {
  runtimeKind?: RuntimeMessageKind | undefined;
  agentName?: string | undefined;
  effectiveAgentName?: string | undefined;
  synthetic?: boolean | undefined;
  visibleInTranscript?: boolean | undefined;
  eligibleForModelContext?: boolean | undefined;
  compactedAt?: string | undefined;
  compactBoundaryId?: string | undefined;
  summaryForBoundaryId?: string | undefined;
  source?: "user" | "runtime" | "hook" | "tool" | "system" | undefined;
  tags?: string[] | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface RuntimeMessage {
  id: string;
  sessionId: string;
  runId?: string | undefined;
  role: RuntimeMessageRole;
  kind: RuntimeMessageKind;
  content: Message["content"];
  createdAt: string;
  metadata?: RuntimeMessageMetadata | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRuntimeMessageKind(value: unknown): value is RuntimeMessageKind {
  return typeof value === "string" && (RUNTIME_MESSAGE_KINDS as readonly string[]).includes(value);
}

function normalizeRuntimeMessageMetadata(metadata: Message["metadata"]): RuntimeMessageMetadata | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const runtimeKind = isRuntimeMessageKind(metadata.runtimeKind) ? metadata.runtimeKind : undefined;
  const tags =
    Array.isArray(metadata.tags) && metadata.tags.every((value) => typeof value === "string")
      ? [...metadata.tags]
      : undefined;
  const extra = isRecord(metadata.extra) ? metadata.extra : undefined;

  return {
    ...metadata,
    ...(runtimeKind ? { runtimeKind } : {}),
    ...(typeof metadata.agentName === "string" ? { agentName: metadata.agentName } : {}),
    ...(typeof metadata.effectiveAgentName === "string"
      ? { effectiveAgentName: metadata.effectiveAgentName }
      : {}),
    ...(typeof metadata.synthetic === "boolean" ? { synthetic: metadata.synthetic } : {}),
    ...(typeof metadata.visibleInTranscript === "boolean"
      ? { visibleInTranscript: metadata.visibleInTranscript }
      : {}),
    ...(typeof metadata.eligibleForModelContext === "boolean"
      ? { eligibleForModelContext: metadata.eligibleForModelContext }
      : {}),
    ...(typeof metadata.compactedAt === "string" ? { compactedAt: metadata.compactedAt } : {}),
    ...(typeof metadata.compactBoundaryId === "string" ? { compactBoundaryId: metadata.compactBoundaryId } : {}),
    ...(typeof metadata.summaryForBoundaryId === "string" ? { summaryForBoundaryId: metadata.summaryForBoundaryId } : {}),
    ...(typeof metadata.source === "string" &&
    ["user", "runtime", "hook", "tool", "system"].includes(metadata.source)
      ? { source: metadata.source as RuntimeMessageMetadata["source"] }
      : {}),
    ...(tags ? { tags } : {}),
    ...(extra ? { extra } : {})
  };
}

function inferAssistantKind(content: Message["content"]): RuntimeMessageKind {
  if (typeof content === "string") {
    return "assistant_text";
  }

  if (content.some((part) => part.type === "tool-call")) {
    return "tool_call";
  }

  if (content.some((part) => part.type === "tool-approval-request")) {
    return "tool_approval_request";
  }

  if (content.some((part) => part.type === "reasoning")) {
    return "assistant_reasoning";
  }

  return "assistant_text";
}

function inferToolKind(content: Message["content"]): RuntimeMessageKind {
  if (Array.isArray(content) && content.some((part) => part.type === "tool-approval-response")) {
    return "tool_approval_response";
  }

  return "tool_result";
}

function inferRuntimeMessageKind(message: Message, metadata: RuntimeMessageMetadata | undefined): RuntimeMessageKind {
  if (metadata?.runtimeKind) {
    return metadata.runtimeKind;
  }

  switch (message.role) {
    case "system":
      return "system_note";
    case "user":
      return "user_input";
    case "assistant":
      return inferAssistantKind(message.content);
    case "tool":
      return inferToolKind(message.content);
  }
}

export function toRuntimeMessage(message: Message): RuntimeMessage {
  const metadata = normalizeRuntimeMessageMetadata(message.metadata);

  return {
    id: message.id,
    sessionId: message.sessionId,
    ...(message.runId ? { runId: message.runId } : {}),
    role: message.role,
    kind: inferRuntimeMessageKind(message, metadata),
    content: message.content,
    createdAt: message.createdAt,
    ...(metadata ? { metadata } : {})
  };
}

export function toRuntimeMessages(messages: Message[]): RuntimeMessage[] {
  return messages.map(toRuntimeMessage);
}

function readSessionEventCursorValue(event: SessionEvent): number {
  const numericCursor = Number.parseInt(event.cursor, 10);
  return Number.isFinite(numericCursor) ? numericCursor : Number.MAX_SAFE_INTEGER;
}

function readSessionEventMessageId(event: SessionEvent): string | undefined {
  return typeof event.data.messageId === "string" ? event.data.messageId : undefined;
}

export function doesSessionEventAffectRuntimeMessages(event: SessionEvent): boolean {
  return (
    event.event === "run.queued" ||
    event.event === "message.completed" ||
    event.event === "run.completed" ||
    event.event === "run.failed" ||
    event.event === "run.cancelled"
  );
}

export function filterSessionEventsForRuntimeMessages(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => doesSessionEventAffectRuntimeMessages(event) || event.event === "message.delta");
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return [part.text];
      }

      if (
        part.type === "tool-result" &&
        (part.output.type === "text" || part.output.type === "error-text")
      ) {
        return [part.output.value];
      }

      return [];
    })
    .join("\n\n");
}

function isStreamedAssistantTextMessage(message: Message, deltaMessageIds: Set<string>) {
  return message.role === "assistant" && deltaMessageIds.has(message.id) && contentText(message.content).trim().length > 0;
}

function buildSegmentRuntimeMessage(input: {
  sourceMessage: Message;
  segmentIndex: number;
  content: string;
  createdAt: string;
  startCursor?: string | undefined;
  endCursor?: string | undefined;
}): RuntimeMessage {
  const metadata = normalizeRuntimeMessageMetadata(input.sourceMessage.metadata);
  const nextExtra = {
    ...(metadata?.extra ?? {}),
    sourceMessageId: input.sourceMessage.id,
    segmentIndex: input.segmentIndex,
    ...(input.startCursor ? { startCursor: input.startCursor } : {}),
    ...(input.endCursor ? { endCursor: input.endCursor } : {})
  };

  return {
    id: `${input.sourceMessage.id}:segment:${input.segmentIndex}`,
    sessionId: input.sourceMessage.sessionId,
    ...(input.sourceMessage.runId ? { runId: input.sourceMessage.runId } : {}),
    role: "assistant",
    kind: "assistant_text",
    content: input.content,
    createdAt: input.createdAt,
    metadata: {
      ...(metadata ?? {}),
      runtimeKind: "assistant_text",
      extra: nextExtra
    }
  };
}

function projectRunRuntimeMessages(messages: Message[], events: SessionEvent[]): RuntimeMessage[] {
  if (messages.length === 0) {
    return [];
  }

  if (events.length === 0) {
    return toRuntimeMessages(messages);
  }

  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const deltaMessageIds = new Set(
    events.flatMap((event) =>
      event.event === "message.delta" ? [readSessionEventMessageId(event)].filter((value): value is string => Boolean(value)) : []
    )
  );
  const projected: RuntimeMessage[] = [];
  const seenRuntimeMessageIds = new Set<string>();
  const segmentCounts = new Map<string, number>();
  const activeSegments = new Map<
    string,
    {
      index: number;
      content: string;
      createdAt: string;
      startCursor: string;
      endCursor: string;
    }
  >();

  const pushRuntimeMessage = (message: RuntimeMessage) => {
    if (seenRuntimeMessageIds.has(message.id)) {
      return;
    }

    seenRuntimeMessageIds.add(message.id);
    projected.push(message);
  };

  const flushSegment = (messageId: string) => {
    const activeSegment = activeSegments.get(messageId);
    const sourceMessage = messagesById.get(messageId);
    if (!activeSegment || !sourceMessage || activeSegment.content.trim().length === 0) {
      activeSegments.delete(messageId);
      return;
    }

    pushRuntimeMessage(
      buildSegmentRuntimeMessage({
        sourceMessage,
        segmentIndex: activeSegment.index,
        content: activeSegment.content,
        createdAt: activeSegment.createdAt,
        startCursor: activeSegment.startCursor,
        endCursor: activeSegment.endCursor
      })
    );
    activeSegments.delete(messageId);
  };

  const flushAllSegments = () => {
    for (const messageId of [...activeSegments.keys()].sort((left, right) => left.localeCompare(right))) {
      flushSegment(messageId);
    }
  };

  for (const event of events) {
    const messageId = readSessionEventMessageId(event);

    if (event.event === "message.delta" && messageId && messagesById.has(messageId)) {
      const existingSegment = activeSegments.get(messageId);
      if (existingSegment) {
        existingSegment.content += typeof event.data.delta === "string" ? event.data.delta : "";
        existingSegment.endCursor = event.cursor;
        continue;
      }

      const nextIndex = (segmentCounts.get(messageId) ?? 0) + 1;
      segmentCounts.set(messageId, nextIndex);
      activeSegments.set(messageId, {
        index: nextIndex,
        content: typeof event.data.delta === "string" ? event.data.delta : "",
        createdAt: event.createdAt,
        startCursor: event.cursor,
        endCursor: event.cursor
      });
      continue;
    }

    if (event.event === "message.completed" && messageId && messagesById.has(messageId)) {
      for (const activeMessageId of [...activeSegments.keys()]) {
        if (activeMessageId !== messageId) {
          flushSegment(activeMessageId);
        }
      }

      const sourceMessage = messagesById.get(messageId);
      if (!sourceMessage) {
        continue;
      }

      if (isStreamedAssistantTextMessage(sourceMessage, deltaMessageIds)) {
        if (activeSegments.has(messageId)) {
          const activeSegment = activeSegments.get(messageId);
          if (activeSegment) {
            activeSegment.endCursor = event.cursor;
          }
          flushSegment(messageId);
        } else {
          const nextIndex = (segmentCounts.get(messageId) ?? 0) + 1;
          segmentCounts.set(messageId, nextIndex);
          pushRuntimeMessage(
            buildSegmentRuntimeMessage({
              sourceMessage,
              segmentIndex: nextIndex,
              content: contentText(sourceMessage.content),
              createdAt: sourceMessage.createdAt,
              endCursor: event.cursor
            })
          );
        }
        continue;
      }

      pushRuntimeMessage(toRuntimeMessage(sourceMessage));
      continue;
    }

    if (event.event === "run.completed" || event.event === "run.failed" || event.event === "run.cancelled") {
      flushAllSegments();
    }
  }

  flushAllSegments();

  for (const message of messages) {
    if (seenRuntimeMessageIds.has(message.id) || isStreamedAssistantTextMessage(message, deltaMessageIds)) {
      continue;
    }

    pushRuntimeMessage(toRuntimeMessage(message));
  }

  return projected;
}

export function buildSessionRuntimeMessages(params: {
  messages: Message[];
  events: SessionEvent[];
}): RuntimeMessage[] {
  const orderedMessages = [...params.messages].sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return left.id.localeCompare(right.id);
  });
  const orderedEvents = [...filterSessionEventsForRuntimeMessages(params.events)].sort(
    (left, right) => readSessionEventCursorValue(left) - readSessionEventCursorValue(right)
  );
  const eventsByRunId = new Map<string, SessionEvent[]>();
  const messagesByRunId = new Map<string, Message[]>();

  for (const event of orderedEvents) {
    if (!event.runId) {
      continue;
    }

    const current = eventsByRunId.get(event.runId) ?? [];
    current.push(event);
    eventsByRunId.set(event.runId, current);
  }

  for (const message of orderedMessages) {
    if (!message.runId) {
      continue;
    }

    const current = messagesByRunId.get(message.runId) ?? [];
    current.push(message);
    messagesByRunId.set(message.runId, current);
  }

  const projectedRuns = new Map<string, RuntimeMessage[]>();
  for (const [runId, runMessages] of messagesByRunId) {
    projectedRuns.set(runId, projectRunRuntimeMessages(runMessages, eventsByRunId.get(runId) ?? []));
  }

  const seenRunIds = new Set<string>();
  const projected: RuntimeMessage[] = [];
  for (const message of orderedMessages) {
    if (!message.runId) {
      projected.push(toRuntimeMessage(message));
      continue;
    }

    if (seenRunIds.has(message.runId)) {
      continue;
    }

    seenRunIds.add(message.runId);
    projected.push(...(projectedRuns.get(message.runId) ?? [toRuntimeMessage(message)]));
  }

  return projected;
}
