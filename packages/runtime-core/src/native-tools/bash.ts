import path from "node:path";

import { z } from "zod";

import type { RuntimeToolSet, WorkspaceRecord } from "../types.js";
import { MAX_BASH_TIMEOUT_MS } from "./constants.js";
import { normalizePathForMatch } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";
import { WorkspaceCommandCancelledError, WorkspaceCommandTimeoutError } from "../workspace-command-executor.js";
import { AppError } from "../errors.js";

const BASH_DESCRIPTION = `Run a shell command

- The command to execute
- Optional timeout in milliseconds (max 600000)
- Optional description for what the command does
- Optional run_in_background flag to keep long-running work out of the foreground`;

const BashInputSchema = z
  .object({
    command: z.string().min(1).describe("The command to execute"),
    timeout: z.number().positive().max(MAX_BASH_TIMEOUT_MS).optional().describe("Optional timeout in milliseconds"),
    description: z.string().optional().describe("Clear, concise description of what this command does"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background")
  })
  .strict();

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
  const lines = ["started: true", `task_id: ${input.taskId}`, `pid: ${input.pid}`, `output_path: ${input.outputPath}`];

  if (input.description) {
    lines.push(`description: ${input.description}`);
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

export function createBashTool(context: NativeToolFactoryContext): RuntimeToolSet {
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

        if (input.run_in_background) {
          const workspace = syntheticWorkspace(context.workspaceRoot);
          const background = await context.commandExecutor.runBackground({
            workspace,
            command: input.command,
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
            command: input.command,
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
