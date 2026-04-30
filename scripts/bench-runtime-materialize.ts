import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { initializeWorkspaceFromRuntime } from "../packages/config/src/runtimes.ts";
import { loadPlatformToolServers, loadWorkspaceSettings } from "../packages/config/src/workspace.ts";
import { shutdownNativeWorkspaceSyncWorkerPool } from "../packages/native-bridge/src/index.ts";

type BenchmarkMode = "ts" | "oneshot" | "persistent";

interface BenchmarkOptions {
  iterations: number;
  deployRoot?: string | undefined;
  runtimeName?: string | undefined;
  runtimeLimit: number;
  syntheticFiles: number;
  syntheticSizeBytes: number;
  syntheticTools: number;
  syntheticSkills: number;
}

interface SourceSet {
  label: string;
  runtimeDir: string;
  runtimeName: string;
  platformToolDir?: string | undefined;
  platformSkillDir?: string | undefined;
  cleanup?: (() => Promise<void>) | undefined;
}

interface Inventory {
  files: number;
  directories: number;
  bytes: number;
}

interface BenchmarkRow {
  scenario: string;
  mode: BenchmarkMode;
  files: number;
  directories: number;
  bytes: number;
  iterations: number;
  firstMs: number;
  warmAvgMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  iterations: Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_ITERATIONS || "8", 10) || 8,
  deployRoot: process.env.OAH_DEPLOY_ROOT?.trim() || undefined,
  runtimeName: process.env.OAH_BENCH_RUNTIME_MATERIALIZE_RUNTIME_NAME?.trim() || undefined,
  runtimeLimit: Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_RUNTIME_LIMIT || "4", 10) || 4,
  syntheticFiles: Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_SYNTHETIC_FILES || "1024", 10) || 1024,
  syntheticSizeBytes:
    Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_SYNTHETIC_SIZE_BYTES || "1024", 10) || 1024,
  syntheticTools: Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_SYNTHETIC_TOOLS || "2", 10) || 2,
  syntheticSkills: Number.parseInt(process.env.OAH_BENCH_RUNTIME_MATERIALIZE_SYNTHETIC_SKILLS || "2", 10) || 2
};

const WORKSPACE_SYNC_BINARY_BASENAME = process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync";

async function resolveDeployAssetRoot(deployRoot: string): Promise<string> {
  const root = path.resolve(deployRoot);
  const hasFlatAssets = await Promise.all(
    ["runtimes", "models", "tools", "skills", "workspaces", "archives"].map((name) => pathExists(path.join(root, name)))
  );
  return hasFlatAssets.some(Boolean) ? root : path.join(root, "source");
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || value === undefined) {
      continue;
    }

    switch (arg) {
      case "--iterations":
        options.iterations = Math.max(1, Number.parseInt(value, 10) || options.iterations);
        index += 1;
        break;
      case "--deploy-root":
        options.deployRoot = path.resolve(value);
        index += 1;
        break;
      case "--runtime-name":
        options.runtimeName = value;
        index += 1;
        break;
      case "--runtime-limit":
        options.runtimeLimit = Math.max(1, Number.parseInt(value, 10) || options.runtimeLimit);
        index += 1;
        break;
      case "--synthetic-files":
        options.syntheticFiles = Math.max(1, Number.parseInt(value, 10) || options.syntheticFiles);
        index += 1;
        break;
      case "--synthetic-size-bytes":
        options.syntheticSizeBytes = Math.max(1, Number.parseInt(value, 10) || options.syntheticSizeBytes);
        index += 1;
        break;
      case "--synthetic-tools":
        options.syntheticTools = Math.max(0, Number.parseInt(value, 10) || options.syntheticTools);
        index += 1;
        break;
      case "--synthetic-skills":
        options.syntheticSkills = Math.max(0, Number.parseInt(value, 10) || options.syntheticSkills);
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function resolveKnownGoodWorkspaceSyncBinary(): Promise<string | undefined> {
  const configured = process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    path.resolve(process.cwd(), ".native-target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "debug", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "bin", WORKSPACE_SYNC_BINARY_BASENAME)
  ];

  for (const candidate of candidates) {
    if ((await pathExists(candidate)) && (await stat(candidate)).isFile()) {
      return candidate;
    }
  }

  return undefined;
}

async function collectInventory(rootDir: string): Promise<Inventory> {
  const inventory: Inventory = {
    files: 0,
    directories: 0,
    bytes: 0
  };

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        inventory.directories += 1;
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const metadata = await stat(entryPath);
      inventory.files += 1;
      inventory.bytes += metadata.size;
    }
  }

  await walk(rootDir);
  return inventory;
}

