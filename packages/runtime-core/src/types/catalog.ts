import type { ActionCatalogItem, ChatMessage, Message, ModelCatalogItem, Workspace } from "@oah/api-contracts";

import { contentToPromptMessage } from "../runtime-message-content.js";
import type { RuntimeWorkspaceCatalog } from "./runtime.js";
import type { WorkspaceRecord } from "./workspace.js";

export function createEmptyCatalog(workspaceId: string, models: ModelCatalogItem[] = []): RuntimeWorkspaceCatalog {
  return {
    workspaceId,
    agents: [],
    models,
    actions: [],
    skills: [],
    tools: [],
    hooks: [],
    nativeTools: [],
    runtimeTools: []
  };
}

export function withCatalogActions(catalog: RuntimeWorkspaceCatalog, actions: ActionCatalogItem[]): RuntimeWorkspaceCatalog {
  return {
    ...catalog,
    actions
  };
}

export function normalizeWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  const rawKind = (workspace as { kind?: string }).kind;
  if (rawKind === "project") {
    return workspace;
  }

  return {
    ...workspace,
    kind: "project",
    readOnly: false,
    historyMirrorEnabled: true
  };
}

export function toPublicWorkspace(workspace: WorkspaceRecord): Workspace {
  const normalizedWorkspace = normalizeWorkspaceRecord(workspace);
  const blueprint = normalizedWorkspace.blueprint ?? normalizedWorkspace.settings.blueprint;

  return {
    id: normalizedWorkspace.id,
    externalRef: normalizedWorkspace.externalRef,
    ...(normalizedWorkspace.ownerId ? { ownerId: normalizedWorkspace.ownerId } : {}),
    name: normalizedWorkspace.name,
    ...(blueprint ? { blueprint } : {}),
    ...(normalizedWorkspace.serviceName ? { serviceName: normalizedWorkspace.serviceName } : {}),
    rootPath: normalizedWorkspace.rootPath,
    executionPolicy: normalizedWorkspace.executionPolicy,
    status: normalizedWorkspace.status,
    kind: normalizedWorkspace.kind,
    readOnly: normalizedWorkspace.readOnly,
    createdAt: normalizedWorkspace.createdAt,
    updatedAt: normalizedWorkspace.updatedAt
  };
}

export function toChatMessages(messages: Message[]): ChatMessage[] {
  return messages.map((message) => contentToPromptMessage(message.role, message.content));
}
