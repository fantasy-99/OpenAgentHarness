import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput, type ToolOutputValue } from "../capabilities/tool-output.js";
import type { EngineToolSet, WorkspaceRecord } from "../types.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const TASK_STOP_DESCRIPTION = `Stop a background Bash task.

- Use task_id from a Bash command started with run_in_background
- Stops the process when the command executor supports background task control
- Returns the recorded final status`;

const TaskStopInputSchema = z
  .object({
    task_id: z.string().min(1).describe("The background task ID to stop")
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

export function createTaskStopTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    TaskStop: {
      description: TASK_STOP_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("TaskStop"),
      inputSchema: TaskStopInputSchema,
      async execute(rawInput) {
        context.assertVisible("TaskStop");
        const input = TaskStopInputSchema.parse(rawInput);
        if (!context.commandExecutor.stopBackgroundTask) {
          throw new AppError(501, "native_tool_background_stop_unsupported", "Background task stopping is not supported by this command executor.");
        }

        const workspace = syntheticWorkspace(context.workspaceRoot);
        const task = await context.commandExecutor.stopBackgroundTask({
          workspace,
          sessionId: context.sessionId,
          taskId: input.task_id
        });

        if (!task) {
          throw new AppError(404, "native_tool_background_task_not_found", `Background task ${input.task_id} was not found.`);
        }

        const fields: Array<[string, ToolOutputValue]> = [
          ["task_id", task.taskId],
          ["status", task.status],
          ["output_path", task.outputPath]
        ];
        if (typeof task.pid === "number") {
          fields.splice(2, 0, ["pid", task.pid]);
        }
        if (typeof task.exitCode === "number") {
          fields.splice(3, 0, ["exit_code", task.exitCode]);
        }
        if (task.signal) {
          fields.splice(4, 0, ["signal", task.signal]);
        }

        return formatToolOutput(fields);
      }
    }
  };
}
