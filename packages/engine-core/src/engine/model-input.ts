import type { ChatMessage, Run, Session } from "@oah/api-contracts";

import type { ModelDefinition, WorkspaceFileAccessProvider, WorkspaceFileSystem, WorkspaceRecord } from "../types.js";
import { ModelMessageSerializer } from "./ai-sdk-message-serializer.js";
import { EngineMessageProjector } from "./message-projections.js";
import { ModelResolverService, type ResolvedRunModel } from "./model-resolver.js";
import { PromptComposerService } from "./prompt-composer.js";
import type { EngineMessage } from "./engine-messages.js";

export interface ModelExecutionInput {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  messages: ChatMessage[];
}

export interface ModelInputServiceDependencies {
  defaultModel: string;
  platformModels: Record<string, ModelDefinition>;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  applyContextHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ) => Promise<ChatMessage[]>;
  collapseLeadingSystemMessages: (messages: ChatMessage[]) => ChatMessage[];
}

export class ModelInputService {
  readonly #applyContextHooks: ModelInputServiceDependencies["applyContextHooks"];
  readonly #collapseLeadingSystemMessages: ModelInputServiceDependencies["collapseLeadingSystemMessages"];
  readonly #engineMessageProjector: EngineMessageProjector;
  readonly #modelMessageSerializer: ModelMessageSerializer;
  readonly #modelResolver: ModelResolverService;
  readonly #promptComposer: PromptComposerService;
  readonly #workspaceFileAccessProvider: WorkspaceFileAccessProvider | undefined;

  constructor(dependencies: ModelInputServiceDependencies) {
    this.#applyContextHooks = dependencies.applyContextHooks;
    this.#collapseLeadingSystemMessages = dependencies.collapseLeadingSystemMessages;
    this.#engineMessageProjector = new EngineMessageProjector();
    this.#modelMessageSerializer = new ModelMessageSerializer({
      workspaceFileSystem: dependencies.workspaceFileSystem
    });
    this.#modelResolver = new ModelResolverService({
      defaultModel: dependencies.defaultModel,
      platformModels: dependencies.platformModels
    });
    this.#promptComposer = new PromptComposerService();
    this.#workspaceFileAccessProvider = dependencies.workspaceFileAccessProvider;
  }

  async buildModelInput(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    engineMessages: EngineMessage[],
    activeAgentName: string,
    forceSystemReminder = false
  ): Promise<ModelExecutionInput> {
    const resolvedModel = this.resolveRunModel(workspace, session, run, activeAgentName);
    const activeAgent = workspace.agents[activeAgentName];
    const contextMessages = await this.buildModelContextMessages(
      workspace,
      session,
      run,
      engineMessages,
      activeAgentName,
      forceSystemReminder
    );
    return {
      model: resolvedModel.model,
      canonicalModelRef: resolvedModel.canonicalModelRef,
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(activeAgent?.temperature !== undefined ? { temperature: activeAgent.temperature } : {}),
      ...(activeAgent?.topP !== undefined ? { topP: activeAgent.topP } : {}),
      ...(activeAgent?.maxTokens !== undefined ? { maxTokens: activeAgent.maxTokens } : {}),
      messages: contextMessages
    };
  }

  async buildModelContextMessages(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    engineMessages: EngineMessage[],
    activeAgentName: string,
    forceSystemReminder = false,
    options?: {
      applyHooks?: boolean | undefined;
    }
  ): Promise<ChatMessage[]> {
    const activeAgent = workspace.agents[activeAgentName];
    const resolvedModel = this.resolveRunModel(workspace, session, run, activeAgentName);
    const modelProjection = this.#engineMessageProjector.projectToModel(engineMessages, {
      sessionId: session.id,
      activeAgentName,
      ...(session.modelRef ? { modelRef: session.modelRef } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      includeReasoning: true,
      includeToolResults: true,
      applyCompactBoundary: true
    });
    const applyHooks = options?.applyHooks !== false;
    const workspaceFileAccess = this.#workspaceFileAccessProvider
      ? await this.#workspaceFileAccessProvider.acquire({
          workspace,
          access: "read"
        })
      : undefined;
    let contextMessages: ChatMessage[];
    try {
      contextMessages = await this.#modelMessageSerializer.toAiSdkMessages(modelProjection.messages, {
        workspace: workspaceFileAccess?.workspace ?? workspace
      });
    } finally {
      await workspaceFileAccess?.release();
    }
    if (applyHooks) {
      contextMessages = await this.#applyContextHooks(
        workspace,
        session,
        run,
        "before_context_build",
        contextMessages
      );
    }

    const promptMessages: Array<{ role: "system"; content: string }> = this.#promptComposer.buildStaticPromptMessages(
      workspace,
      activeAgentName,
      resolvedModel
    );

    if (
      activeAgent?.systemReminder &&
      this.#promptComposer.shouldInjectSystemReminder(engineMessages, activeAgentName, forceSystemReminder)
    ) {
      contextMessages = this.#promptComposer.withInjectedSystemReminder(contextMessages, activeAgent.systemReminder);
    }

    const assembledMessages = [...promptMessages, ...contextMessages];
    const finalizedMessages = applyHooks
      ? await this.#applyContextHooks(workspace, session, run, "after_context_build", assembledMessages)
      : assembledMessages;

    return this.#collapseLeadingSystemMessages(finalizedMessages);
  }

  resolveModelForRun(workspace: WorkspaceRecord, modelRef?: string | undefined): ResolvedRunModel {
    return this.#modelResolver.resolveModelForRun(workspace, modelRef);
  }

  resolveRunModel(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string
  ): ResolvedRunModel {
    const activeAgent = workspace.agents[activeAgentName];
    const inheritedModelRef =
      typeof run.metadata?.inheritedModelRef === "string" ? run.metadata.inheritedModelRef : undefined;

    return this.#modelResolver.resolveModelForRun(
      workspace,
      session.modelRef ?? activeAgent?.modelRef ?? inheritedModelRef
    );
  }

  normalizeSessionModelRef(workspace: WorkspaceRecord, modelRef?: string): string | undefined {
    return this.#modelResolver.normalizeSessionModelRef(workspace, modelRef);
  }
}
