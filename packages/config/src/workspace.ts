import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";
import YAML from "yaml";
import {
  createAjv,
  createWorkspaceCatalog,
  expandEnv,
  inferSkillDescription,
  isDefined,
  loadModelRegistryFromDirectory,
  loadSchema,
  nowIso,
  pathExists,
  readDirectoryEntriesIfExists,
  resolveWorkspaceSystemPrompt,
  toActionCatalogItems,
  toAgentCatalogItems,
  toHookCatalogItems,
  toPlatformModelCatalogItems,
  toSkillCatalogItems,
  toToolCatalogItems,
  toWorkspaceModelCatalogItems,
  validationMessage
} from "./shared.js";
import type {
  ActionRetryPolicy,
  DiscoveredAction,
  DiscoveredAgent,
  DiscoveredHook,
  DiscoveredSkill,
  DiscoveredToolServer,
  DiscoveredWorkspace,
  PlatformAgentRegistry,
  PlatformModelRegistry,
  PromptSource,
  ServerConfig,
  WorkspaceSettings
} from "./types.js";

function workspaceIdSuffix(kind: "project", rootPath: string): string {
  return createHash("sha1")
    .update(`${kind}\0${path.resolve(rootPath).replaceAll("\\", "/")}`)
    .digest("hex")
    .slice(0, 10);
}

export function buildWorkspaceId(kind: "project", name: string, rootPath?: string): string {
  const normalized = normalizeWorkspaceName(name);
  const base = `${kind}_${normalized || "workspace"}`;
  return rootPath ? `${base}_${workspaceIdSuffix(kind, rootPath)}` : base;
}

export function normalizeWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export function resolveWorkspaceCreationRoot(input: {
  workspaceDir: string;
  name: string;
  workspaceId?: string | undefined;
  rootPath?: string | undefined;
}): string {
  if (input.rootPath) {
    const resolved = path.isAbsolute(input.rootPath)
      ? input.rootPath
      : path.resolve(input.workspaceDir, input.rootPath);

    const relative = path.relative(input.workspaceDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `rootPath "${input.rootPath}" resolves to "${resolved}" which is outside the workspace directory "${input.workspaceDir}". ` +
          "Workspace root paths must be within the configured workspace directory."
      );
    }

    return resolved;
  }

  const directoryName = input.workspaceId?.trim() || normalizeWorkspaceName(input.name) || "workspace";
  return path.resolve(input.workspaceDir, directoryName);
}

export async function loadPlatformModels(
  modelsDir: string,
  options?: { onError?: ((input: { filePath: string; error: unknown }) => void) | undefined }
): Promise<PlatformModelRegistry> {
  return loadModelRegistryFromDirectory(modelsDir, options);
}

