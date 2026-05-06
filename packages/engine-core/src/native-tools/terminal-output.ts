import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput, type ToolOutputValue } from "../capabilities/tool-output.js";
import type { EngineToolSet, WorkspaceRecord } from "../types.js";
import { formatReadLines } from "./fs-utils.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const TERMINAL_OUTPUT_DESCRIPTION = `Read output and status for a background terminal.

- Use terminal_id from a Bash command started with run_in_background
- Returns terminal status, exit code when known, and log content
- Prefer this for status checks; Read can still read the output_path directly`;

const TerminalOutputInputSchema = z
  .object({
    terminal_id: z.string().min(1).describe("The background terminal ID"),
    offset: z.number().int().nonnegative().optional().describe("The line number to start reading from"),
    limit: z.number().int().positive().optional().describe("The number of output lines to read")
  })
  .strict();

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

function createTerminalOutputToolDefinition(context: NativeToolFactoryContext) {
  return {
    description: TERMINAL_OUTPUT_DESCRIPTION,
    retryPolicy: getNativeToolRetryPolicy("TerminalOutput"),
    inputSchema: TerminalOutputInputSchema,
    async execute(rawInput: unknown) {
      context.assertVisible("TerminalOutput");
      const input = TerminalOutputInputSchema.parse(rawInput);
      const terminalId = input.terminal_id;
        if (!context.commandExecutor.getBackgroundTask) {
          throw new AppError(501, "native_tool_background_output_unsupported", "Background task output lookup is not supported by this command executor.");
        }

        const workspace = syntheticWorkspace(context.workspaceRoot);
        const task = await context.commandExecutor.getBackgroundTask({
          workspace,
          sessionId: context.sessionId,
        taskId: terminalId
        });

        if (!task) {
          throw new AppError(404, "native_tool_background_task_not_found", `Background terminal ${terminalId} was not found.`);
        }

        const resolved = await resolveWorkspacePath(context.fileSystem, context.workspaceRoot, task.outputPath);
        const entry = await context.fileSystem.stat(resolved.absolutePath).catch(() => null);
        const content = entry?.kind === "file" ? (await context.fileSystem.readFile(resolved.absolutePath)).toString("utf8") : "";
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 2000;
        const { rendered, truncated, totalLines } = formatReadLines(content, offset, limit);

        const fields: Array<[string, ToolOutputValue]> = [
          ["terminal_id", task.taskId],
          ["status", task.status],
          ["output_path", path.posix.normalize(task.outputPath)],
          ["offset", Math.max(1, offset || 1)],
          ["returned_lines", rendered.length],
          ["total_lines", totalLines],
          ["truncated", truncated]
        ];
        const insertion: Array<[string, ToolOutputValue]> = [];
        if (typeof task.pid === "number") {
          insertion.push(["pid", task.pid]);
        }
        if (typeof task.inputWritable === "boolean") {
          insertion.push(["input_writable", task.inputWritable]);
        }
        if (task.terminalKind) {
          insertion.push(["terminal_kind", task.terminalKind]);
        }
        if (typeof task.exitCode === "number") {
          insertion.push(["exit_code", task.exitCode]);
        }
        if (task.signal) {
          insertion.push(["signal", task.signal]);
        }
        fields.splice(2, 0, ...insertion);

        return formatToolOutput(
          fields,
          [
            {
              title: "output",
              lines: rendered,
              emptyText: "(no output)"
            }
          ]
        );
      }
  };
}

export function createTerminalOutputTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    TerminalOutput: createTerminalOutputToolDefinition(context)
  };
}