function addInventory(left: Inventory, right: Inventory): Inventory {
  return {
    files: left.files + right.files,
    directories: left.directories + right.directories,
    bytes: left.bytes + right.bytes
  };
}

async function collectMaterializedInventory(sourceSet: SourceSet): Promise<Inventory> {
  const runtimeRoot = path.join(sourceSet.runtimeDir, sourceSet.runtimeName);
  let inventory = await collectInventory(runtimeRoot);
  const settings = await loadWorkspaceSettings(runtimeRoot);

  if (sourceSet.platformToolDir && settings.imports?.tools) {
    const platformToolServers = await loadPlatformToolServers(sourceSet.platformToolDir);
    for (const toolName of uniqueNames(settings.imports.tools)) {
      if (!platformToolServers[toolName]) {
        continue;
      }
      const candidates = [
        path.join(sourceSet.platformToolDir, "servers", toolName),
        path.join(sourceSet.platformToolDir, toolName)
      ];
      for (const candidate of candidates) {
        if ((await pathExists(candidate)) && (await stat(candidate)).isDirectory()) {
          inventory = addInventory(inventory, await collectInventory(candidate));
          break;
        }
      }
    }
  }

  if (sourceSet.platformSkillDir && settings.imports?.skills) {
    for (const skillName of uniqueNames(settings.imports.skills)) {
      const candidate = path.join(sourceSet.platformSkillDir, skillName);
      if ((await pathExists(candidate)) && (await stat(candidate)).isDirectory()) {
        inventory = addInventory(inventory, await collectInventory(candidate));
      }
    }
  }

  return inventory;
}

function uniqueNames(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

async function writeFileSet(rootDir: string, prefix: string, files: number, sizeBytes: number): Promise<void> {
  const payload = "x".repeat(sizeBytes);
  const width = Math.max(4, String(files).length);
  for (let index = 0; index < files; index += 1) {
    const directory = path.join(rootDir, prefix, `group-${Math.floor(index / 64).toString().padStart(3, "0")}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index.toString().padStart(width, "0")}.txt`), payload);
  }
}

