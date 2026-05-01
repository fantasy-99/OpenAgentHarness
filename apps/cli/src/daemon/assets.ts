import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DiscoveredToolServer,
  listWorkspaceRuntimes,
  loadPlatformModels,
  loadPlatformSkills,
  loadPlatformToolServers,
  loadServerConfig
} from "@oah/config";

import { initDaemonHome } from "./lifecycle.js";

export type AssetCommandOptions = {
  home?: string | undefined;
};

export type AddModelOptions = AssetCommandOptions & {
  overwrite?: boolean | undefined;
};

export type EnableWorkspaceAssetOptions = AssetCommandOptions & {
  workspace?: string | undefined;
  overwrite?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export async function listModels(options: AssetCommandOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const models = await loadPlatformModels(context.config.paths.model_dir);
  const entries = Object.entries(models).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return `No models found in ${context.config.paths.model_dir}.`;
  }
  return entries
    .map(([name, definition]) => {
      const provider = definition.provider;
      const modelName = definition.name;
      const url = definition.url ? ` · ${definition.url}` : "";
      const defaultMarker = name === context.config.llm.default_model ? " (default)" : "";
      return `${name}${defaultMarker} · ${provider}/${modelName}${url}`;
    })
    .join("\n");
}

export async function addModel(filePath: string, options: AddModelOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const sourcePath = path.resolve(process.cwd(), filePath);
  const fileName = path.basename(sourcePath);
  if (!fileName.endsWith(".yaml") && !fileName.endsWith(".yml")) {
    throw new Error("Model config must be a .yaml or .yml file.");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-model-add-"));
  try {
    await cp(sourcePath, path.join(tempDir, fileName), { force: true });
    const incomingModels = await loadPlatformModels(tempDir);
    const incomingNames = Object.keys(incomingModels).sort();
    if (incomingNames.length === 0) {
      throw new Error(`No model definitions found in ${sourcePath}.`);
    }

    const existingModels = await loadPlatformModels(context.config.paths.model_dir);
    const conflicts = incomingNames.filter((name) => existingModels[name]);
    if (conflicts.length > 0 && !options.overwrite) {
      throw new Error(`Model already exists: ${conflicts.join(", ")}. Use --overwrite to replace.`);
    }

    await mkdir(context.config.paths.model_dir, { recursive: true });
    const targetPath = path.join(context.config.paths.model_dir, fileName);
    await cp(sourcePath, targetPath, { force: Boolean(options.overwrite), errorOnExist: !options.overwrite });
    return `Added model file ${targetPath}: ${incomingNames.join(", ")}`;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function setDefaultModel(modelRef: string, options: AssetCommandOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const models = await loadPlatformModels(context.config.paths.model_dir);
  if (!models[modelRef]) {
    throw new Error(`Model ${modelRef} was not found in ${context.config.paths.model_dir}. Add it before making it default.`);
  }

  const current = await readFile(context.paths.configPath, "utf8");
  const next = setYamlSectionScalar(current, "llm", "default_model", modelRef);
  await writeFile(context.paths.configPath, next, "utf8");
  return `Default model set to ${modelRef} in ${context.paths.configPath}.`;
}

export async function listRuntimes(options: AssetCommandOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const runtimes = await listWorkspaceRuntimes(context.config.paths.runtime_dir);
  if (runtimes.length === 0) {
    return `No runtimes found in ${context.config.paths.runtime_dir}.`;
  }
  return runtimes.map((runtime) => runtime.name).join("\n");
}

export async function listTools(options: AssetCommandOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const tools = await loadPlatformToolServers(context.config.paths.tool_dir);
  const entries = Object.values(tools).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    return `No tools found in ${context.config.paths.tool_dir}.`;
  }
  return entries
    .map((tool) => `${tool.name} · ${tool.transportType}${tool.enabled ? "" : " · disabled"}${tool.toolPrefix ? ` · ${tool.toolPrefix}` : ""}`)
    .join("\n");
}

export async function listSkills(options: AssetCommandOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const skills = await loadPlatformSkills(context.config.paths.skill_dir);
  const entries = Object.values(skills).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    return `No skills found in ${context.config.paths.skill_dir}.`;
  }
  return entries.map((skill) => `${skill.name}${skill.description ? ` · ${skill.description}` : ""}`).join("\n");
}

export async function enableTool(name: string, options: EnableWorkspaceAssetOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const workspaceRoot = await resolveWorkspaceRoot(options.workspace);
  const toolServers = await loadPlatformToolServers(context.config.paths.tool_dir);
  const toolServer = toolServers[name];
  if (!toolServer) {
    throw new Error(`Tool ${name} was not found in ${context.config.paths.tool_dir}.`);
  }

  const toolsRoot = path.join(workspaceRoot, ".openharness", "tools");
  const targetServersRoot = path.join(toolsRoot, "servers");
  const targetDirectory = resolvePathInsideRoot(targetServersRoot, name, "tool server name");
  const settingsPath = path.join(toolsRoot, "settings.yaml");
  const sourceDirectory = await findToolSourceDirectory(context.config.paths.tool_dir, name);
  const settings = await readWorkspaceToolSettings(settingsPath);
  const hasSettingsConflict = Object.prototype.hasOwnProperty.call(settings, name);
  const targetExists = sourceDirectory ? await pathExists(targetDirectory) : false;

  if ((hasSettingsConflict || targetExists) && !options.overwrite) {
    const conflicts = [
      ...(hasSettingsConflict ? [`${settingsPath} already defines ${name}`] : []),
      ...(targetExists ? [`${targetDirectory} already exists`] : [])
    ];
    throw new Error(`Tool ${name} is already enabled. ${conflicts.join("; ")}. Use --overwrite to replace.`);
  }

  const serializedDefinition = serializeToolServerDefinition(toolServer);
  if (typeof serializedDefinition.command === "string") {
    serializedDefinition.command = rewriteImportedToolCommandForWorkspace(
      serializedDefinition.command,
      context.config.paths.tool_dir,
      name
    );
  }

  if (options.dryRun) {
    return [
      `Would enable tool ${name} in ${workspaceRoot}.`,
      `Would ${hasSettingsConflict ? "update" : "write"} ${settingsPath}.`,
      sourceDirectory ? `Would copy ${sourceDirectory} to ${targetDirectory}.` : "No local tool server directory would be copied."
    ].join("\n");
  }

  await mkdir(toolsRoot, { recursive: true });
  if (sourceDirectory) {
    await mkdir(targetServersRoot, { recursive: true });
    await rm(targetDirectory, { recursive: true, force: true });
    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: false,
      preserveTimestamps: true
    });
  }

  await writeWorkspaceToolSettings(settingsPath, {
    ...settings,
    [name]: serializedDefinition
  });

  return `Enabled tool ${name} in ${workspaceRoot}.`;
}

