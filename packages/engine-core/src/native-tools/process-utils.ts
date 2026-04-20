import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../errors.js";
import { BACKGROUND_STATE_DIRECTORY, DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from "./constants.js";
import { normalizePathForMatch } from "./paths.js";

export async function runShellCommandForeground(
  workspaceRoot: string,
  command: string,
  timeout: number | undefined,
  signal?: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const effectiveTimeout = timeout ?? DEFAULT_BASH_TIMEOUT_MS;
  if (effectiveTimeout > MAX_BASH_TIMEOUT_MS) {
    throw new AppError(
      400,
      "native_tool_timeout_invalid",
      `Bash timeout ${effectiveTimeout} exceeds the maximum of ${MAX_BASH_TIMEOUT_MS} milliseconds.`
    );
  }

  const child = spawn(command, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      OPENHARNESS_WORKSPACE_ROOT: workspaceRoot
    },
    shell: true,
    ...(signal ? { signal } : {})
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, effectiveTimeout);

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });

  if (timedOut) {
    throw new AppError(408, "native_tool_timeout", `Bash exceeded ${effectiveTimeout} milliseconds.`);
  }

  if (signal?.aborted) {
    throw new AppError(499, "native_tool_cancelled", "Bash was cancelled.");
  }

  return { stdout, stderr, exitCode };
}

export async function runShellCommandBackground(
  workspaceRoot: string,
  command: string,
  sessionId: string,
  description: string | undefined
): Promise<{ outputPath: string; taskId: string; pid: number }> {
  const backgroundDirectory = path.join(workspaceRoot, ...BACKGROUND_STATE_DIRECTORY, sessionId);
  await mkdir(backgroundDirectory, { recursive: true });
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(backgroundDirectory, `${taskId}.log`);
  const metadataPath = path.join(backgroundDirectory, `${taskId}.json`);

  const handle = await open(outputPath, "a");
  try {
    const child = spawn(command, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        OPENHARNESS_WORKSPACE_ROOT: workspaceRoot
      },
      shell: true,
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd]
    });

    child.unref();

    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          taskId,
          pid: child.pid,
          description: description ?? command,
          command,
          outputPath: normalizePathForMatch(path.relative(workspaceRoot, outputPath)),
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    return { outputPath, taskId, pid: child.pid ?? 0 };
  } finally {
    await handle.close();
  }
}

export async function runRipgrep(
  cwd: string,
  args: string[],
  signal?: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, ...(signal ? { signal } : {}) });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