export async function loadWorkspaceSettings(workspaceRoot: string): Promise<WorkspaceSettings> {
  const settingsPath = path.join(workspaceRoot, ".openharness", "settings.yaml");
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/settings.schema.json"),
    readFile(settingsPath, "utf8")
  ]);

  const parsed = expandEnv(YAML.parse(fileContent) ?? {});
  const validate = createAjv().compile<WorkspaceSettings>(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid workspace settings in ${settingsPath}: ${validationMessage(validate.errors)}`);
  }

  const typedParsed = parsed as {
    default_agent?: string;
    blueprint?: string;
    skill_dirs?: string[];
    imports?: {
      tools?: string[];
      skills?: string[];
    };
    system_prompt?: {
      base?: PromptSource;
      llm_optimized?: {
        providers?: Record<string, PromptSource>;
        models?: Record<string, PromptSource>;
      };
      compose?: {
        order?: Array<
          | "base"
          | "llm_optimized"
          | "agent"
          | "actions"
          | "project_agents_md"
          | "skills"
          | "agent_switches"
          | "subagents"
          | "environment"
        >;
        include_environment?: boolean;
      };
    };
  };

  return {
    ...(typedParsed.default_agent ? { defaultAgent: typedParsed.default_agent } : {}),
    ...(typedParsed.blueprint ? { blueprint: typedParsed.blueprint } : {}),
    ...(typedParsed.skill_dirs ? { skillDirs: typedParsed.skill_dirs } : {}),
    ...(typedParsed.imports
      ? {
          imports: {
            ...(typedParsed.imports.tools ? { tools: typedParsed.imports.tools } : {}),
            ...(typedParsed.imports.skills ? { skills: typedParsed.imports.skills } : {})
          }
        }
      : {}),
    ...(typedParsed.system_prompt
      ? {
          systemPrompt: await resolveWorkspaceSystemPrompt(typedParsed.system_prompt, workspaceRoot)
        }
      : {})
  };
}

export async function updateWorkspaceBlueprintSetting(workspaceRoot: string, blueprint: string): Promise<void> {
  const settingsPath = path.join(workspaceRoot, ".openharness", "settings.yaml");
  await mkdir(path.dirname(settingsPath), { recursive: true });

  const currentRaw = (await pathExists(settingsPath)) ? YAML.parse(await readFile(settingsPath, "utf8")) : {};
  if (currentRaw !== null && (typeof currentRaw !== "object" || Array.isArray(currentRaw))) {
    throw new Error(`Invalid workspace settings in ${settingsPath}.`);
  }

  await writeFile(
    settingsPath,
    YAML.stringify({
      ...(currentRaw as Record<string, unknown>),
      blueprint
    }),
    "utf8"
  );
}

export async function loadWorkspaceModels(workspaceRoot: string): Promise<PlatformModelRegistry> {
  return loadModelRegistryFromDirectory(path.join(workspaceRoot, ".openharness", "models"));
}

async function loadSkillsFromRoot(skillRoot: string): Promise<Record<string, DiscoveredSkill>> {
  const directoryEntries = await readDirectoryEntriesIfExists(skillRoot);
  const skills: Record<string, DiscoveredSkill> = {};

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectory = path.join(skillRoot, entry.name);
    const skillFilePath = path.join(skillDirectory, "SKILL.md");
    if (!(await pathExists(skillFilePath))) {
      continue;
    }

    const fileContent = await readFile(skillFilePath, "utf8");
    const parsed = matter(fileContent);
    const content = parsed.content.trim();
    if (!content) {
      throw new Error(`Skill definition in ${skillFilePath} is missing markdown content.`);
    }

    const frontmatter = parsed.data as Record<string, unknown>;
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0 ? frontmatter.name : entry.name;
    if (skills[name]) {
      throw new Error(`Duplicate skill name detected in ${skillRoot}: ${name}`);
    }

    const inferredDescription = inferSkillDescription(content);

    skills[name] = {
      name,
      ...(typeof frontmatter.description === "string"
        ? { description: frontmatter.description }
        : inferredDescription
          ? { description: inferredDescription }
          : {}),
      exposeToLlm: true,
      directory: skillDirectory,
      sourceRoot: skillRoot,
      content
    };
  }

  return skills;
}

export async function loadSkillsFromRoots(skillRoots: string[]): Promise<Record<string, DiscoveredSkill>> {
  const mergedSkills: Record<string, DiscoveredSkill> = {};

  for (const skillRoot of skillRoots) {
    const skills = await loadSkillsFromRoot(skillRoot);
    for (const [name, skill] of Object.entries(skills)) {
      if (mergedSkills[name]) {
        continue;
      }

      mergedSkills[name] = skill;
    }
  }

  return mergedSkills;
}

export async function loadPlatformSkills(skillDir: string): Promise<Record<string, DiscoveredSkill>> {
  return loadSkillsFromRoots([skillDir]);
}

export async function loadProjectAgentsMd(workspaceRoot: string): Promise<string | undefined> {
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  if (!(await pathExists(agentsPath))) {
    return undefined;
  }

  return readFile(agentsPath, "utf8");
}

export async function loadWorkspaceToolServers(
  toolRoot: string,
  options?: { workingDirectory?: string | undefined }
): Promise<Record<string, DiscoveredToolServer>> {
  const settingsPath = path.join(toolRoot, "settings.yaml");
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/mcp-settings.schema.json"),
    readFile(settingsPath, "utf8")
  ]);

  const parsed = expandEnv(YAML.parse(fileContent) ?? {});
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid tool settings in ${settingsPath}: ${validationMessage(validate.errors)}`);
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([name, rawDefinition]) => {
      const definition = rawDefinition as {
        enabled?: boolean;
        command?: string;
        url?: string;
        environment?: Record<string, string>;
        headers?: Record<string, string>;
        timeout?: number;
        oauth?: boolean | Record<string, unknown>;
        expose?: {
          tool_prefix?: string;
          include?: string[];
          exclude?: string[];
        };
      };

      return [
        name,
        {
          name,
          enabled: definition.enabled !== false,
          transportType: typeof definition.command === "string" ? "stdio" : "http",
          ...(typeof definition.expose?.tool_prefix === "string" ? { toolPrefix: definition.expose.tool_prefix } : {}),
          ...(typeof definition.command === "string" ? { command: definition.command } : {}),
          ...(typeof definition.command === "string" && options?.workingDirectory
            ? { workingDirectory: options.workingDirectory }
            : {}),
          ...(typeof definition.url === "string" ? { url: definition.url } : {}),
          ...(definition.environment ? { environment: definition.environment } : {}),
          ...(definition.headers ? { headers: definition.headers } : {}),
          ...(typeof definition.timeout === "number" ? { timeout: definition.timeout } : {}),
          ...(definition.oauth !== undefined ? { oauth: definition.oauth } : {}),
          ...(Array.isArray(definition.expose?.include) ? { include: definition.expose.include } : {}),
          ...(Array.isArray(definition.expose?.exclude) ? { exclude: definition.expose.exclude } : {})
        } satisfies DiscoveredToolServer
      ];
    })
  );
}

