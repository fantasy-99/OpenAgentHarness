import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput, type ToolOutputValue } from "../capabilities/tool-output.js";
import type { EngineToolSet, WorkspaceRecord } from "../types.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const TASK_INPUT_DESCRIPTION = `Send input to a running background Bash task.

- Use task_id from a Bash command started with run_in_background
- Sends text to the task stdin; by default a newline is appended
- Use TaskOutput afterwards to inspect new output`;

const TaskInputInputSchema = z
  .object({
    task_id: z.string().min(1).describe("The background task ID"),
    input: z.string().describe("Text to write to the background task stdin"),
    append_newline: z.boolean().optional().describe("Append a newline after input text; defaults to true")
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

export function createTaskInputTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    TaskInput: {
      description: TASK_INPUT_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("TaskInput"),
      inputSchema: TaskInputInputSchema,
      async execute(rawInput) {
        context.assertVisible("TaskInput");
        const input = TaskInputInputSchema.parse(rawInput);
        if (!context.commandExecutor.writeBackgroundTaskInput) {
          throw new AppError(
            501,
            "native_tool_background_input_unsupported",
            "Background task input is not supported by this command executor."
          );
        }

        const workspace = syntheticWorkspace(context.workspaceRoot);
        const task = await context.commandExecutor.writeBackgroundTaskInput({
          workspace,
          sessionId: context.sessionId,
          taskId: input.task_id,
          inputText: input.input,
          ...(input.append_newline !== undefined ? { appendNewline: input.append_newline } : {})
        });

        if (!task) {
          throw new AppError(404, "native_tool_background_task_not_found", `Background task ${input.task_id} was not found.`);
        }
        if (task.status !== "running") {
          throw new AppError(
            409,
            "native_tool_background_task_not_running",
            `Background task ${input.task_id} is not running; current status is ${task.status}.`
          );
        }
        if (task.inputWritable === false) {
          throw new AppError(
            409,
            "native_tool_background_input_unavailable",
            `Background task ${input.task_id} is running, but its stdin is not available in this executor process.`
          );
        }

        const fields: Array<[string, ToolOutputValue]> = [
          ["task_id", task.taskId],
          ["status", task.status],
          ["input_written", true],
          ["append_newline", input.append_newline ?? true],
          ["output_path", task.outputPath]
        ];
        if (typeof task.pid === "number") {
          fields.splice(2, 0, ["pid", task.pid]);
        }
        if (task.terminalKind) {
          fields.splice(3, 0, ["terminal_kind", task.terminalKind]);
        }

        return formatToolOutput(fields);
      }
    }
  };
}
