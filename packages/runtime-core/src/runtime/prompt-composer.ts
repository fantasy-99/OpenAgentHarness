import type { ChatMessage } from "@oah/api-contracts";

import { buildAvailableAgentSwitchesMessage, buildAvailableSubagentsMessage } from "../agent-control.js";
import { buildAvailableActionsMessage } from "../action-dispatch.js";
import { buildAvailableSkillsMessage } from "../skill-activation.js";
import {
  buildEnvironmentMessage as composeEnvironmentMessage,
  canDelegateFromAgent,
  visibleLlmActions,
  visibleLlmSkills
} from "../runtime-tooling.js";
import type { WorkspaceRecord } from "../types.js";
import type { RuntimeMessage } from "./runtime-messages.js";
import type { ResolvedRunModel } from "./model-resolver.js";

export class PromptComposerService {
  shouldInjectSystemReminder(messages: RuntimeMessage[], activeAgentName: string, forceSystemReminder = false): boolean {
    if (forceSystemReminder) {
      return true;
    }

    const latestAgentName = this.#latestMessageAgentName(messages);
    return latestAgentName !== undefined && latestAgentName !== activeAgentName;
  }

  withInjectedSystemReminder(messages: ChatMessage[], reminder: string): ChatMessage[] {
    let lastUserMessageIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUserMessageIndex = index;
        break;
      }
    }

    if (lastUserMessageIndex === -1) {
      return messages;
    }

    const userMessage = messages[lastUserMessageIndex];
    if (!userMessage || userMessage.role !== "user") {
      return messages;
    }

    const reminderBlock = this.#formatSystemReminder(reminder);
    const updatedMessages = [...messages];
    updatedMessages[lastUserMessageIndex] = {
      ...userMessage,
      content:
        typeof userMessage.content === "string"
          ? userMessage.content.trim().length > 0
            ? `${reminderBlock}\n\n${userMessage.content}`
            : reminderBlock
          : [{ type: "text", text: reminderBlock }, ...userMessage.content]
    };

    return updatedMessages;
  }

  buildStaticPromptMessages(
    workspace: WorkspaceRecord,
    activeAgentName: string,
    resolvedModel: ResolvedRunModel
  ): Array<{ role: "system"; content: string }> {
    const activeAgent = workspace.agents[activeAgentName];
    const systemPromptSettings = workspace.settings.systemPrompt;
    const compose = systemPromptSettings?.compose ?? {
      order: [
        "base",
        "llm_optimized",
        "agent",
        "actions",
        "project_agents_md",
        "skills",
        "agent_switches",
        "subagents",
        "environment"
      ] as const,
      includeEnvironment: false
    };
    const visibleActions = activeAgent ? visibleLlmActions(workspace, activeAgentName) : [];
    const visibleSkills = activeAgent ? visibleLlmSkills(workspace, activeAgentName) : [];
    const agentSwitchMessage = this.#buildAgentSwitchMessage(workspace, activeAgentName);
    const availableSubagentsMessage = this.#buildAvailableSubagentsMessage(workspace, activeAgentName);
    const environmentMessage =
      compose.includeEnvironment && workspace.kind === "project"
        ? composeEnvironmentMessage(workspace, activeAgentName)
        : undefined;
    const orderedMessages: Array<{ role: "system"; content: string }> = [];

    for (const segment of compose.order) {
      switch (segment) {
        case "base":
          if (systemPromptSettings?.base?.content) {
            orderedMessages.push({
              role: "system",
              content: systemPromptSettings.base.content
            });
          }
          break;
        case "llm_optimized": {
          const optimizedPrompt = this.#resolveLlmOptimizedPrompt(workspace, resolvedModel);
          if (optimizedPrompt) {
            orderedMessages.push({
              role: "system",
              content: optimizedPrompt
            });
          }
          break;
        }
        case "agent":
          if (activeAgent) {
            orderedMessages.push({
              role: "system",
              content: activeAgent.prompt
            });
          }
          break;
        case "actions":
          if (visibleActions.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableActionsMessage(visibleActions)
            });
          }
          break;
        case "project_agents_md":
          if (workspace.projectAgentsMd) {
            orderedMessages.push({
              role: "system",
              content: workspace.projectAgentsMd
            });
          }
          break;
        case "skills":
          if (visibleSkills.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableSkillsMessage(visibleSkills)
            });
          }
          break;
        case "agent_switches":
          if (agentSwitchMessage) {
            orderedMessages.push({
              role: "system",
              content: agentSwitchMessage
            });
          }
          break;
        case "subagents":
          if (availableSubagentsMessage) {
            orderedMessages.push({
              role: "system",
              content: availableSubagentsMessage
            });
          }
          break;
        case "environment":
          if (environmentMessage) {
            orderedMessages.push({
              role: "system",
              content: environmentMessage
            });
          }
          break;
      }
    }

    return orderedMessages;
  }

  #latestMessageAgentName(messages: RuntimeMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role === "system") {
        continue;
      }

      if (index === messages.length - 1 && message.role === "user") {
        continue;
      }

      const metadata =
        typeof message.metadata === "object" && message.metadata !== null && !Array.isArray(message.metadata)
          ? message.metadata
          : undefined;
      if (typeof metadata?.effectiveAgentName === "string" && metadata.effectiveAgentName.length > 0) {
        return metadata.effectiveAgentName;
      }

      if (typeof metadata?.agentName === "string" && metadata.agentName.length > 0) {
        return metadata.agentName;
      }
    }

    return undefined;
  }

  #formatSystemReminder(reminder: string): string {
    return `<system_reminder>\n${reminder}\n</system_reminder>`;
  }

  #resolveLlmOptimizedPrompt(workspace: WorkspaceRecord, resolvedModel: ResolvedRunModel): string | undefined {
    const llmOptimized = workspace.settings.systemPrompt?.llmOptimized;
    if (!llmOptimized) {
      return undefined;
    }

    return (
      llmOptimized.models?.[resolvedModel.canonicalModelRef]?.content ??
      (resolvedModel.provider ? llmOptimized.providers?.[resolvedModel.provider]?.content : undefined)
    );
  }

  #buildAgentSwitchMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableAgentSwitchesMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }

  #buildAvailableSubagentsMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    if (!canDelegateFromAgent(workspace, activeAgentName)) {
      return undefined;
    }

    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableSubagentsMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }
}