export async function loadPlatformToolServers(toolDir: string): Promise<Record<string, DiscoveredToolServer>> {
  return loadWorkspaceToolServers(toolDir);
}

export async function loadWorkspaceAgents(workspaceRoot: string): Promise<Record<string, DiscoveredAgent>> {
  const agentsDir = path.join(workspaceRoot, ".openharness", "agents");
  const directoryEntries = await readDirectoryEntriesIfExists(agentsDir);
  const agents: Record<string, DiscoveredAgent> = {};

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(agentsDir, entry.name);
    const fileContent = await readFile(filePath, "utf8");
    const parsed = matter(fileContent);
    const prompt = parsed.content.trim();
    if (!prompt) {
      throw new Error(`Agent definition in ${filePath} is missing markdown prompt content.`);
    }

    const data = parsed.data as Record<string, unknown>;
    const name = entry.name.replace(/\.md$/u, "");
    const mode = data.mode === "primary" || data.mode === "subagent" || data.mode === "all" ? data.mode : "primary";
    const model = data.model && typeof data.model === "object" ? (data.model as Record<string, unknown>) : undefined;
    const tools = data.tools && typeof data.tools === "object" ? (data.tools as Record<string, unknown>) : undefined;
    const disallowed =
      data.disallowed && typeof data.disallowed === "object" ? (data.disallowed as Record<string, unknown>) : undefined;
    const disallowedTools =
      disallowed?.tools && typeof disallowed.tools === "object"
        ? (disallowed.tools as Record<string, unknown>)
        : undefined;
    const policy = data.policy && typeof data.policy === "object" ? (data.policy as Record<string, unknown>) : undefined;

    const externalTools = Array.isArray(tools?.external)
      ? tools.external.filter((item): item is string => typeof item === "string")
      : [];
    const configuredActions = Array.isArray(data.actions)
      ? data.actions.filter((item): item is string => typeof item === "string")
      : Array.isArray(tools?.actions)
        ? tools.actions.filter((item): item is string => typeof item === "string")
        : [];
    const configuredSkills = Array.isArray(data.skills)
      ? data.skills.filter((item): item is string => typeof item === "string")
      : Array.isArray(tools?.skills)
        ? tools.skills.filter((item): item is string => typeof item === "string")
        : [];
    const disallowedNativeTools = Array.isArray(disallowedTools?.native)
      ? disallowedTools.native.filter((item): item is string => typeof item === "string")
      : [];
    const disallowedExternalTools = Array.isArray(disallowedTools?.external)
      ? disallowedTools.external.filter((item): item is string => typeof item === "string")
      : [];
    const disallowedActions = Array.isArray(disallowed?.actions)
      ? disallowed.actions.filter((item): item is string => typeof item === "string")
      : [];
    const disallowedSkills = Array.isArray(disallowed?.skills)
      ? disallowed.skills.filter((item): item is string => typeof item === "string")
      : [];

    agents[name] = {
      name,
      mode,
      ...(typeof data.description === "string" ? { description: data.description } : {}),
      prompt,
      ...(typeof data.system_reminder === "string" ? { systemReminder: data.system_reminder } : {}),
      ...(typeof model?.model_ref === "string" ? { modelRef: model.model_ref } : {}),
      ...(typeof model?.temperature === "number" ? { temperature: model.temperature } : {}),
      ...(typeof model?.top_p === "number" ? { topP: model.top_p } : {}),
      ...(typeof model?.max_tokens === "number" ? { maxTokens: model.max_tokens } : {}),
      ...(typeof data.background === "boolean" ? { background: data.background } : {}),
      ...(typeof data.hidden === "boolean" ? { hidden: data.hidden } : {}),
      ...(typeof data.color === "string" ? { color: data.color } : {}),
      tools: {
        native: Array.isArray(tools?.native) ? tools.native.filter((item): item is string => typeof item === "string") : [],
        external: externalTools,
        ...(Array.isArray(tools?.actions)
          ? { actions: tools.actions.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(Array.isArray(tools?.skills)
          ? { skills: tools.skills.filter((item): item is string => typeof item === "string") }
          : {})
      },
      ...(configuredActions.length > 0 ? { actions: configuredActions } : {}),
      ...(configuredSkills.length > 0 ? { skills: configuredSkills } : {}),
      ...(disallowedNativeTools.length > 0 ||
      disallowedExternalTools.length > 0 ||
      disallowedActions.length > 0 ||
      disallowedSkills.length > 0
        ? {
            disallowed: {
              ...(disallowedNativeTools.length > 0 || disallowedExternalTools.length > 0
                ? {
                    tools: {
                      ...(disallowedNativeTools.length > 0 ? { native: disallowedNativeTools } : {}),
                      ...(disallowedExternalTools.length > 0 ? { external: disallowedExternalTools } : {})
                    }
                  }
                : {}),
              ...(disallowedActions.length > 0 ? { actions: disallowedActions } : {}),
              ...(disallowedSkills.length > 0 ? { skills: disallowedSkills } : {})
            }
          }
        : {}),
      switch: Array.isArray(data.switch) ? data.switch.filter((item): item is string => typeof item === "string") : [],
      subagents: Array.isArray(data.subagents)
        ? data.subagents.filter((item): item is string => typeof item === "string")
        : [],
      ...(policy
        ? {
            policy: {
              ...(typeof policy.max_steps === "number" ? { maxSteps: policy.max_steps } : {}),
              ...(typeof policy.run_timeout_seconds === "number"
                ? { runTimeoutSeconds: policy.run_timeout_seconds }
                : {}),
              ...(typeof policy.tool_timeout_seconds === "number"
                ? { toolTimeoutSeconds: policy.tool_timeout_seconds }
                : {}),
              ...(typeof policy.parallel_tool_calls === "boolean"
                ? { parallelToolCalls: policy.parallel_tool_calls }
                : {}),
              ...(typeof policy.max_concurrent_subagents === "number"
                ? { maxConcurrentSubagents: policy.max_concurrent_subagents }
                : {})
            }
          }
        : {})
    };
  }

  return agents;
}

export async function loadWorkspaceActions(workspaceRoot: string): Promise<Record<string, DiscoveredAction>> {
  const actionsDir = path.join(workspaceRoot, ".openharness", "actions");
  const directoryEntries = await readDirectoryEntriesIfExists(actionsDir);
  const schema = await loadSchema<object>("../../../docs/schemas/action.schema.json");
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  const actions: Record<string, DiscoveredAction> = {};

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const actionDirectory = path.join(actionsDir, entry.name);
    const actionFilePath = path.join(actionDirectory, "ACTION.yaml");
    if (!(await pathExists(actionFilePath))) {
      continue;
    }

    const fileContent = await readFile(actionFilePath, "utf8");
    const parsed = expandEnv(YAML.parse(fileContent) ?? {});
    if (!validate(parsed)) {
      throw new Error(`Invalid action config in ${actionFilePath}: ${validationMessage(validate.errors)}`);
    }

    const actionData = parsed as {
      name: string;
      description: string;
      expose?: {
        to_llm?: boolean;
        callable_by_user?: boolean;
        callable_by_api?: boolean;
      };
      recovery?: {
        retry_policy?: ActionRetryPolicy;
      };
      input_schema?: Record<string, unknown>;
      entry: {
        command: string;
        environment?: Record<string, string>;
        cwd?: string;
        timeout_seconds?: number;
      };
    };

    if (actions[actionData.name]) {
      throw new Error(`Duplicate action name detected: ${actionData.name}`);
    }

    actions[actionData.name] = {
      name: actionData.name,
      description: actionData.description,
      callableByApi: actionData.expose?.callable_by_api ?? true,
      callableByUser: actionData.expose?.callable_by_user ?? true,
      exposeToLlm: actionData.expose?.to_llm ?? true,
      ...(actionData.recovery?.retry_policy ? { retryPolicy: actionData.recovery.retry_policy } : {}),
      inputSchema: actionData.input_schema,
      directory: actionDirectory,
      entry: {
        command: actionData.entry.command,
        environment: actionData.entry.environment,
        cwd: actionData.entry.cwd,
        timeoutSeconds: actionData.entry.timeout_seconds
      }
    };
  }

  return actions;
}