async function createSyntheticSourceSet(options: BenchmarkOptions): Promise<SourceSet> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oah-runtime-materialize-source-"));
  const runtimeName = "synthetic-runtime";
  const runtimeDir = path.join(root, "runtimes");
  const runtimeRoot = path.join(runtimeDir, runtimeName);
  const platformToolDir = path.join(root, "tools");
  const platformSkillDir = path.join(root, "skills");
  const importedTools = Array.from({ length: options.syntheticTools }, (_, index) => `tool-${index + 1}`);
  const importedSkills = Array.from({ length: options.syntheticSkills }, (_, index) => `skill-${index + 1}`);

  await mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, ".openharness", "settings.yaml"),
    [
      "imports:",
      importedTools.length > 0 ? `  tools: [${importedTools.join(", ")}]` : undefined,
      importedSkills.length > 0 ? `  skills: [${importedSkills.join(", ")}]` : undefined
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
  await writeFileSet(runtimeRoot, "runtime-files", options.syntheticFiles, options.syntheticSizeBytes);

  if (importedTools.length > 0) {
    await mkdir(path.join(platformToolDir, "servers"), { recursive: true });
    await writeFile(
      path.join(platformToolDir, "settings.yaml"),
      importedTools
        .map((toolName) => `${toolName}:\n  command: "node ./.openharness/tools/servers/${toolName}/index.js"\n`)
        .join("")
    );
    for (const toolName of importedTools) {
      const toolRoot = path.join(platformToolDir, "servers", toolName);
      await writeFileSet(toolRoot, "server-files", Math.max(1, Math.floor(options.syntheticFiles / 4)), options.syntheticSizeBytes);
      await writeFile(path.join(toolRoot, "index.js"), "console.log('ok')\n");
    }
  }

  for (const skillName of importedSkills) {
    const skillRoot = path.join(platformSkillDir, skillName);
    await writeFileSet(skillRoot, "skill-files", Math.max(1, Math.floor(options.syntheticFiles / 8)), options.syntheticSizeBytes);
    await writeFile(path.join(skillRoot, "SKILL.md"), `# ${skillName}\n`);
  }

  return {
    label: `synthetic-${options.syntheticFiles}x${options.syntheticSizeBytes}`,
    runtimeDir,
    runtimeName,
    platformToolDir,
    platformSkillDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function resolveDeploySourceSets(options: BenchmarkOptions): Promise<SourceSet[]> {
  if (!options.deployRoot) {
    return [];
  }

  const assetRoot = await resolveDeployAssetRoot(options.deployRoot);
  const runtimeDir = path.resolve(assetRoot, "runtimes");
  if (!(await pathExists(runtimeDir))) {
    return [];
  }

  const runtimeEntries = (await readdir(runtimeDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const selectedRuntimeNames = options.runtimeName ? [options.runtimeName] : runtimeEntries;
  const sourceSets = await Promise.all(
    selectedRuntimeNames.map(async (runtimeName) => {
      const runtimeRoot = path.join(runtimeDir, runtimeName);
      const inventory = await collectInventory(runtimeRoot);
      return {
        sourceSet: {
          label: `deploy:${runtimeName}`,
          runtimeDir,
          runtimeName,
          platformToolDir: path.resolve(assetRoot, "tools"),
          platformSkillDir: path.resolve(assetRoot, "skills")
        } satisfies SourceSet,
        inventory
      };
    })
  );

  return sourceSets
    .sort((left, right) => right.inventory.files - left.inventory.files || right.inventory.bytes - left.inventory.bytes)
    .slice(0, options.runtimeName ? 1 : options.runtimeLimit)
    .map((entry) => entry.sourceSet);
}

async function configureMode(mode: BenchmarkMode, binary: string | undefined): Promise<void> {
  await shutdownNativeWorkspaceSyncWorkerPool().catch(() => undefined);
  if (mode === "ts") {
    delete process.env.OAH_NATIVE_WORKSPACE_SYNC;
    delete process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT;
    return;
  }

  if (!binary) {
    throw new Error("Native workspace sync binary is required for native runtime materialize benchmarks.");
  }

  process.env.OAH_NATIVE_WORKSPACE_SYNC = "1";
  process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY = binary;
  if (mode === "persistent") {
    process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT = "1";
  } else {
    delete process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT;
  }
}

async function measureSourceSet(
  sourceSet: SourceSet,
  inventory: Inventory,
  mode: BenchmarkMode,
  options: BenchmarkOptions
): Promise<BenchmarkRow> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-runtime-materialize-workspaces-"));
  const durations: number[] = [];
  try {
    for (let index = 0; index < options.iterations; index += 1) {
      const rootPath = path.join(workspaceRoot, `${mode}-${index}`);
      const startedAt = performance.now();
      await initializeWorkspaceFromRuntime({
        runtimeDir: sourceSet.runtimeDir,
        runtimeName: sourceSet.runtimeName,
        rootPath,
        ...(sourceSet.platformToolDir ? { platformToolDir: sourceSet.platformToolDir } : {}),
        ...(sourceSet.platformSkillDir ? { platformSkillDir: sourceSet.platformSkillDir } : {})
      });
      durations.push(performance.now() - startedAt);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  const firstMs = durations[0] ?? 0;
  const warmDurations = durations.slice(1);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  return {
    scenario: sourceSet.label,
    mode,
    files: inventory.files,
    directories: inventory.directories,
    bytes: inventory.bytes,
    iterations: options.iterations,
    firstMs: round(firstMs),
    warmAvgMs: round((warmDurations.length > 0 ? warmDurations : durations).reduce((sum, value) => sum + value, 0) / Math.max(1, (warmDurations.length > 0 ? warmDurations : durations).length)),
    avgMs: round(totalMs / durations.length),
    minMs: round(Math.min(...durations)),
    maxMs: round(Math.max(...durations))
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const binary = await resolveKnownGoodWorkspaceSyncBinary();
  const sourceSets = [...(await resolveDeploySourceSets(options)), await createSyntheticSourceSet(options)];

  console.log(
    `Benchmarking runtime materialization iterations=${options.iterations} syntheticFiles=${options.syntheticFiles} syntheticSizeBytes=${options.syntheticSizeBytes}`
  );
  console.log(`Native binary: ${binary ?? "not found"}`);

  const rows: BenchmarkRow[] = [];
  try {
    for (const sourceSet of sourceSets) {
      const inventory = await collectMaterializedInventory(sourceSet);
      console.log(
        `[bench] source=${sourceSet.label} files=${inventory.files} dirs=${inventory.directories} bytes=${inventory.bytes}`
      );
      for (const mode of ["ts", "oneshot", "persistent"] satisfies BenchmarkMode[]) {
        await configureMode(mode, binary);
        rows.push(await measureSourceSet(sourceSet, inventory, mode, options));
      }
    }
  } finally {
    await shutdownNativeWorkspaceSyncWorkerPool().catch(() => undefined);
    await Promise.all(sourceSets.map((sourceSet) => sourceSet.cleanup?.()));
  }

  console.table(rows);
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    await shutdownNativeWorkspaceSyncWorkerPool().catch(() => undefined);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
