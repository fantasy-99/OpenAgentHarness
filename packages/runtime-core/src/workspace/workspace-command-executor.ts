import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

import { BACKGROUND_STATE_DIRECTORY } from "../native-tools/constants.js";
import { normalizePathForMatch } from "../native-tools/paths.js";
import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceCommandExecutor,
  WorkspaceForegroundCommandExecutionResult
} from "../types.js";

export class WorkspaceCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCommandTimeoutError";
  }
}

export class WorkspaceCommandCancelledError extends Error {
  constructor(message = "Workspace command was cancelled.") {
    super(message);
    this.name = "WorkspaceCommandCancelledError";
  }
}

async function waitForChildExit(input: {
  child: ReturnType<typeof spawn>;
  signal?: AbortSignal | undefined;
}): Promise<number> {
  try {
    return await new Promise<number>((resolve, reject) => {
      input.child.on("error", reject);
      input.child.on("close", (code) => resolve(code ?? 0));
    });
  } catch (error) {
    if (
      input.signal?.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.message === "aborted" ||
          error.message === "The operation was aborted"))
    ) {
      throw new WorkspaceCommandCancelledError();
    }

    throw error;
  }
}

async function collectChildResult(input: {
  child: ReturnType<typeof spawn>;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<WorkspaceForegroundCommandExecutionResult> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeoutHandle =
    input.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          input.child.kill("SIGTERM");
        }, input.timeoutMs)
      : undefined;

  input.child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  input.child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await waitForChildExit({
    child: input.child,
    ...(input.signal ? { signal: input.signal } : {})
  }).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });

  if (timedOut) {
    throw new WorkspaceCommandTimeoutError(
      input.timeoutMs !== undefined
        ? `Workspace command timed out after ${input.timeoutMs}ms.`
        : "Workspace command timed out."
    );
  }

  if (input.signal?.aborted) {
    throw new WorkspaceCommandCancelledError();
  }

  return {
    stdout,
    stderr,
    exitCode
  };
}

export function createLocalWorkspaceCommandExecutor(): WorkspaceCommandExecutor {
  return {
    async runForeground(input): Promise<WorkspaceForegroundCommandExecutionResult> {
      const cwd = input.cwd ?? input.workspace.rootPath;
      const child = spawn(input.command, {
        cwd,
        env: {
          ...process.env,
          OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
          ...(input.env ?? {})
        },
        shell: true,
        ...(input.signal ? { signal: input.signal } : {})
      });

      if (input.stdinText !== undefined) {
        child.stdin.write(input.stdinText);
      }
      child.stdin.end();
      return collectChildResult({
        child,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runProcess(input): Promise<WorkspaceForegroundCommandExecutionResult> {
      const cwd = input.cwd ?? input.workspace.rootPath;
      const child = spawn(input.executable, input.args, {
        cwd,
        env: {
          ...process.env,
          OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
          ...(input.env ?? {})
        },
        ...(input.signal ? { signal: input.signal } : {})
      });

      if (input.stdinText !== undefined) {
        child.stdin.write(input.stdinText);
      }
      child.stdin.end();

      return collectChildResult({
        child,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runBackground(input): Promise<WorkspaceBackgroundCommandExecutionResult> {
      const cwd = input.cwd ?? input.workspace.rootPath;
      const backgroundDirectory = path.join(input.workspace.rootPath, ...BACKGROUND_STATE_DIRECTORY, input.sessionId);
      await mkdir(backgroundDirectory, { recursive: true });
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outputPath = path.join(backgroundDirectory, `${taskId}.log`);
      const metadataPath = path.join(backgroundDirectory, `${taskId}.json`);

      const handle = await open(outputPath, "a");
      try {
        const child = spawn(input.command, {
          cwd,
          env: {
            ...process.env,
            OPENHARNESS_WORKSPACE_ROOT: input.workspace.rootPath,
            ...(input.env ?? {})
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
              description: input.description ?? input.command,
              command: input.command,
              outputPath: normalizePathForMatch(path.relative(input.workspace.rootPath, outputPath)),
              createdAt: new Date().toISOString()
            },
            null,
            2
          ),
          "utf8"
        );

        return {
          outputPath,
          taskId,
          pid: child.pid ?? 0
        };
      } finally {
        await handle.close();
      }
    }
  };
}
