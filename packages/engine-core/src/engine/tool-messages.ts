import type { Message, Run, Session } from "@oah/api-contracts";

import {
  assistantNarrativeContentFromModelOutput,
  textContent,
  toolCallContent,
  toolErrorResultContent,
  toolResultContent
} from "../execution-message-content.js";
import type { MessageRepository, EngineLogger, SessionEvent } from "../types.js";
import type { ModelStepResult } from "../types.js";
import type { ToolErrorContentPart } from "./model-call-serialization.js";

type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolMessageMetadata = {
  toolStatus: "running" | "started" | "completed" | "failed";
  toolSourceType?: string | undefined;
  toolDurationMs?: number | undefined;
};

export interface ToolMessageServiceDependencies {
  messageRepository: MessageRepository;
  logger?: EngineLogger | undefined;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  createId: (prefix: string) => string;
  nowIso: () => string;
  previewValue: (value: unknown, maxLength?: number) => string;
}

export class ToolMessageService {
  readonly #messageRepository: MessageRepository;
  readonly #logger?: EngineLogger | undefined;
  readonly #appendEvent: ToolMessageServiceDependencies["appendEvent"];
  readonly #createId: ToolMessageServiceDependencies["createId"];
  readonly #nowIso: ToolMessageServiceDependencies["nowIso"];
  readonly #previewValue: ToolMessageServiceDependencies["previewValue"];
  readonly #lastMessageCreatedAtBySessionId = new Map<string, number>();

  constructor(dependencies: ToolMessageServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#logger = dependencies.logger;
    this.#appendEvent = dependencies.appendEvent;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
    this.#previewValue = dependencies.previewValue;
  }