export async function enableSkill(name: string, options: EnableWorkspaceAssetOptions = {}): Promise<string> {
  const context = await loadAssetContext(options);
  const workspaceRoot = await resolveWorkspaceRoot(options.workspace);
  const skills = await loadPlatformSkills(context.config.paths.skill_dir);
  const skill = skills[name];
  if (!skill) {
    throw new Error(`Skill ${name} was not found in ${context.config.paths.skill_dir}.`);
  }

  const skillsRoot = path.join(workspaceRoot, ".openharness", "skills");
  const targetDirectory = resolvePathInsideRoot(skillsRoot, name, "skill name");
  const targetExists = await pathExists(targetDirectory);

  if (targetExists && !options.overwrite) {
    throw new Error(`Skill ${name} is already enabled at ${targetDirectory}. Use --overwrite to replace.`);
  }

  if (options.dryRun) {
    return [
      `Would enable skill ${name} in ${workspaceRoot}.`,
      `Would copy ${skill.directory} to ${targetDirectory}.`
    ].join("\n");
  }

  await mkdir(skillsRoot, { recursive: true });
  await rm(targetDirectory, { recursive: true, force: true });
  await cp(skill.directory, targetDirectory, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true
  });

  return `Enabled skill ${name} in ${workspaceRoot}.`;
}

async function loadAssetContext(options: AssetCommandOptions) {
  const paths = await initDaemonHome(options);
  const config = await loadServerConfig(paths.configPath);
  return { paths, config };
}

