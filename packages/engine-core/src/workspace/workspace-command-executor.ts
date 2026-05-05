import type { IPty } from "@lydell/node-pty";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { WriteStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { BACKGROUND_STATE_DIRECTORY } from "../native-tools/constants.js";
import { normalizePathForMatch } from "../native-tools/paths.js";
import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceBackgroundTaskState,
  WorkspaceCommandExecutor,
  WorkspaceForegroundCommandExecutionResult,
  WorkspacePersistentTerminalExecutionResult,
  WorkspacePersistentTerminalMode
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

interface PersistentTerminalSession {
  pty: IPty;
  buffer: string;
  closed: boolean;
  exitCode?: number | undefined;
  signal?: number | undefined;
}

interface BackgroundTaskProcess {
  kind: "pty" | "pipe";
  pty?: IPty | undefined;
  child?: ReturnType<typeof spawn> | undefined;
  outputStream?: WriteStream | undefined;
}

const persistentTerminalSessions = new Map<string, PersistentTerminalSession>();
const backgroundTaskProcesses = new Map<string, BackgroundTaskProcess>();

const DEFAULT_PERSISTENT_TERMINAL_TIMEOUT_MS = 1_000;
const require = createRequire(import.meta.url);

function loadPty(): typeof import("@lydell/node-pty") {
  return require("@lydell/node-pty") as typeof import("@lydell/node-pty");
}

function backgroundSessionDirectory(workspaceRoot: string, sessionId: string): string {
  return path.join(workspaceRoot, ...BACKGROUND_STATE_DIRECTORY, sessionId);
}

function backgroundMetadataPath(workspaceRoot: string, sessionId: string, taskId: string): string {
  return path.join(backgroundSessionDirectory(workspaceRoot, sessionId), `${taskId}.json`);
}

async function readBackgroundTaskState(input: {
  workspaceRoot: string;
  sessionId: string;
  taskId: string;
}): Promise<WorkspaceBackgroundTaskState | null> {
  const metadataPath = backgroundMetadataPath(input.workspaceRoot, input.sessionId, input.taskId);
  const raw = await readFile(metadataPath, "utf8").catch(() => null);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceBackgroundTaskState> & { taskId?: unknown };
    if (parsed.taskId !== input.taskId || typeof parsed.outputPath !== "string") {
      return null;
    }

    return {
      taskId: input.taskId,
      outputPath: parsed.outputPath,
      status: parsed.status ?? "unknown",
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(typeof parsed.inputWritable === "boolean" ? { inputWritable: parsed.inputWritable } : {}),
      ...(parsed.terminalKind === "pty" || parsed.terminalKind === "pipe" ? { terminalKind: parsed.terminalKind } : {}),
      ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
      ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
      ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
      ...(typeof parsed.signal === "string" ? { signal: parsed.signal } : {}),
      ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
      ...(typeof parsed.endedAt === "string" ? { endedAt: parsed.endedAt } : {})
    };
  } catch {
    return null;
  }
}

