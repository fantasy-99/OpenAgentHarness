import type { ChatMessage, Run, Session } from "@oah/api-contracts";

import type { ModelDefinition, WorkspaceRecord } from "../types.js";
import { ModelMessageSerializer } from "./ai-sdk-message-serializer.js";
import { RuntimeMessageProjector } from "./message-projections.js";
import { ModelResolverService, type ResolvedRunModel } from "./model-resolver.js";
import { PromptComposerService } from "./prompt-composer.js";
import type { RuntimeMessage } from "./runtime-messages.js";

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
  readonly #runtimeMessageProjector: RuntimeMessageProjector;
  readonly #modelMessageSerializer: ModelMessageSerializer;
  readonly #modelResolver: ModelResolverService;
  readonly #promptComposer: PromptComposerService;

  constructor(dependencies: ModelInputServiceDependencies) {
    this.#applyContextHooks = dependencies.applyContextHooks;
    this.#collapseLeadingSystemMessages = dependencies.collapseLeadingSystemMessages;
    this.#runtimeMessageProjector = new RuntimeMessageProjector();
    this.#modelMessageSerializer = new ModelMessageSerializer();
    this.#modelResolver = new ModelResolverService({
      defaultModel: dependencies.defaultModel,
      platformModels: dependencies.platformModels
    });
    this.#promptComposer = new PromptComposerService();
  }

  async buildModelInput(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    runtimeMessages: RuntimeMessage[],
    activeAgentName: string,
    forceSystemReminder = false
  ): Promise<ModelExecutionInput> {
    const activeAgent = workspace.agents[activeAgentName];
    const inheritedModelRef =
      typeof run.metadata?.inheritedModelRef === "string" ? run.metadata.inheritedModelRef : undefined;
    const resolvedModel = this.#modelResolver.resolveModelForRun(
      workspace,
      session.modelRef ?? activeAgent?.modelRef ?? inheritedModelRef
    );
    const modelProjection = this.#runtimeMessageProjector.projectToModel(runtimeMessages, {
      sessionId: session.id,
      activeAgentName,
      ...(session.modelRef ? { modelRef: session.modelRef } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      includeReasoning: true,
      includeToolResults: true,
      applyCompactBoundary: true
    });
    let contextMessages = await this.#applyContextHooks(
      workspace,
      session,
      run,
      "before_context_build",
      this.#modelMessageSerializer.toAiSdkMessages(modelProjection.messages)
    );
    const promptMessages: Array<{ role: "system"; content: string }> = this.#promptComposer.buildStaticPromptMessages(
      workspace,
      activeAgentName,
      resolvedModel
    );

    if (
      activeAgent?.systemReminder &&
      this.#promptComposer.shouldInjectSystemReminder(runtimeMessages, activeAgentName, forceSystemReminder)
    ) {
      contextMessages = this.#promptComposer.withInjectedSystemReminder(contextMessages, activeAgent.systemReminder);
    }

    contextMessages = await this.#applyContextHooks(workspace, session, run, "after_context_build", [
      ...promptMessages,
      ...contextMessages
    ]);

    return {
      model: resolvedModel.model,
      canonicalModelRef: resolvedModel.canonicalModelRef,
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(activeAgent?.temperature !== undefined ? { temperature: activeAgent.temperature } : {}),
      ...(activeAgent?.topP !== undefined ? { topP: activeAgent.topP } : {}),
      ...(activeAgent?.maxTokens !== undefined ? { maxTokens: activeAgent.maxTokens } : {}),
      messages: this.#collapseLeadingSystemMessages(contextMessages)
    };
  }

  resolveModelForRun(workspace: WorkspaceRecord, modelRef?: string | undefined): ResolvedRunModel {
    return this.#modelResolver.resolveModelForRun(workspace, modelRef);
  }

  normalizeSessionModelRef(workspace: WorkspaceRecord, modelRef?: string): string | undefined {
    return this.#modelResolver.normalizeSessionModelRef(workspace, modelRef);
  }
}
