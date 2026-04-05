import path from "node:path";

import { z } from "zod";

import type { RuntimeToolSet } from "../types.js";
import { MAX_BASH_TIMEOUT_MS } from "./constants.js";
import { normalizePathForMatch } from "./paths.js";
import { runShellCommandBackground, runShellCommandForeground } from "./process-utils.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

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
          const background = await runShellCommandBackground(
            context.workspaceRoot,
            input.command,
            context.sessionId,
            input.description
          );
          return formatBackgroundBashOutput({
            taskId: background.taskId,
            pid: background.pid,
            outputPath: normalizePathForMatch(path.relative(context.workspaceRoot, background.outputPath)),
            description: input.description
          });
        }

        const result = await runShellCommandForeground(
          context.workspaceRoot,
          input.command,
          input.timeout,
          executionContext.abortSignal
        );
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