async function writeBackgroundTaskState(input: {
  workspaceRoot: string;
  sessionId: string;
  state: WorkspaceBackgroundTaskState;
}): Promise<void> {
  const metadataPath = backgroundMetadataPath(input.workspaceRoot, input.sessionId, input.state.taskId);
  await writeFile(metadataPath, JSON.stringify(input.state, null, 2), "utf8");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function persistentTerminalKey(input: { workspaceRoot: string; sessionId: string; terminalId: string }): string {
  return `${input.workspaceRoot}\0${input.sessionId}\0${input.terminalId}`;
}

function backgroundTaskProcessKey(input: { workspaceRoot: string; sessionId: string; taskId: string }): string {
  return `${input.workspaceRoot}\0${input.sessionId}\0${input.taskId}`;
}

function normalizePersistentTerminalCommand(input: { command: string; appendNewline?: boolean | undefined }): string {
  if (input.appendNewline === false || input.command.endsWith("\n")) {
    return input.command;
  }

  return `${input.command}\n`;
}

function normalizeBackgroundTaskInput(input: { inputText: string; appendNewline?: boolean | undefined }): string {
  if (input.appendNewline === false || input.inputText.endsWith("\n")) {
    return input.inputText;
  }

  return `${input.inputText}\n`;
}

function isBackgroundTaskInputWritable(input: { workspaceRoot: string; sessionId: string; taskId: string }): boolean {
  const process = backgroundTaskProcesses.get(backgroundTaskProcessKey(input));
  if (process?.kind === "pty") {
    return Boolean(process.pty);
  }

  return Boolean(process?.child?.stdin && !process.child.stdin.destroyed && !process.child.stdin.writableEnded);
}

function spawnBackgroundPty(input: {
  workspaceRoot: string;
  command: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  outputPath: string;
  processKey: string;
  onExit: (event: { exitCode: number; signal?: number | undefined }) => void;
}): BackgroundTaskProcess {
  const pty = loadPty();
  const shell = process.env.OAH_PERSISTENT_TERMINAL_SHELL || "/bin/bash";
  const outputStream = createWriteStream(input.outputPath, { flags: "a" });
  let terminal: IPty;
  try {
    terminal = pty.spawn(shell, ["-lc", `${input.command}\n__oah_background_exit_code=$?\nsleep 0.05\nexit "$__oah_background_exit_code"`], {
      cwd: input.cwd,
      env: {
        ...process.env,
        OPENHARNESS_WORKSPACE_ROOT: input.workspaceRoot,
        TERM: process.env.TERM || "xterm-256color",
        ...(input.env ?? {})
      },
      name: process.env.TERM || "xterm-256color",
      cols: Number(process.env.COLUMNS || 120),
      rows: Number(process.env.LINES || 30),
      encoding: "utf8"
    });
  } catch (error) {
    outputStream.end();
    throw error;
  }

  const backgroundProcess: BackgroundTaskProcess = {
    kind: "pty",
    pty: terminal,
    outputStream
  };
  backgroundTaskProcesses.set(input.processKey, backgroundProcess);
  terminal.onData((chunk) => {
    outputStream.write(chunk);
  });
  terminal.onExit((event) => {
    backgroundTaskProcesses.delete(input.processKey);
    outputStream.end();
    input.onExit(event);
  });
  return backgroundProcess;
}

function createPersistentTerminalSession(input: {
  workspaceRoot: string;
  cwd: string;
  env?: Record<string, string> | undefined;
}): PersistentTerminalSession {
  const pty = loadPty();
  const shell = process.env.OAH_PERSISTENT_TERMINAL_SHELL || "/bin/bash";
  const terminal = pty.spawn(shell, [], {
    cwd: input.cwd,
    env: {
      ...process.env,
      OPENHARNESS_WORKSPACE_ROOT: input.workspaceRoot,
      TERM: process.env.TERM || "xterm-256color",
      ...(input.env ?? {})
    },
    name: process.env.TERM || "xterm-256color",
    cols: Number(process.env.COLUMNS || 120),
    rows: Number(process.env.LINES || 30),
    encoding: "utf8"
  });

  const session: PersistentTerminalSession = {
    pty: terminal,
    buffer: "",
    closed: false
  };

  terminal.onData((chunk) => {
    session.buffer += chunk.toString();
  });
  terminal.onExit((event) => {
    session.closed = true;
    session.exitCode = event.exitCode;
    session.signal = event.signal;
  });

  return session;
}

function getOrCreatePersistentTerminalSession(input: {
  key: string;
  workspaceRoot: string;
  cwd: string;
  env?: Record<string, string> | undefined;
}): PersistentTerminalSession {
  const existing = persistentTerminalSessions.get(input.key);
  if (existing && !existing.closed) {
    return existing;
  }

  if (existing?.closed) {
    persistentTerminalSessions.delete(input.key);
  }

  const created = createPersistentTerminalSession(input);
  persistentTerminalSessions.set(input.key, created);
  return created;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPersistentTerminalOutput(input: {
  session: PersistentTerminalSession;
  terminalKey: string;
  command: string;
  terminalId: string;
  mode: WorkspacePersistentTerminalMode;
  appendNewline?: boolean | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<WorkspacePersistentTerminalExecutionResult> {
  const startLength = input.session.buffer.length;
  const sentinel = `__OAH_TERMINAL_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}__`;
  const commandText =
    input.mode === "command"
      ? `${input.command.replace(/\n$/, "")}\nprintf '\\n${sentinel}:%s\\n' "$?"\n`
      : normalizePersistentTerminalCommand({ command: input.command, appendNewline: input.appendNewline });

  input.session.pty.write(commandText);

  const deadline = Date.now() + input.timeoutMs;
  let timedOut = false;
  let exitCode: number | undefined;

  while (!input.signal?.aborted && !input.session.closed) {
    const output = input.session.buffer.slice(startLength);
    if (input.mode === "command") {
      const markerIndex = output.lastIndexOf(`\n${sentinel}:`);
      if (markerIndex >= 0) {
        const markerLine = output.slice(markerIndex + 1).split(/\r?\n/, 1)[0] ?? "";
        const parsedExitCode = Number(markerLine.slice(`${sentinel}:`.length));
        exitCode = Number.isFinite(parsedExitCode) ? parsedExitCode : undefined;
        break;
      }
    } else if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    await delay(25);
  }

  if (input.signal?.aborted) {
    throw new WorkspaceCommandCancelledError();
  }

  const rawOutput = input.session.buffer.slice(startLength);
  const output =
    input.mode === "command"
      ? rawOutput.replace(new RegExp(`\\r?\\n?${sentinel}:[0-9]+\\r?\\n?`), "")
      : rawOutput;

  if (input.session.closed) {
    persistentTerminalSessions.delete(input.terminalKey);
  }

  return {
    terminalId: input.terminalId,
    output,
    status: input.session.closed ? "exited" : exitCode !== undefined ? "completed" : "running",
    ...(input.session.pty.pid ? { pid: input.session.pty.pid } : {}),
    ...(exitCode !== undefined ? { exitCode } : input.session.exitCode !== undefined ? { exitCode: input.session.exitCode } : {}),
    ...(timedOut ? { timedOut: true } : {})
  };
}

async function refreshBackgroundTaskState(input: {
  workspaceRoot: string;
  sessionId: string;
  taskId: string;
}): Promise<WorkspaceBackgroundTaskState | null> {
  const state = await readBackgroundTaskState(input);
  if (!state) {
    return null;
  }

  if (state.status === "running" && typeof state.pid === "number" && !isProcessRunning(state.pid)) {
    const updated = {
      ...state,
      status: "unknown" as const,
      inputWritable: false,
      updatedAt: new Date().toISOString()
    };
    await writeBackgroundTaskState({ ...input, state: updated }).catch(() => undefined);
    return updated;
  }

  if (state.status === "running") {
    const inputWritable = isBackgroundTaskInputWritable(input);
    if (state.inputWritable !== inputWritable) {
      const updated = {
        ...state,
        inputWritable,
        updatedAt: new Date().toISOString()
      };
      await writeBackgroundTaskState({ ...input, state: updated }).catch(() => undefined);
      return updated;
    }
  }

  return state;
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
    async runPersistentTerminal(input): Promise<WorkspacePersistentTerminalExecutionResult> {
      const cwd = input.cwd ?? input.workspace.rootPath;
      const key = persistentTerminalKey({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        terminalId: input.terminalId
      });
      const session = getOrCreatePersistentTerminalSession({
        key,
        workspaceRoot: input.workspace.rootPath,
        cwd,
        ...(input.env ? { env: input.env } : {})
      });

      return waitForPersistentTerminalOutput({
        session,
        terminalKey: key,
        command: input.command,
        terminalId: input.terminalId,
        mode: input.mode ?? "command",
        ...(input.appendNewline !== undefined ? { appendNewline: input.appendNewline } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_PERSISTENT_TERMINAL_TIMEOUT_MS,
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async stopPersistentTerminal(input): Promise<WorkspacePersistentTerminalExecutionResult | null> {
      const key = persistentTerminalKey({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        terminalId: input.terminalId
      });
      const session = persistentTerminalSessions.get(key);
      if (!session) {
        return null;
      }

      session.pty.kill("SIGTERM");
      await delay(25);
      persistentTerminalSessions.delete(key);

      return {
        terminalId: input.terminalId,
        output: session.buffer,
        status: "exited",
        ...(session.pty.pid ? { pid: session.pty.pid } : {}),
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {})
      };
    },
    async runBackground(input): Promise<WorkspaceBackgroundCommandExecutionResult> {
      const cwd = input.cwd ?? input.workspace.rootPath;
      const backgroundDirectory = backgroundSessionDirectory(input.workspace.rootPath, input.sessionId);
      await mkdir(backgroundDirectory, { recursive: true });
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outputPath = path.join(backgroundDirectory, `${taskId}.log`);
      const processKey = backgroundTaskProcessKey({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        taskId
      });
      const createdAt = new Date().toISOString();

      const writeExitState = (initialState: WorkspaceBackgroundTaskState, event: { exitCode?: number | undefined; signal?: string | number | undefined }) => {
        const endedAt = new Date().toISOString();
        void readBackgroundTaskState({
          workspaceRoot: input.workspace.rootPath,
          sessionId: input.sessionId,
          taskId
        }).then((current) => {
          if (current?.status === "stopped") {
            return;
          }
          const exitCode = typeof event.exitCode === "number" ? event.exitCode : undefined;
          return writeBackgroundTaskState({
            workspaceRoot: input.workspace.rootPath,
            sessionId: input.sessionId,
            state: {
              ...(current ?? initialState),
              status: exitCode === 0 ? "completed" : "failed",
              inputWritable: false,
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(event.signal !== undefined ? { signal: String(event.signal) } : {}),
              endedAt,
              updatedAt: endedAt
            }
          });
        }).catch(() => undefined);
      };

      try {
        const ptyProcess = spawnBackgroundPty({
          workspaceRoot: input.workspace.rootPath,
          command: input.command,
          cwd,
          ...(input.env ? { env: input.env } : {}),
          outputPath,
          processKey,
          onExit: (event) => writeExitState(initialState, event)
        });

        const initialState: WorkspaceBackgroundTaskState = {
          taskId,
          pid: ptyProcess.pty?.pid ?? 0,
          inputWritable: true,
          terminalKind: "pty",
          description: input.description ?? input.command,
          command: input.command,
          outputPath: normalizePathForMatch(path.relative(input.workspace.rootPath, outputPath)),
          status: "running",
          createdAt,
          updatedAt: createdAt
        };

        await writeBackgroundTaskState({
          workspaceRoot: input.workspace.rootPath,
          sessionId: input.sessionId,
          state: initialState
        });

        return {
          outputPath,
          taskId,
          pid: ptyProcess.pty?.pid ?? 0
        };
      } catch {
        backgroundTaskProcesses.delete(processKey);
      }

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
          stdio: ["pipe", handle.fd, handle.fd]
        });
        backgroundTaskProcesses.set(processKey, {
          kind: "pipe",
          child
        });
        child.stdin?.on("error", () => undefined);
        (child.stdin as { unref?: () => void } | null | undefined)?.unref?.();

        const initialState: WorkspaceBackgroundTaskState = {
          taskId,
          pid: child.pid ?? 0,
          inputWritable: true,
          terminalKind: "pipe",
          description: input.description ?? input.command,
          command: input.command,
          outputPath: normalizePathForMatch(path.relative(input.workspace.rootPath, outputPath)),
          status: "running",
          createdAt,
          updatedAt: createdAt
        };

        child.once("exit", (code, signal) => {
          backgroundTaskProcesses.delete(processKey);
          writeExitState(initialState, {
            ...(typeof code === "number" ? { exitCode: code } : {}),
            ...(signal ? { signal } : {})
          });
        });

        child.unref();

        await writeBackgroundTaskState({
          workspaceRoot: input.workspace.rootPath,
          sessionId: input.sessionId,
          state: initialState
        });

        return {
          outputPath,
          taskId,
          pid: child.pid ?? 0
        };
      } finally {
        await handle.close();
      }
    },
    async getBackgroundTask(input): Promise<WorkspaceBackgroundTaskState | null> {
      return refreshBackgroundTaskState({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        taskId: input.taskId
      });
    },
    async writeBackgroundTaskInput(input): Promise<WorkspaceBackgroundTaskState | null> {
      const state = await refreshBackgroundTaskState({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        taskId: input.taskId
      });
      if (!state) {
        return null;
      }

      if (state.status !== "running") {
        return {
          ...state,
          inputWritable: false
        };
      }

      const processKey = backgroundTaskProcessKey({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        taskId: input.taskId
      });
      const backgroundProcess = backgroundTaskProcesses.get(processKey);
      if (backgroundProcess?.kind === "pty" && backgroundProcess.pty) {
        const inputText = normalizeBackgroundTaskInput({
          inputText: input.inputText,
          appendNewline: input.appendNewline
        });
        backgroundProcess.pty.write(inputText);
        return {
          ...state,
          inputWritable: true,
          terminalKind: "pty",
          updatedAt: new Date().toISOString()
        };
      }

      const child = backgroundProcess?.child;
      if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        return {
          ...state,
          inputWritable: false
        };
      }

      const inputText = normalizeBackgroundTaskInput({
        inputText: input.inputText,
        appendNewline: input.appendNewline
      });
      await new Promise<void>((resolve, reject) => {
        child.stdin?.write(inputText, (error: Error | null | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      return {
        ...state,
        inputWritable: true,
        terminalKind: backgroundProcess?.kind ?? state.terminalKind,
        updatedAt: new Date().toISOString()
      };
    },
    async stopBackgroundTask(input): Promise<WorkspaceBackgroundTaskState | null> {
      const state = await refreshBackgroundTaskState({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        taskId: input.taskId
      });
      if (!state) {
        return null;
      }

      if (state.status === "running" && typeof state.pid === "number" && state.pid > 0) {
        const processKey = backgroundTaskProcessKey({
          workspaceRoot: input.workspace.rootPath,
          sessionId: input.sessionId,
          taskId: input.taskId
        });
        const backgroundProcess = backgroundTaskProcesses.get(processKey);
        if (backgroundProcess?.kind === "pty") {
          backgroundProcess.pty?.kill("SIGTERM");
          backgroundProcess.outputStream?.end();
        } else {
          backgroundProcess?.child?.stdin?.end();
        }
        backgroundTaskProcesses.delete(processKey);

        if (backgroundProcess?.kind !== "pty") {
          try {
            process.kill(-state.pid, "SIGTERM");
          } catch {
            try {
              process.kill(state.pid, "SIGTERM");
            } catch {
              // The process may already have exited; record the stop request below.
            }
          }
        }
      }

      const endedAt = new Date().toISOString();
      const updated: WorkspaceBackgroundTaskState = {
        ...state,
        status: "stopped",
        inputWritable: false,
        endedAt,
        updatedAt: endedAt
      };
      await writeBackgroundTaskState({
        workspaceRoot: input.workspace.rootPath,
        sessionId: input.sessionId,
        state: updated
      });
      return updated;
    }
  };
}
