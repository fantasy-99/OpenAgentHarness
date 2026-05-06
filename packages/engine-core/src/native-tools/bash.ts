import path from "node:path";

import { z } from "zod";

import type { EngineToolSet, WorkspaceRecord } from "../types.js";
import { MAX_BASH_TIMEOUT_MS } from "./constants.js";
import { normalizePathForMatch } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";
import { WorkspaceCommandCancelledError, WorkspaceCommandTimeoutError } from "../workspace/workspace-command-executor.js";
import { AppError } from "../errors.js";

const BASH_DESCRIPTION = `Run a shell command

- The command to execute
- Optional timeout in milliseconds (max 600000)
- Optional description for what the command does
- Optional run_in_background flag to keep long-running work out of the foreground
- Optional persistent_session_id to send commands to the same long-lived terminal session
- Optional close_persistent_session to stop a named persistent terminal session`;

const BashInputSchema = z
  .object({
    command: z.string().optional().describe("The command to execute"),
    timeout: z.number().positive().max(MAX_BASH_TIMEOUT_MS).optional().describe("Optional timeout in milliseconds"),
    description: z.string().optional().describe("Clear, concise description of what this command does"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background"),
    persistent_session_id: z.string().min(1).optional().describe("Send this command/input to a named persistent terminal session"),
    persistent_mode: z
      .enum(["command", "input"])
      .optional()
      .describe("Use command to wait for shell command completion, or input for interactive programs such as ssh"),
    append_newline: z.boolean().optional().describe("When persistent_mode is input, append a newline after command text"),
    close_persistent_session: z.boolean().optional().describe("Stop the named persistent terminal session")
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.close_persistent_session && (!input.command || input.command.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["command"],
        message: "command is required unless close_persistent_session is true"
      });
    }
  });

function formatBashOutput(input: {
  description?: string | undefined;
  exitCode?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
}): string {
  const lines = [`exit_code: ${input.exitCode ?? 0}`];

  if (input.description) {
    lines.push(`description: ${input.description}`);
  }

  if (input.stdout && input.stdout.length > 0) {
    lines.push("", "stdout:", input.stdout);
  }

  if (input.stderr && input.stderr.length > 0) {
    lines.push("", "stderr:", input.stderr);
  }

  if ((!input.stdout || input.stdout.length === 0) && (!input.stderr || input.stderr.length === 0)) {
    lines.push("", "(no output)");
  }

  return lines.join("\n");
}

function formatBackgroundBashOutput(input: {
  taskId: string;
  pid: number;
  outputPath: string;
  description?: string | undefined;
}): string {
  const lines = [
    "started: true",
    `terminal_id: ${input.taskId}`,
    `pid: ${input.pid}`,
    `output_path: ${input.outputPath}`
  ];

  if (input.description) {
    lines.push(`description: ${input.description}`);
  }

  return lines.join("\n");
}

function formatPersistentBashOutput(input: {
  terminalId: string;
  status: string;
  pid?: number | undefined;
  exitCode?: number | undefined;
  output?: string | undefined;
  description?: string | undefined;
  timedOut?: boolean | undefined;
}): string {
  const lines = [`persistent_session_id: ${input.terminalId}`, `status: ${input.status}`];

  if (input.pid !== undefined) {
    lines.push(`pid: ${input.pid}`);
  }

  if (input.exitCode !== undefined) {
    lines.push(`exit_code: ${input.exitCode}`);
  }

  if (input.timedOut) {
    lines.push("timed_out: true");
  }

  if (input.description) {
    lines.push(`description: ${input.description}`);
  }

  if (input.output && input.output.length > 0) {
    lines.push("", "output:", input.output);
  } else {
    lines.push("", "(no new output)");
  }

  return lines.join("\n");
}