export async function loadWorkspaceHooks(workspaceRoot: string): Promise<Record<string, DiscoveredHook>> {
  const hooksDir = path.join(workspaceRoot, ".openharness", "hooks");
  const directoryEntries = await readDirectoryEntriesIfExists(hooksDir);
  const schema = await loadSchema<object>("../../../docs/schemas/hook.schema.json");
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  const hooks: Record<string, DiscoveredHook> = {};

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }

    const filePath = path.join(hooksDir, entry.name);
    const fileContent = await readFile(filePath, "utf8");
    const parsed = expandEnv(YAML.parse(fileContent) ?? {});
    if (!validate(parsed)) {
      throw new Error(`Invalid hook config in ${filePath}: ${validationMessage(validate.errors)}`);
    }

    const hook = parsed as {
      name: string;
      events: string[];
      matcher?: string;
      capabilities?: string[];
      handler: {
        type: "command" | "http" | "prompt" | "agent";
      };
    };

    if (hooks[hook.name]) {
      throw new Error(`Duplicate hook name detected: ${hook.name}`);
    }

    hooks[hook.name] = {
      name: hook.name,
      events: hook.events,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      handlerType: hook.handler.type,
      capabilities: hook.capabilities ?? [],
      definition: parsed as Record<string, unknown>
    };
  }

  return hooks;
}