async function resolveWorkspaceRoot(workspacePath: string | undefined): Promise<string> {
  const workspaceRoot = path.resolve(process.cwd(), workspacePath ?? ".");
  const stats = await stat(workspaceRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Workspace path was not found or is not a directory: ${workspaceRoot}`);
  }
  return workspaceRoot;
}

async function findToolSourceDirectory(platformToolDir: string, name: string): Promise<string | undefined> {
  const candidates = [
    resolvePathInsideRoot(path.join(platformToolDir, "servers"), name, "tool server name"),
    resolvePathInsideRoot(platformToolDir, name, "tool server name")
  ];

  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => null);
    if (stats?.isDirectory()) {
      return candidate;
    }
  }

  return undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return Boolean(await stat(targetPath).catch(() => null));
}

function resolvePathInsideRoot(rootPath: string, relativePath: string, label: string): string {
  const resolvedPath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${label}: ${relativePath}`);
  }

  return resolvedPath;
}

async function readWorkspaceToolSettings(settingsPath: string): Promise<Record<string, Record<string, unknown>>> {
  const settingsExists = await pathExists(settingsPath);
  if (!settingsExists) {
    return {};
  }

  const YAML = (await import("yaml")).default;
  const parsed = YAML.parse(await readFile(settingsPath, "utf8")) ?? {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid existing MCP settings in ${settingsPath}.`);
  }

  return parsed as Record<string, Record<string, unknown>>;
}

async function writeWorkspaceToolSettings(
  settingsPath: string,
  settings: Record<string, Record<string, unknown>>
): Promise<void> {
  const YAML = (await import("yaml")).default;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, YAML.stringify(settings), "utf8");
}

function serializeToolServerDefinition(server: DiscoveredToolServer): Record<string, unknown> {
  return {
    ...(server.command ? { command: server.command } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.enabled !== true ? { enabled: server.enabled } : {}),
    ...(server.environment ? { environment: server.environment } : {}),
    ...(server.headers ? { headers: server.headers } : {}),
    ...(typeof server.timeout === "number" ? { timeout: server.timeout } : {}),
    ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
    ...(server.toolPrefix || server.include || server.exclude
      ? {
          expose: {
            ...(server.toolPrefix ? { tool_prefix: server.toolPrefix } : {}),
            ...(server.include ? { include: server.include } : {}),
            ...(server.exclude ? { exclude: server.exclude } : {})
          }
        }
      : {})
  };
}

function rewriteImportedToolCommandForWorkspace(command: string, platformToolDir: string, toolName: string): string {
  const workspaceToolPrefix = `./.openharness/tools/servers/${toolName}`;
  const existingWorkspacePrefixes = [workspaceToolPrefix, workspaceToolPrefix.replace(/^\.\//u, "")];

  if (existingWorkspacePrefixes.some((prefix) => command.includes(prefix))) {
    return command;
  }

  const replacementCandidates = [
    path.join(platformToolDir, "servers", toolName),
    path.join(platformToolDir, toolName),
    `./servers/${toolName}`,
    `servers/${toolName}`,
    `./${toolName}`
  ]
    .map((candidate) => candidate.trim())
    .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  for (const candidate of replacementCandidates) {
    if (command.includes(candidate)) {
      return command.split(candidate).join(workspaceToolPrefix);
    }
  }

  return command;
}

function setYamlSectionScalar(content: string, sectionName: string, key: string, value: string): string {
  const lines = content.replace(/\s*$/u, "\n").split("\n");
  const sectionIndex = lines.findIndex((line) => line === `${sectionName}:`);
  const nextLine = `  ${key}: ${JSON.stringify(value)}`;
  if (sectionIndex < 0) {
    return `${lines.join("\n")}${sectionName}:\n${nextLine}\n`;
  }

  const nextRootIndex = lines.findIndex((line, index) => index > sectionIndex && line.trim().length > 0 && !line.startsWith(" "));
  const sectionEnd = nextRootIndex < 0 ? lines.length : nextRootIndex;
  const keyIndex = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && line.match(new RegExp(`^\\s+${key}:`)));
  if (keyIndex >= 0) {
    lines[keyIndex] = nextLine;
  } else {
    lines.splice(sectionIndex + 1, 0, nextLine);
  }
  return lines.join("\n").replace(/\n*$/u, "\n");
}
