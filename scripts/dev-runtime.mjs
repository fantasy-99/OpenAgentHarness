#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const forwardedArgs = process.argv.slice(3);
const runtimeKind = mode === "server" || mode === "worker" ? mode : undefined;
const displayTag = `[dev:${mode ?? "unknown"}]`;

const runtimeSpecs = {
  server: {
    entryRelativePath: "./apps/server/src/index.ts",
    defaultPort: 8787
  },
  worker: {
    entryRelativePath: "./apps/server/src/worker.ts"
  }
};

if (mode !== "server" && mode !== "worker" && mode !== "doctor" && mode !== "clean") {
  console.error("Usage: node ./scripts/dev-runtime.mjs <server|worker|doctor|clean> [args...]");
  process.exit(1);
}

const tsConfigRelativePath = "./apps/server/tsconfig.json";
const tsConfigAbsolutePath = path.join(repoRoot, "apps/server/tsconfig.json");

function getRuntimeSpec(kind) {
  return runtimeSpecs[kind];
}

function getEntryAbsolutePath(kind) {
  return path.join(repoRoot, getRuntimeSpec(kind).entryRelativePath.slice(2));
}

function getWatchSignature(kind) {
  return `tsx watch --tsconfig ./apps/server/tsconfig.json ${getRuntimeSpec(kind).entryRelativePath}`;
}

function listProcesses() {
  return spawnAndCollect("ps", ["-axo", "pid=,command="]).then((output) =>
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace <= 0) {
          return null;
        }

        const pidText = line.slice(0, firstSpace).trim();
        const command = line.slice(firstSpace + 1).trim();
        const pid = Number.parseInt(pidText, 10);
        if (!Number.isInteger(pid) || !command) {
          return null;
        }

        return { pid, command };
      })
      .filter((item) => item !== null)
  );
}

