import { readFile } from "node:fs/promises";

import YAML from "yaml";
import {
  normalizeObjectStorageConfig,
  usesLegacyObjectStorageCompatibilityFields
} from "./object-storage.js";
import type { ObjectStorageConfig } from "./object-storage.js";
import {
  createAjv,
  emitConfigDeprecationWarnings,
  expandEnv,
  loadSchema,
  resolveConfigPaths,
  validationMessage
} from "./shared.js";
import type { ServerConfig } from "./types.js";

export {
  normalizeObjectStorageConfig,
  resolveObjectStorageMirrorPaths,
  resolveObjectStorageWorkspaceBackingStore,
  usesExplicitObjectStorageMirrors,
  usesExplicitObjectStorageWorkspaceBackingStore,
  usesLegacyObjectStorageCompatibilityFields
} from "./object-storage.js";
export type {
  ObjectStorageConfig,
  ObjectStorageManagedPath,
  ObjectStorageMirrorPath
} from "./object-storage.js";

export type {
  ActionRetryPolicy,
  DiscoveredAction,
  DiscoveredAgent,
  DiscoveredHook,
  DiscoveredSkill,
  DiscoveredToolServer,
  DiscoveredWorkspace,
  DiscoveredWorkspaceCatalog,
  InitializeWorkspaceFromBlueprintInput,
  PlatformAgentRegistry,
  PlatformModelDefinition,
  PlatformModelRegistry,
  PromptSource,
  ResolvedPromptSource,
  ServerConfig,
  WorkspaceBlueprintDescriptor,
  WorkspaceBlueprintSkill,
  WorkspaceSettings,
  WorkspaceSystemPromptComposeSettings,
  WorkspaceSystemPromptSettings
} from "./types.js";

export {
  deleteWorkspaceBlueprint,
  initializeWorkspaceFromBlueprint,
  listWorkspaceBlueprints,
  uploadWorkspaceBlueprint
} from "./blueprints.js";

export {
  buildWorkspaceId,
  discoverWorkspace,
  discoverWorkspaces,
  loadPlatformModels,
  loadPlatformSkills,
  loadPlatformToolServers,
  loadProjectAgentsMd,
  loadSkillsFromRoots,
  loadWorkspaceActions,
  loadWorkspaceAgents,
  loadWorkspaceHooks,
  loadWorkspaceModels,
  loadWorkspaceSettings,
  loadWorkspaceToolServers,
  normalizeWorkspaceName,
  resolveWorkspaceCreationRoot,
  updateWorkspaceBlueprintSetting
} from "./workspace.js";

export async function loadServerConfig(configPath: string): Promise<ServerConfig> {
  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/server-config.schema.json"),
    readFile(configPath, "utf8")
  ]);

  const parsed = YAML.parse(fileContent) ?? {};
  const expandedRaw = expandEnv(parsed);
  const expandedRecord =
    expandedRaw && typeof expandedRaw === "object" && !Array.isArray(expandedRaw)
      ? (expandedRaw as Record<string, unknown>)
      : null;
  const expanded = expandedRecord
    ? ({
        ...expandedRecord,
        storage:
          expandedRecord.storage &&
          typeof expandedRecord.storage === "object" &&
          !Array.isArray(expandedRecord.storage)
            ? expandedRecord.storage
            : {}
      } as Record<string, unknown>)
    : expandedRaw;
  const validate = createAjv().compile<ServerConfig>(schema);
  if (!validate(expanded)) {
    throw new Error(`Invalid server config: ${validationMessage(validate.errors)}`);
  }

  const resolvedConfig = resolveConfigPaths(
    {
      ...expanded,
      server: expanded.server as ServerConfig["server"],
      storage:
        expanded.storage && typeof expanded.storage === "object" && !Array.isArray(expanded.storage)
          ? (expanded.storage as ServerConfig["storage"])
          : {},
      object_storage:
        expanded.object_storage && typeof expanded.object_storage === "object" && !Array.isArray(expanded.object_storage)
          ? normalizeObjectStorageConfig(expanded.object_storage as ObjectStorageConfig)
          : undefined,
      sandbox:
        expanded.sandbox && typeof expanded.sandbox === "object" && !Array.isArray(expanded.sandbox)
          ? (expanded.sandbox as ServerConfig["sandbox"])
          : undefined
    } as ServerConfig,
    configPath
  );

  emitConfigDeprecationWarnings(
    resolvedConfig,
    configPath,
    usesLegacyObjectStorageCompatibilityFields
  );
  return resolvedConfig;
}
