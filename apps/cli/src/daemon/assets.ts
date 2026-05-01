import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
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

async function loadAssetContext(options: AssetCommandOptions) {
  const paths = await initDaemonHome(options);
  const config = await loadServerConfig(paths.configPath);
  return { paths, config };
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