function spawnAndCollect(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || `${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatArgList(args) {
  return args.length === 0 ? "(none)" : args.join(" ");
}

function summarizeCommand(command) {
  return command.length > 200 ? `${command.slice(0, 197)}...` : command;
}

function parseOptionValue(args, optionName) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === optionName) {
      return args[index + 1];
    }

    if (arg.startsWith(`${optionName}=`)) {
      return arg.slice(optionName.length + 1);
    }
  }

  return undefined;
}

function isMatchingDevWatcher(kind, command) {
  const entryRelativePath = getRuntimeSpec(kind).entryRelativePath;
  const entryAbsolutePath = getEntryAbsolutePath(kind);

  if (!command.includes(repoRoot)) {
    return false;
  }

  const hasWatchMode =
    command.includes("tsx watch") ||
    (command.includes("tsx/dist/cli.mjs") && command.includes(" watch ")) ||
    command.includes(getWatchSignature(kind));
  if (!hasWatchMode) {
    return false;
  }

  const referencesRuntimeEntry = command.includes(entryRelativePath) || command.includes(entryAbsolutePath);
  if (!referencesRuntimeEntry) {
    return false;
  }

  return command.includes(tsConfigRelativePath) || command.includes(tsConfigAbsolutePath);
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
      await delay(100);
    } catch {
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore if it already exited.
  }
}

async function findStaleWatchers(kind) {
  const processes = await listProcesses();
  const stale = processes.filter(({ pid, command }) => {
    if (pid === process.pid || pid === process.ppid) {
      return false;
    }

    return isMatchingDevWatcher(kind, command);
  });

  if (stale.length > 1) {
    stale.sort((left, right) => left.pid - right.pid);
  }

  return stale;
}

async function terminateStaleWatchers(kind) {
  const stale = await findStaleWatchers(kind);

  if (stale.length === 0) {
    console.log(`${displayTag} no stale ${kind} watcher found in ${repoRoot}`);
    return 0;
  }

  console.log(
    `${displayTag} terminating ${stale.length} stale ${kind} watcher${stale.length === 1 ? "" : "s"} in ${repoRoot}`
  );

  for (const processInfo of stale) {
    console.log(`${displayTag} stop pid=${processInfo.pid} ${summarizeCommand(processInfo.command)}`);
    await terminateProcess(processInfo.pid);
  }

  return stale.length;
}

function countIndent(line) {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) {
    count += 1;
  }

  return count;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function inferServerPortFromConfig(configPath) {
  const absoluteConfigPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  if (!(await fileExists(absoluteConfigPath))) {
    return { port: undefined, source: `config missing: ${absoluteConfigPath}` };
  }

  const content = await readFile(absoluteConfigPath, "utf8");
  const lines = content.split(/\r?\n/);
  let serverIndent = undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = countIndent(line);
    if (serverIndent === undefined) {
      if (trimmed === "server:") {
        serverIndent = indent;
      }

      continue;
    }

    if (indent <= serverIndent) {
      serverIndent = undefined;
      if (trimmed === "server:") {
        serverIndent = indent;
      }
      continue;
    }

    const match = trimmed.match(/^port:\s*(\d+)\s*$/);
    if (match) {
      return { port: Number.parseInt(match[1], 10), source: `OAH_CONFIG ${absoluteConfigPath}` };
    }
  }

  return { port: undefined, source: `config without server.port: ${absoluteConfigPath}` };
}

async function resolveDoctorPort(args) {
  const explicitPort = parseOptionValue(args, "--port");
  if (explicitPort) {
    const parsed = Number.parseInt(explicitPort, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return { port: parsed, source: `--port ${parsed}` };
    }
  }

  if (process.env.OAH_CONFIG) {
    const inferred = await inferServerPortFromConfig(process.env.OAH_CONFIG);
    if (inferred.port !== undefined) {
      return inferred;
    }

    console.log(`${displayTag} ${inferred.source}`);
  }

  return { port: runtimeSpecs.server.defaultPort, source: `default ${runtimeSpecs.server.defaultPort}` };
}

async function listListeningProcesses(port) {
  try {
    const output = await spawnAndCollect("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) {
      return [];
    }

    return lines.slice(1).map((line) => summarizeCommand(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exited with code 1")) {
      return [];
    }

    throw error;
  }
}

async function runDoctor(args) {
  const { port, source } = await resolveDoctorPort(args);
  console.log(`${displayTag} repo=${repoRoot}`);
  console.log(`${displayTag} inspected port=${port} (${source})`);
  if (process.env.OAH_CONFIG) {
    console.log(`${displayTag} OAH_CONFIG=${process.env.OAH_CONFIG}`);
  }

  for (const kind of ["server", "worker"]) {
    const watchers = await findStaleWatchers(kind);
    if (watchers.length === 0) {
      console.log(`${displayTag} ${kind}: no repo-local watcher running`);
      continue;
    }

    console.log(`${displayTag} ${kind}: ${watchers.length} repo-local watcher${watchers.length === 1 ? "" : "s"}`);
    for (const watcher of watchers) {
      console.log(`${displayTag} ${kind}: pid=${watcher.pid} ${summarizeCommand(watcher.command)}`);
    }
  }

  const listeners = await listListeningProcesses(port);
  if (listeners.length === 0) {
    console.log(`${displayTag} port ${port}: no LISTEN process`);
    return;
  }

  console.log(`${displayTag} port ${port}: ${listeners.length} LISTEN process${listeners.length === 1 ? "" : "es"}`);
  for (const listener of listeners) {
    console.log(`${displayTag} port ${port}: ${listener}`);
  }
}

function normalizeCleanTargets(args) {
  const requestedKinds = args.filter((arg) => arg === "server" || arg === "worker");
  if (requestedKinds.length === 0) {
    return ["server", "worker"];
  }

  return [...new Set(requestedKinds)];
}

async function runClean(args) {
  const targets = normalizeCleanTargets(args);
  console.log(`${displayTag} repo=${repoRoot}`);
  console.log(`${displayTag} targets=${targets.join(", ")}`);

  let totalTerminated = 0;
  for (const kind of targets) {
    totalTerminated += await terminateStaleWatchers(kind);
  }

  if (totalTerminated === 0) {
    console.log(`${displayTag} nothing to clean`);
    return;
  }

  console.log(`${displayTag} cleaned ${totalTerminated} stale watcher${totalTerminated === 1 ? "" : "s"}`);
}

async function main() {
  if (mode === "doctor") {
    await runDoctor(forwardedArgs);
    return;
  }

  if (mode === "clean") {
    await runClean(forwardedArgs);
    return;
  }

  const entryRelativePath = getRuntimeSpec(runtimeKind).entryRelativePath;
  console.log(`${displayTag} repo=${repoRoot}`);
  console.log(`${displayTag} entry=${entryRelativePath}`);
  console.log(`${displayTag} args=${formatArgList(forwardedArgs)}`);
  if (process.env.OAH_CONFIG) {
    console.log(`${displayTag} OAH_CONFIG=${process.env.OAH_CONFIG}`);
  }

  const terminatedCount = await terminateStaleWatchers(runtimeKind);
  console.log(
    `${displayTag} starting ${runtimeKind} runtime${terminatedCount > 0 ? ` after cleaning ${terminatedCount} stale watcher${terminatedCount === 1 ? "" : "s"}` : ""}`
  );

  const child = spawn(
    "pnpm",
    ["exec", "tsx", "watch", "--tsconfig", tsConfigRelativePath, entryRelativePath, ...forwardedArgs],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    }
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
}

void main().catch((error) => {
  console.error(`${displayTag} failed to start`, error);
  process.exit(1);
});
