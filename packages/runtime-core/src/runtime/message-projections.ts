import type { Message } from "@oah/api-contracts";

import { toolResultContent } from "../runtime-message-content.js";
import type { RuntimeMessage } from "./runtime-messages.js";

export type ProjectionView = "conversation" | "transcript" | "model" | "compact" | "debug" | "export";

export interface ProjectedMessageBase {
  view: ProjectionView;
  role: Message["role"];
  semanticType: string;
  sourceMessageIds: string[];
  content: Message["content"];
  metadata?: {
    hiddenFromTranscript?: boolean | undefined;
    hiddenFromModel?: boolean | undefined;
    truncated?: boolean | undefined;
    compacted?: boolean | undefined;
    notes?: string[] | undefined;
  };
}

export interface TranscriptMessage extends ProjectedMessageBase {
  view: "transcript";
}

export interface ConversationMessage extends ProjectedMessageBase {
  view: "conversation";
}

export interface DebugMessage extends ProjectedMessageBase {
  view: "debug";
}

export interface CompactMessage extends ProjectedMessageBase {
  view: "compact";
}

export interface ModelMessage extends ProjectedMessageBase {
  view: "model";
}

export interface ProjectionContext {
  sessionId: string;
  activeAgentName: string;
  modelRef?: string | undefined;
  provider?: string | undefined;
  includeReasoning?: boolean | undefined;
  includeToolResults?: boolean | undefined;
  toolResultSoftLimitChars?: number | undefined;
  applyCompactBoundary?: boolean | undefined;
  injectRuntimeReminder?: boolean | undefined;
}

export interface ProjectionResult<TMessage extends ProjectedMessageBase> {
  messages: TMessage[];
  diagnostics: {
    hiddenMessageIds: string[];
    truncatedMessageIds: string[];
    appliedCompactBoundaryId?: string | undefined;
    injectedNotes: string[];
  };
}

function copyNotes(notes: string[] | undefined, note: string): string[] {
  return [...(notes ?? []), note];
}

function isEligibleForModelContext(message: RuntimeMessage): boolean {
  return message.metadata?.eligibleForModelContext !== false;
}

function findLatestCompactBoundaryIndex(messages: RuntimeMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "compact_boundary") {
      return index;
    }
  }

  return -1;
}

function projectGenericMessage<TView extends ProjectionView>(
  runtimeMessage: RuntimeMessage,
  view: TView
): Extract<ProjectedMessageBase, { view: TView }> {
  return {
    view,
    role: runtimeMessage.role,
    semanticType: runtimeMessage.kind,
    sourceMessageIds: [runtimeMessage.id],
    content: runtimeMessage.content
  } as Extract<ProjectedMessageBase, { view: TView }>;
}

function buildModelMessage(
  runtimeMessage: RuntimeMessage,
  context: ProjectionContext
): { message?: ModelMessage | undefined; truncated: boolean } {
  if (runtimeMessage.kind === "compact_boundary") {
    return { truncated: false };
  }

  if (runtimeMessage.kind === "assistant_reasoning" && context.includeReasoning === false) {
    return { truncated: false };
  }

  if (runtimeMessage.kind === "tool_result" && context.includeToolResults === false) {
    return { truncated: false };
  }

  let content = runtimeMessage.content;
  let metadata: ModelMessage["metadata"] | undefined;
  let truncated = false;

  if (runtimeMessage.kind === "tool_result" && runtimeMessage.metadata?.compactedAt) {
    const toolResultPart = Array.isArray(runtimeMessage.content)
      ? runtimeMessage.content.find((part) => part.type === "tool-result")
      : undefined;
    if (toolResultPart) {
      content = toolResultContent({
        toolCallId: toolResultPart.toolCallId,
        toolName: toolResultPart.toolName,
        output: "[Old tool result content cleared]"
      });
      metadata = {
        compacted: true,
        notes: ["tool result compacted for model context"]
      };
      truncated = true;
    }
  }

  if (
    runtimeMessage.kind === "tool_result" &&
    !truncated &&
    typeof context.toolResultSoftLimitChars === "number" &&
    context.toolResultSoftLimitChars > 0 &&
    Array.isArray(content)
  ) {
    const toolResultPart = content.find((part) => part.type === "tool-result");
    if (
      toolResultPart &&
      (toolResultPart.output.type === "text" || toolResultPart.output.type === "error-text") &&
      toolResultPart.output.value.length > context.toolResultSoftLimitChars
    ) {
      content = toolResultContent({
        toolCallId: toolResultPart.toolCallId,
        toolName: toolResultPart.toolName,
        output: `${toolResultPart.output.value.slice(0, context.toolResultSoftLimitChars)}...`
      });
      metadata = {
        ...(metadata ?? {}),
        truncated: true,
        notes: copyNotes(metadata?.notes, `tool result truncated to ${context.toolResultSoftLimitChars} chars`)
      };
      truncated = true;
    }
  }

  return {
    message: {
      view: "model",
      role: runtimeMessage.role,
      semanticType: runtimeMessage.kind,
      sourceMessageIds: [runtimeMessage.id],
      content,
      ...(metadata ? { metadata } : {})
    },
    truncated
  };
}