  #mergeToolMetadata(
    metadata: Record<string, unknown> | undefined,
    toolMetadata: ToolMessageMetadata | undefined
  ): Record<string, unknown> | undefined {
    if (!metadata && !toolMetadata) {
      return undefined;
    }

    return {
      ...(metadata ?? {}),
      ...(toolMetadata ?? {})
    };
  }

  #nextMessageCreatedAt(sessionId: string): string {
    const nowMs = Date.parse(this.#nowIso());
    const lastCreatedAtMs = this.#lastMessageCreatedAtBySessionId.get(sessionId);
    const createdAtMs =
      Number.isFinite(nowMs) && Number.isFinite(lastCreatedAtMs)
        ? Math.max(nowMs, (lastCreatedAtMs ?? nowMs) + 1)
        : Number.isFinite(nowMs)
          ? nowMs
          : Date.now();
    this.#lastMessageCreatedAtBySessionId.set(sessionId, createdAtMs);
    return new Date(createdAtMs).toISOString();
  }

  async ensureAssistantMessage(
    session: Session,
    run: Run,
    currentMessage: AssistantMessage | undefined,
    allMessages?: Message[],
    content = "",
    metadata?: Record<string, unknown> | undefined
  ): Promise<AssistantMessage> {
    if (currentMessage) {
      return currentMessage;
    }

    const message = (await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      content: textContent(content),
      ...(metadata ? { metadata } : {}),
      createdAt: this.#nextMessageCreatedAt(session.id)
    })) as AssistantMessage;

    allMessages?.push(message);
    return message;
  }

  async persistAssistantStepText(
    session: Session,
    run: Run,
    step: ModelStepResult,
    currentMessage: AssistantMessage | undefined,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ): Promise<AssistantMessage | undefined> {
    const assistantContent = assistantNarrativeContentFromModelOutput({
      text: step.text,
      content: step.content,
      reasoning: step.reasoning
    });

    if (!assistantContent) {
      return undefined;
    }

    const assistantMessage = await this.ensureAssistantMessage(
      session,
      run,
      currentMessage,
      allMessages,
      typeof assistantContent === "string" ? assistantContent : step.text ?? "",
      metadata
    );
    const updatedMessage =
      JSON.stringify(assistantMessage.content) === JSON.stringify(assistantContent)
        ? assistantMessage
        : ((await this.#messageRepository.update({
            ...assistantMessage,
            content: assistantContent
          })) as AssistantMessage);

    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "message.completed",
      data: {
        runId: run.id,
        messageId: updatedMessage.id,
        content: updatedMessage.content,
        ...(updatedMessage.metadata ? { metadata: updatedMessage.metadata } : {})
      }
    });

    return updatedMessage;
  }

  async persistAssistantToolCalls(
    session: Session,
    run: Run,
    step: ModelStepResult,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<string, ToolMessageMetadata> | undefined
  ): Promise<void> {
    if (step.toolCalls.length === 0) {
      return;
    }

    this.#logger?.debug?.("Persisting assistant tool-call message.", {
      sessionId: session.id,
      runId: run.id,
      toolCallIds: step.toolCalls.map((toolCall) => toolCall.toolCallId),
      toolNames: step.toolCalls.map((toolCall) => toolCall.toolName)
    });

    for (const toolCall of step.toolCalls) {
      const assistantToolCallMessage = await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "assistant",
        content: toolCallContent([toolCall]),
        ...(() => {
          const mergedMetadata = this.#mergeToolMetadata(metadata, toolMetadataByCallId?.get(toolCall.toolCallId));
          return mergedMetadata ? { metadata: mergedMetadata } : {};
        })(),
        createdAt: this.#nextMessageCreatedAt(session.id)
      });

      allMessages.push(assistantToolCallMessage);
      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: assistantToolCallMessage.id,
          content: assistantToolCallMessage.content,
          ...(assistantToolCallMessage.metadata ? { metadata: assistantToolCallMessage.metadata } : {})
        }
      });
    }
  }

  async persistToolResults(
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined,
    toolMetadataByCallId?: Map<string, ToolMessageMetadata> | undefined
  ): Promise<void> {
    for (const toolResult of step.toolResults) {
      if (persistedToolCalls.has(toolResult.toolCallId)) {
        continue;
      }

      persistedToolCalls.add(toolResult.toolCallId);
      this.#logger?.debug?.("Persisting tool result message.", {
        sessionId: session.id,
        runId: run.id,
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        resultType: "success",
        outputPreview: this.#previewValue(toolResult.output)
      });
      const toolMessage = await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        content: toolResultContent(toolResult),
        ...(() => {
          const mergedMetadata = this.#mergeToolMetadata(metadata, toolMetadataByCallId?.get(toolResult.toolCallId));
          return mergedMetadata ? { metadata: mergedMetadata } : {};
        })(),
        createdAt: this.#nextMessageCreatedAt(session.id)
      });
      allMessages.push(toolMessage);

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          toolName: toolResult.toolName,
          toolCallId: toolResult.toolCallId,
          ...(toolMessage.metadata ? { metadata: toolMessage.metadata } : {})
        }
      });
    }

    for (const toolError of failedToolResults) {
      if (persistedToolCalls.has(toolError.toolCallId)) {
        continue;
      }

      persistedToolCalls.add(toolError.toolCallId);
      this.#logger?.debug?.("Persisting failed tool result message.", {
        sessionId: session.id,
        runId: run.id,
        toolCallId: toolError.toolCallId,
        toolName: toolError.toolName,
        resultType: "error",
        errorPreview: this.#previewValue(toolError.error)
      });
      const toolMessage = await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        content: toolErrorResultContent(toolError),
        ...(() => {
          const mergedMetadata = this.#mergeToolMetadata(metadata, toolMetadataByCallId?.get(toolError.toolCallId));
          return mergedMetadata ? { metadata: mergedMetadata } : {};
        })(),
        createdAt: this.#nextMessageCreatedAt(session.id)
      });
      allMessages.push(toolMessage);

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          toolName: toolError.toolName,
          toolCallId: toolError.toolCallId,
          resultType: "error",
          ...(toolMessage.metadata ? { metadata: toolMessage.metadata } : {})
        }
      });
    }
  }

  async persistStandaloneToolResultMessage(input: {
    session: Session;
    run: Run;
    toolCallId: string;
    toolName: string;
    output: unknown;
    actionName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<Message> {
    const toolMessage = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.session.id,
      runId: input.run.id,
      role: "tool",
      content: toolResultContent({
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: input.output
      }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: this.#nextMessageCreatedAt(input.session.id)
    });

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "message.completed",
      data: {
        runId: input.run.id,
        messageId: toolMessage.id,
        content: toolMessage.content,
        ...(input.actionName ? { actionName: input.actionName } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        ...(toolMessage.metadata ? { metadata: toolMessage.metadata } : {})
      }
    });

    return toolMessage;
  }

  async persistStandaloneToolCallMessage(input: {
    session: Session;
    run: Run;
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<Message> {
    const toolCallMessage = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.session.id,
      runId: input.run.id,
      role: "assistant",
      content: toolCallContent([
        {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.toolInput
        }
      ]),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: this.#nextMessageCreatedAt(input.session.id)
    });

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "message.completed",
      data: {
        runId: input.run.id,
        messageId: toolCallMessage.id,
        content: toolCallMessage.content,
        ...(toolCallMessage.metadata ? { metadata: toolCallMessage.metadata } : {})
      }
    });

    return toolCallMessage;
  }

  async persistStandaloneToolErrorMessage(input: {
    session: Session;
    run: Run;
    toolCallId: string;
    toolName: string;
    error: unknown;
    actionName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<Message> {
    const toolMessage = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.session.id,
      runId: input.run.id,
      role: "tool",
      content: toolErrorResultContent({
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        error: input.error
      }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: this.#nextMessageCreatedAt(input.session.id)
    });

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "message.completed",
      data: {
        runId: input.run.id,
        messageId: toolMessage.id,
        content: toolMessage.content,
        ...(input.actionName ? { actionName: input.actionName } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        resultType: "error",
        ...(toolMessage.metadata ? { metadata: toolMessage.metadata } : {})
      }
    });

    return toolMessage;
  }

  async updateMessageMetadata(message: Message, metadata?: Record<string, unknown> | undefined): Promise<Message> {
    if (!metadata) {
      return message;
    }

    return this.#messageRepository.update({
      ...message,
      metadata
    });
  }
}
