import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

import type {
  DiscoveredToolServer,
  InitializeWorkspaceFromRuntimeInput,
  WorkspaceRuntimeDescriptor,
  WorkspaceRuntimeSkill
} from "./types.js";
import { pathExists, readDirectoryEntriesIfExists, resolvePathInsideRoot } from "./shared.js";
import { loadPlatformToolServers, loadWorkspaceSettings, updateWorkspaceRuntimeSetting } from "./workspace.js";

async function appendAgentsMd(rootPath: string, agentsMd: string): Promise<void> {
  const agentsPath = path.join(rootPath, "AGENTS.md");
  const appendedContent = agentsMd.trim();
  if (!appendedContent) {
    return;
  }

  const existingContent = (await pathExists(agentsPath)) ? (await readFile(agentsPath, "utf8")).trim() : "";
  const mergedContent = existingContent ? `${existingContent}\n\n${appendedContent}\n` : `${appendedContent}\n`;
  await writeFile(agentsPath, mergedContent, "utf8");
}

async function mergeWorkspaceToolSettings(
  rootPath: string,
  toolServers: Record<string, Record<string, unknown>>
): Promise<void> {
  if (Object.keys(toolServers).length === 0) {
    return;
  }

  const toolsRoot = path.join(rootPath, ".openharness", "tools");
  const settingsPath = path.join(toolsRoot, "settings.yaml");
  await mkdir(toolsRoot, { recursive: true });

  const YAML = (await import("yaml")).default;
  const currentSettingsRaw = (await pathExists(settingsPath)) ? YAML.parse(await readFile(settingsPath, "utf8")) : {};
  if (!currentSettingsRaw || typeof currentSettingsRaw !== "object" || Array.isArray(currentSettingsRaw)) {
    throw new Error(`Invalid existing MCP settings in ${settingsPath}.`);
  }

  await writeFile(
    settingsPath,
    YAML.stringify({
      ...(currentSettingsRaw as Record<string, unknown>),
      ...toolServers
    }),
    "utf8"
  );
}

async function writeWorkspaceSkills(rootPath: string, skills: WorkspaceRuntimeSkill[]): Promise<void> {
  if (skills.length === 0) {
    return;
  }

  const skillsRoot = path.join(rootPath, ".openharness", "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skill of skills) {
    const skillDirectory = resolvePathInsideRoot(skillsRoot, skill.name, "skill name");
    await rm(skillDirectory, { recursive: true, force: true });
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), `${skill.content.trim()}\n`, "utf8");
  }
}

function uniqueNames(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
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

function rewriteImportedToolCommandForWorkspace(
  command: string,
  platformToolDir: string,
  toolName: string
): string {
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

async function importRuntimeSkills(
  rootPath: string,
  platformSkillDir: string | undefined,
  importedSkillNames: string[]
): Promise<void> {
  if (importedSkillNames.length === 0) {
    return;
  }

  if (!platformSkillDir) {
    throw new Error("Runtime requested skill imports, but platformSkillDir was not provided.");
  }

  const skillsRoot = path.join(rootPath, ".openharness", "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skillName of importedSkillNames) {
    const sourceDirectory = resolvePathInsideRoot(platformSkillDir, skillName, "runtime skill import");
    const sourceStats = await stat(sourceDirectory).catch(() => null);
    if (!sourceStats?.isDirectory()) {
      throw new Error(`Runtime skill import was not found: ${skillName}`);
    }

    const targetDirectory = resolvePathInsideRoot(skillsRoot, skillName, "skill name");
    await rm(targetDirectory, { recursive: true, force: true });
    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
}

async function importEngineTools(
  rootPath: string,
  platformToolDir: string | undefined,
  importedToolNames: string[]
): Promise<void> {
  if (importedToolNames.length === 0) {
    return;
  }

  if (!platformToolDir) {
    throw new Error("Runtime requested tool imports, but platformToolDir was not provided.");
  }

  const platformToolServers = await loadPlatformToolServers(platformToolDir);
  const importedToolDefinitions: Record<string, Record<string, unknown>> = {};
  const targetServersRoot = path.join(rootPath, ".openharness", "tools", "servers");
  await mkdir(targetServersRoot, { recursive: true });

  for (const toolName of importedToolNames) {
    const toolServer = platformToolServers[toolName];
    if (!toolServer) {
      throw new Error(`Runtime tool import was not found: ${toolName}`);
    }

    const serializedDefinition = serializeToolServerDefinition(toolServer);

    const sourceDirectoryCandidates = [path.join(platformToolDir, "servers", toolName), path.join(platformToolDir, toolName)];
    let sourceDirectory: string | undefined;

    for (const candidate of sourceDirectoryCandidates) {
      const candidateStats = await stat(candidate).catch(() => null);
      if (candidateStats?.isDirectory()) {
        sourceDirectory = candidate;
        break;
      }
    }

    if (!sourceDirectory) {
      importedToolDefinitions[toolName] = serializedDefinition;
      continue;
    }

    const targetDirectory = resolvePathInsideRoot(targetServersRoot, toolName, "tool server name");
    await rm(targetDirectory, { recursive: true, force: true });
    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: false
    });

    if (typeof serializedDefinition.command === "string") {
      serializedDefinition.command = rewriteImportedToolCommandForWorkspace(
        serializedDefinition.command,
        platformToolDir,
        toolName
      );
    }

    importedToolDefinitions[toolName] = serializedDefinition;
  }

  await mergeWorkspaceToolSettings(rootPath, importedToolDefinitions);
}

export async function initializeWorkspaceFromRuntime(input: InitializeWorkspaceFromRuntimeInput): Promise<void> {
  const runtimePath = resolvePathInsideRoot(input.runtimeDir, input.runtimeName, "runtime name");
  const runtimeStats = await stat(runtimePath).catch(() => null);
  if (!runtimeStats?.isDirectory()) {
    throw new Error(`Workspace runtime was not found: ${input.runtimeName}`);
  }

  if (await pathExists(input.rootPath)) {
    throw new Error(`Workspace root already exists: ${input.rootPath}`);
  }

  await mkdir(path.dirname(input.rootPath), { recursive: true });
  await cp(runtimePath, input.rootPath, {
    recursive: true,
    force: false,
    errorOnExist: true
  });

  const runtimeSettings = await loadWorkspaceSettings(input.rootPath);
  const importedToolNames = uniqueNames(runtimeSettings.imports?.tools);
  const importedSkillNames = uniqueNames(runtimeSettings.imports?.skills);

  await importEngineTools(input.rootPath, input.platformToolDir, importedToolNames);
  await importRuntimeSkills(input.rootPath, input.platformSkillDir, importedSkillNames);

  if (input.agentsMd) {
    await appendAgentsMd(input.rootPath, input.agentsMd);
  }

  if (input.toolServers) {
    await mergeWorkspaceToolSettings(input.rootPath, input.toolServers);
  }

  if (input.skills) {
    await writeWorkspaceSkills(input.rootPath, input.skills);
  }

  await updateWorkspaceRuntimeSetting(input.rootPath, input.runtimeName);
}

export async function listWorkspaceRuntimes(runtimeDir: string): Promise<WorkspaceRuntimeDescriptor[]> {
  const directoryEntries = await readDirectoryEntriesIfExists(runtimeDir);
  return directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isSkippableZipEntry(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  const topEntry = normalized.split("/")[0];
  return topEntry === "__MACOSX" || topEntry === ".DS_Store" || normalized.endsWith("/.DS_Store");
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(err);
      } else {
        resolve(zipfile);
      }
    });
  });
}

