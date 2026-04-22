import type { Message, Run, Session } from "@oah/api-contracts";

import type { EngineLogger, MessageRepository, ModelGateway, WorkspaceRecord } from "../types.js";
import type { ContextPreparationModule, ContextPreparationModuleInput } from "./context-modules.js";
import type { EngineMessage } from "./engine-messages.js";
import { renderMessagesForMemory, selectMessagesSinceId, trimMarkdownCodeFence, truncateText } from "./memory-support.js";
import type { ResolvedRunModel } from "./model-resolver.js";
import { isWorkspaceMemoryExtractionRun } from "./workspace-memory-agent.js";

const SESSION_MEMORY_TAG = "session-memory";
const SESSION_MEMORY_CONTEXT_MAX_CHARS = 5_000;
const SESSION_MEMORY_TRANSCRIPT_MAX_CHARS = 12_000;
const SESSION_MEMORY_MAX_TOKENS = 900;

const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Memory

## Current State
- Active task, current status, and immediate next step.

## Important Context
- Key user asks, constraints, decisions, and code areas that matter for this session.

## Recent Learnings
- Short notes on fixes, failed approaches, commands, and discoveries from this conversation.`;

const SESSION_MEMORY_CONTEXT_PREFIX = [
  "Session memory loaded from prior work in this same conversation.",
  "Use it to maintain continuity, but prefer current repo state when concrete facts need verification."
].join(" ");

const SESSION_MEMORY_UPDATE_SYSTEM_PROMPT = [
  "You maintain a concise session-scoped memory for an active coding conversation.",
  "Rewrite the full markdown memory using the previous memory plus the new conversation delta.",
  "Keep it focused on current state, key context, open threads, important files, commands, and recent learnings.",
  "Do not include filler, chit-chat, or references to memory extraction.",
  "Return markdown only with no code fences."
].join(" ");

interface SessionMemoryMetadataExtra extends Record<string, unknown> {
  memoryKind?: "session" | undefined;
  lastExtractedMessageId?: string | undefined;
  updatedAt?: string | undefined;
}

type SessionMemoryMessage = Extract<Message, { role: "system"; content: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetadataExtra(message: Message): SessionMemoryMetadataExtra | undefined {
  const extra = isRecord(message.metadata) && isRecord(message.metadata.extra) ? message.metadata.extra : undefined;
  return extra as SessionMemoryMetadataExtra | undefined;
}

function isSessionMemoryMessage(message: Message): message is SessionMemoryMessage {
  return message.role === "system" && typeof message.content === "string" && readMetadataExtra(message)?.memoryKind === "session";
}

function buildSessionMemoryContext(content: string): string {
  return `<session_memory>\n${SESSION_MEMORY_CONTEXT_PREFIX}\n\n${content}\n</session_memory>`;
}

function buildUpdatePrompt(currentMemory: string, transcript: string): string {
  return [
    "<existing_session_memory>",
    currentMemory.trim().length > 0 ? currentMemory : DEFAULT_SESSION_MEMORY_TEMPLATE,
    "</existing_session_memory>",
    "",
    "<conversation_delta>",
    transcript,
    "</conversation_delta>"
  ].join("\n");
}

export interface SessionMemoryServiceDependencies {
  logger?: EngineLogger | undefined;
  messageRepository: Pick<MessageRepository, "create" | "listBySessionId" | "update">;
  modelGateway: ModelGateway;
  scheduleEngineMessageSync: (sessionId: string) => Promise<void>;
  resolveRunModel: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string
  ) => ResolvedRunModel;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown> | undefined) => Promise<unknown>;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export class SessionMemoryService implements ContextPreparationModule {
  readonly name = "session_memory";
  readonly #logger?: EngineLogger | undefined;
  readonly #messageRepository: SessionMemoryServiceDependencies["messageRepository"];
  readonly #modelGateway: SessionMemoryServiceDependencies["modelGateway"];
  readonly #scheduleEngineMessageSync: SessionMemoryServiceDependencies["scheduleEngineMessageSync"];
  readonly #resolveRunModel: SessionMemoryServiceDependencies["resolveRunModel"];
  readonly #recordSystemStep: SessionMemoryServiceDependencies["recordSystemStep"];
  readonly #createId: SessionMemoryServiceDependencies["createId"];
  readonly #nowIso: SessionMemoryServiceDependencies["nowIso"];
  readonly #updateChains = new Map<string, Promise<void>>();

  constructor(dependencies: SessionMemoryServiceDependencies) {
    this.#logger = dependencies.logger;
    this.#messageRepository = dependencies.messageRepository;
    this.#modelGateway = dependencies.modelGateway;
    this.#scheduleEngineMessageSync = dependencies.scheduleEngineMessageSync;
    this.#resolveRunModel = dependencies.resolveRunModel;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
  }

  isEnabled(workspace: WorkspaceRecord): boolean {
    return workspace.settings.engine?.sessionMemory?.enabled ?? false;
  }

  async prepareMessagesForModelInput(input: ContextPreparationModuleInput): Promise<EngineMessage[]> {
    if (!this.isEnabled(input.workspace) || isWorkspaceMemoryExtractionRun(input.run)) {
      return input.engineMessages;
    }

    const memoryMessage = this.#findSessionMemoryMessage(input.messages);
    const memoryContent = typeof memoryMessage?.content === "string" ? memoryMessage.content.trim() : "";
    if (memoryContent.length === 0) {
      return input.engineMessages;
    }

    return [
      ...input.engineMessages,
      {
        id: this.#createId("engmsg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        kind: "system_note",
        content: buildSessionMemoryContext(truncateText(memoryContent, SESSION_MEMORY_CONTEXT_MAX_CHARS)),
        createdAt: this.#nowIso(),
        metadata: {
          runtimeKind: "system_note",
          synthetic: true,
          visibleInTranscript: false,
          eligibleForModelContext: true,
          source: "system",
          tags: [SESSION_MEMORY_TAG]
        }
      }
    ];
  }

  scheduleBackgroundUpdate(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
  }): void {
    if (!this.isEnabled(input.workspace) || isWorkspaceMemoryExtractionRun(input.run)) {
      return;
    }

    const previous = this.#updateChains.get(input.session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => this.#updateSessionMemory(input))
      .catch((error) => {
        this.#logger?.warn?.("Background session memory update failed.", {
          workspaceId: input.workspace.id,
          sessionId: input.session.id,
          runId: input.run.id,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.#updateChains.get(input.session.id) === next) {
          this.#updateChains.delete(input.session.id);
        }
      });

    this.#updateChains.set(input.session.id, next);
  }

  #findSessionMemoryMessage(messages: Message[]): SessionMemoryMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && isSessionMemoryMessage(message)) {
        return message;
      }
    }

    return undefined;
  }

  async #updateSessionMemory(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
  }): Promise<void> {
    const messages = await this.#messageRepository.listBySessionId(input.session.id);
    const existingMemoryMessage = this.#findSessionMemoryMessage(messages);
    const sourceMessages = messages.filter((message) => !isSessionMemoryMessage(message));
    const existingMemoryExtra = existingMemoryMessage ? readMetadataExtra(existingMemoryMessage) : undefined;
    const lastExtractedMessageId =
      typeof existingMemoryExtra?.lastExtractedMessageId === "string" ? existingMemoryExtra.lastExtractedMessageId : undefined;
    const deltaMessages = selectMessagesSinceId(sourceMessages, lastExtractedMessageId);
    const latestMessageId = sourceMessages.at(-1)?.id;
    if (deltaMessages.length === 0 || !latestMessageId) {
      return;
    }

    const transcript = truncateText(renderMessagesForMemory(deltaMessages), SESSION_MEMORY_TRANSCRIPT_MAX_CHARS).trim();
    if (transcript.length === 0) {
      return;
    }

    const currentMemory = typeof existingMemoryMessage?.content === "string" ? existingMemoryMessage.content : "";
    const resolvedModel = this.#resolveRunModel(input.workspace, input.session, input.run, input.run.effectiveAgentName);
    const response = await this.#modelGateway.generate({
      model: resolvedModel.model,
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      maxTokens: SESSION_MEMORY_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content: SESSION_MEMORY_UPDATE_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: buildUpdatePrompt(currentMemory, transcript)
        }
      ]
    });
    const nextMemory = trimMarkdownCodeFence(response.text).trim();
    if (nextMemory.length === 0) {
      return;
    }

    const metadata = {
      runtimeKind: "system_note",
      source: "engine",
      synthetic: true,
      visibleInTranscript: false,
      eligibleForModelContext: false,
      tags: [SESSION_MEMORY_TAG],
      extra: {
        memoryKind: "session",
        lastExtractedMessageId: latestMessageId,
        updatedAt: this.#nowIso()
      }
    } as const;

    if (existingMemoryMessage) {
      await this.#messageRepository.update({
        ...existingMemoryMessage,
        content: nextMemory,
        metadata
      });
    } else {
      await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        content: nextMemory,
        metadata,
        createdAt: this.#nowIso()
      });
    }

    await this.#scheduleEngineMessageSync(input.session.id);
    await this.#recordSystemStep(input.run, "session_memory_update", {
      summarizedMessageCount: deltaMessages.length,
      lastExtractedMessageId: latestMessageId
    });
  }
}