function syntheticWorkspace(workspaceRoot: string): WorkspaceRecord {
  return {
    id: "native-tool-workspace",
    kind: "project",
    name: "native-tool-workspace",
    rootPath: workspaceRoot,
    readOnly: false,
    historyMirrorEnabled: false,
    settings: {},
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: "native-tool-workspace",
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    executionPolicy: "local",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

export function createBashTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    Bash: {
      description: BASH_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Bash"),
      inputSchema: BashInputSchema,
      async execute(rawInput, executionContext) {
        context.assertVisible("Bash");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["timeoutSeconds"]),
                timeout:
                  (rawInput as Record<string, unknown>).timeout ??
                  (rawInput as Record<string, unknown>).timeoutSeconds
              }
            : rawInput;
        const input = BashInputSchema.parse(normalizedInput);

        if (input.close_persistent_session) {
          if (!input.persistent_session_id) {
            throw new AppError(
              400,
              "native_tool_invalid_input",
              "Bash close_persistent_session requires persistent_session_id."
            );
          }
          if (!context.commandExecutor.stopPersistentTerminal) {
            throw new AppError(
              501,
              "native_tool_unsupported",
              "Persistent Bash terminals are not supported by this workspace command executor."
            );
          }

          const workspace = syntheticWorkspace(context.workspaceRoot);
          const stopped = await context.commandExecutor.stopPersistentTerminal({
            workspace,
            sessionId: context.sessionId,
            terminalId: input.persistent_session_id
          });

          return formatPersistentBashOutput({
            terminalId: input.persistent_session_id,
            status: stopped?.status ?? "exited",
            pid: stopped?.pid,
            exitCode: stopped?.exitCode,
            output: stopped?.output,
            description: input.description
          });
        }

        const command = input.command ?? "";

        if (input.persistent_session_id) {
          if (input.run_in_background) {
            throw new AppError(
              400,
              "native_tool_invalid_input",
              "Bash persistent_session_id cannot be combined with run_in_background."
            );
          }
          if (!context.commandExecutor.runPersistentTerminal) {
            throw new AppError(
              501,
              "native_tool_unsupported",
              "Persistent Bash terminals are not supported by this workspace command executor."
            );
          }

          const workspace = syntheticWorkspace(context.workspaceRoot);
          try {
            const persistent = await context.commandExecutor.runPersistentTerminal({
              workspace,
              sessionId: context.sessionId,
              terminalId: input.persistent_session_id,
              command,
              mode: input.persistent_mode ?? "command",
              ...(input.append_newline !== undefined ? { appendNewline: input.append_newline } : {}),
              ...(input.timeout !== undefined ? { timeoutMs: input.timeout } : {}),
              ...(executionContext.abortSignal ? { signal: executionContext.abortSignal } : {})
            });
            return formatPersistentBashOutput({
              terminalId: persistent.terminalId,
              status: persistent.status,
              pid: persistent.pid,
              exitCode: persistent.exitCode,
              output: persistent.output,
              description: input.description,
              timedOut: persistent.timedOut
            });
          } catch (error) {
            if (error instanceof WorkspaceCommandCancelledError) {
              throw new AppError(499, "native_tool_cancelled", "Persistent Bash was cancelled.");
            }
            throw error;
          }
        }

        if (input.run_in_background) {
          const workspace = syntheticWorkspace(context.workspaceRoot);
          const background = await context.commandExecutor.runBackground({
            workspace,
            command,
            sessionId: context.sessionId,
            description: input.description
          });
          return formatBackgroundBashOutput({
            taskId: background.taskId,
            pid: background.pid,
            outputPath: normalizePathForMatch(path.relative(context.workspaceRoot, background.outputPath)),
            description: input.description
          });
        }

        let result;
        try {
          const workspace = syntheticWorkspace(context.workspaceRoot);
          result = await context.commandExecutor.runForeground({
            workspace,
            command,
            timeoutMs: input.timeout,
            ...(executionContext.abortSignal ? { signal: executionContext.abortSignal } : {})
          });
        } catch (error) {
          if (error instanceof WorkspaceCommandTimeoutError) {
            throw new AppError(408, "native_tool_timeout", `Bash exceeded ${input.timeout ?? MAX_BASH_TIMEOUT_MS} milliseconds.`);
          }
          if (error instanceof WorkspaceCommandCancelledError) {
            throw new AppError(499, "native_tool_cancelled", "Bash was cancelled.");
          }
          throw error;
        }
        return formatBashOutput({
          description: input.description,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        });
      }
    }
  };
}