export class RuntimeMessageProjector {
  projectToConversation(
    runtimeMessages: RuntimeMessage[],
    _context: ProjectionContext
  ): ProjectionResult<ConversationMessage> {
    return {
      messages: runtimeMessages
        .filter((message) => message.metadata?.visibleInTranscript !== false)
        .map((message) => projectGenericMessage(message, "conversation")),
      diagnostics: {
        hiddenMessageIds: runtimeMessages
          .filter((message) => message.metadata?.visibleInTranscript === false)
          .map((message) => message.id),
        truncatedMessageIds: [],
        injectedNotes: []
      }
    };
  }

  projectToTranscript(
    runtimeMessages: RuntimeMessage[],
    _context: ProjectionContext
  ): ProjectionResult<TranscriptMessage> {
    return {
      messages: runtimeMessages
        .filter((message) => message.metadata?.visibleInTranscript !== false)
        .map((message) => projectGenericMessage(message, "transcript")),
      diagnostics: {
        hiddenMessageIds: runtimeMessages
          .filter((message) => message.metadata?.visibleInTranscript === false)
          .map((message) => message.id),
        truncatedMessageIds: [],
        injectedNotes: []
      }
    };
  }

  projectToModel(runtimeMessages: RuntimeMessage[], context: ProjectionContext): ProjectionResult<ModelMessage> {
    const hiddenMessageIds: string[] = [];
    const truncatedMessageIds: string[] = [];
    const injectedNotes: string[] = [];

    let messages = runtimeMessages;
    let appliedCompactBoundaryId: string | undefined;
    if (context.applyCompactBoundary !== false) {
      const boundaryIndex = findLatestCompactBoundaryIndex(runtimeMessages);
      if (boundaryIndex >= 0) {
        appliedCompactBoundaryId = runtimeMessages[boundaryIndex]?.id;
        messages = runtimeMessages.slice(boundaryIndex + 1);
      }
    }

    const projected = messages.flatMap((message) => {
      if (!isEligibleForModelContext(message)) {
        hiddenMessageIds.push(message.id);
        return [];
      }

      const result = buildModelMessage(message, context);
      if (!result.message) {
        hiddenMessageIds.push(message.id);
        return [];
      }

      if (result.truncated) {
        truncatedMessageIds.push(message.id);
      }

      return [result.message];
    });

    if (context.injectRuntimeReminder) {
      projected.push({
        view: "model",
        role: "system",
        semanticType: "runtime_reminder",
        sourceMessageIds: [],
        content: "Continue from the current task state. Re-read files or rerun tools if prior outputs were compacted."
      });
      injectedNotes.push("runtime reminder injected");
    }

    return {
      messages: projected,
      diagnostics: {
        hiddenMessageIds,
        truncatedMessageIds,
        ...(appliedCompactBoundaryId ? { appliedCompactBoundaryId } : {}),
        injectedNotes
      }
    };
  }

  projectToDebug(runtimeMessages: RuntimeMessage[], _context: ProjectionContext): ProjectionResult<DebugMessage> {
    return {
      messages: runtimeMessages.map((message) => ({
        view: "debug" as const,
        role: message.role,
        semanticType: message.kind,
        sourceMessageIds: [message.id],
        content: message.content,
        metadata: {
          ...(message.metadata?.eligibleForModelContext === false ? { hiddenFromModel: true } : {}),
          ...(message.metadata?.visibleInTranscript === false ? { hiddenFromTranscript: true } : {}),
          ...(message.metadata?.compactedAt ? { compacted: true } : {})
        }
      })),
      diagnostics: {
        hiddenMessageIds: [],
        truncatedMessageIds: [],
        injectedNotes: []
      }
    };
  }

  projectToCompact(runtimeMessages: RuntimeMessage[], context: ProjectionContext): ProjectionResult<CompactMessage> {
    const modelProjection = this.projectToModel(runtimeMessages, {
      ...context,
      injectRuntimeReminder: false
    });

    return {
      messages: modelProjection.messages.map((message) => ({
        ...message,
        view: "compact"
      })),
      diagnostics: modelProjection.diagnostics
    };
  }
}