function readZipEntry(readable: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (chunk: Buffer) => chunks.push(chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

export async function uploadWorkspaceRuntime(input: {
  runtimeDir: string;
  runtimeName: string;
  zipBuffer: Buffer;
  overwrite?: boolean;
}): Promise<WorkspaceRuntimeDescriptor> {
  const targetDir = resolvePathInsideRoot(input.runtimeDir, input.runtimeName, "runtime name");
  const runtimeExists = await pathExists(targetDir);

  if (runtimeExists && !input.overwrite) {
    const err = new Error(`Runtime "${input.runtimeName}" already exists`);
    (err as Error & { statusCode?: number }).statusCode = 409;
    (err as Error & { code?: string }).code = "runtime_already_exists";
    throw err;
  }

  if (runtimeExists) {
    await rm(targetDir, { recursive: true });
  }

  await mkdir(targetDir, { recursive: true });

  const zipfile = await openZip(input.zipBuffer);

  return new Promise<WorkspaceRuntimeDescriptor>((resolve, reject) => {
    let entryCount = 0;

    zipfile.on("error", reject);

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const fileName = entry.fileName;

      if (fileName.endsWith("/")) {
        zipfile.readEntry();
        return;
      }

      if (isSkippableZipEntry(fileName)) {
        zipfile.readEntry();
        return;
      }

      const resolvedEntryPath = path.resolve(targetDir, fileName);
      const relative = path.relative(targetDir, resolvedEntryPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        reject(new Error(`Zip entry "${fileName}" escapes the runtime directory`));
        return;
      }

      entryCount++;

      zipfile.openReadStream(entry, async (err, readable) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          const parentDir = path.dirname(resolvedEntryPath);
          await mkdir(parentDir, { recursive: true });

          const data = await readZipEntry(readable);
          await writeFile(resolvedEntryPath, data);

          zipfile.readEntry();
        } catch (writeErr) {
          reject(writeErr);
        }
      });
    });

    zipfile.on("end", async () => {
      if (entryCount === 0) {
        await rm(targetDir, { recursive: true }).catch(() => {});
        const err = new Error("Zip archive contains no files");
        (err as Error & { statusCode?: number }).statusCode = 400;
        (err as Error & { code?: string }).code = "empty_runtime_zip";
        reject(err);
        return;
      }

      resolve({ name: input.runtimeName });
    });

    zipfile.readEntry();
  });
}

export async function deleteWorkspaceRuntime(input: {
  runtimeDir: string;
  runtimeName: string;
}): Promise<void> {
  const targetDir = resolvePathInsideRoot(input.runtimeDir, input.runtimeName, "runtime name");

  if (!(await pathExists(targetDir))) {
    const err = new Error(`Runtime "${input.runtimeName}" does not exist`);
    (err as Error & { statusCode?: number }).statusCode = 404;
    (err as Error & { code?: string }).code = "runtime_not_found";
    throw err;
  }

  await rm(targetDir, { recursive: true });
}