function resolveSkillRoots(workspaceRoot: string, settings: WorkspaceSettings): string[] {
  const workspaceSkillRoot = path.join(workspaceRoot, ".openharness", "skills");
  const configuredSkillRoots = (settings.skillDirs ?? []).map((skillDir) => path.resolve(workspaceRoot, skillDir));
  return [workspaceSkillRoot, ...configuredSkillRoots];
}

export async function discoverWorkspace(
  rootPath: string,
  kind: "project",
  input: {
    platformModels: PlatformModelRegistry;
    platformAgents?: PlatformAgentRegistry;
    platformSkills?: Record<string, DiscoveredSkill>;
    platformToolServers?: Record<string, DiscoveredToolServer>;
    platformSkillDir?: string;
    platformToolDir?: string;
  }
) {
  const settings = await loadWorkspaceSettings(rootPath);
  const workspaceModels = await loadWorkspaceModels(rootPath);
  const workspaceAgents = await loadWorkspaceAgents(rootPath);
  const agents = Object.keys(workspaceAgents).length > 0 ? workspaceAgents : (input.platformAgents ?? {});
  const agentSources = Object.fromEntries(
    Object.keys(agents).map((name) => [name, name in workspaceAgents ? ("workspace" as const) : ("platform" as const)])
  );
  const actions = await loadWorkspaceActions(rootPath);
  const skills = await loadSkillsFromRoots(resolveSkillRoots(rootPath, settings));
  const toolServers = await loadWorkspaceToolServers(path.join(rootPath, ".openharness", "tools"), {
    workingDirectory: rootPath
  });
  const hooks = await loadWorkspaceHooks(rootPath);
  const projectAgentsMd = await loadProjectAgentsMd(rootPath);
  const name = path.basename(rootPath);
  const id = buildWorkspaceId(kind, name, rootPath);
  const models = [...toPlatformModelCatalogItems(input.platformModels), ...toWorkspaceModelCatalogItems(workspaceModels)];
  const timestamp = nowIso();
  const catalog = createWorkspaceCatalog(id, models);
  catalog.agents = toAgentCatalogItems(agents, agentSources);
  catalog.actions = toActionCatalogItems(actions);
  catalog.skills = toSkillCatalogItems(skills);
  catalog.tools = toToolCatalogItems(toolServers);
  catalog.hooks = toHookCatalogItems(hooks);

  return {
    id,
    name,
    ...(settings.blueprint ? { blueprint: settings.blueprint } : {}),
    rootPath,
    executionPolicy: "local" as const,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind,
    readOnly: false,
    historyMirrorEnabled: true,
    defaultAgent: settings.defaultAgent,
    projectAgentsMd,
    settings,
    workspaceModels,
    agents,
    actions,
    skills,
    toolServers,
    hooks,
    catalog
  } satisfies DiscoveredWorkspace;
}

export async function discoverWorkspaces(input: {
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "tool_dir" | "skill_dir">;
  platformModels: PlatformModelRegistry;
  platformAgents?: PlatformAgentRegistry;
  onError?: ((input: { rootPath: string; kind: "project"; error: unknown }) => void) | undefined;
}): Promise<DiscoveredWorkspace[]> {
  const projectEntries = await readDirectoryEntriesIfExists(input.paths.workspace_dir);

  const projects = await Promise.all(
    projectEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const rootPath = path.join(input.paths.workspace_dir, entry.name);
        try {
          return await discoverWorkspace(rootPath, "project", {
            platformModels: input.platformModels,
            ...(input.platformAgents ? { platformAgents: input.platformAgents } : {})
          });
        } catch (error) {
          if (!input.onError) {
            throw error;
          }

          input.onError({
            rootPath,
            kind: "project",
            error
          });
          return undefined;
        }
      })
  );

  return projects.filter(isDefined);
}
