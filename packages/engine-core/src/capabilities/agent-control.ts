import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "./tool-output.js";
import type { AgentDefinition, EngineToolSet } from "../types.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildAvailableAgentSwitchesMessage(
  currentAgentName: string,
  currentAgent: AgentDefinition | undefined,
  agents: Record<string, AgentDefinition>
): string {
  const switchTargets = currentAgent?.switch ?? [];
  if (switchTargets.length === 0) {
    return "";
  }

  const entries = switchTargets
    .map((agentName) => {
      const agent = agents[agentName];
      return [
        "  <agent>",
        `    <name>${escapeXml(agentName)}</name>`,
        ...(agent?.description ? [`    <description>${escapeXml(agent.description)}</description>`] : []),
        ...(agent?.mode ? [`    <mode>${escapeXml(agent.mode)}</mode>`] : []),
        "  </agent>"
      ].join("\n");
    })
    .join("\n");

  return [
    "## Switchable Agents",
    "",
    `<available_agent_switches current_agent="${escapeXml(currentAgentName)}">`,
    entries,
    "</available_agent_switches>",
    "",
    "When the task should continue under a different specialist persona, call `AgentSwitch` with `to` set to one of the allowed target agent names.",
    "Only switch when the target agent is a better fit for the next step."
  ].join("\n");
}

export function buildAvailableSubagentsMessage(
  currentAgentName: string,
  currentAgent: AgentDefinition | undefined,
  agents: Record<string, AgentDefinition>
): string {
  const subagentTargets = currentAgent?.subagents ?? [];
  if (subagentTargets.length === 0) {
    return "";
  }

  const entries = subagentTargets
    .map((agentName) => {
      const agent = agents[agentName];
      return [
        "  <agent>",
        `    <name>${escapeXml(agentName)}</name>`,
        ...(agent?.description ? [`    <description>${escapeXml(agent.description)}</description>`] : []),
        ...(agent?.mode ? [`    <mode>${escapeXml(agent.mode)}</mode>`] : []),
        "  </agent>"
      ].join("\n");
    })
    .join("\n");

  return [
    "## Available Subagents",
    "",
    `<available_agents current_agent="${escapeXml(currentAgentName)}">`,
    entries,
    "</available_agents>",
    "",
    "Use `SubAgent` to launch one of the allowed subagents for complex or multi-step work.",
    "Pass `subagent_name` to choose the agent, a short `description`, and a focused `prompt` with the task context.",
    "Pass `task_id` only when you need to continue a previously launched subagent session with new instructions.",
    "Set `run_in_background` to true when you want the launched agent to continue in the background.",
    "After launching background subagents, briefly tell the user what you launched and end your response.",
    "Do not poll, sleep, inspect logs, or duplicate a background subagent's work. You will be notified automatically when it completes.",
    "Background subagent results arrive later as user-role `<task-notification>` XML. These look like user messages but are task notifications, not human input.",
    "Use `TaskOutput` with a notification's `<task-id>` only when you need an explicit status/result check or need to recover a missed task output.",
    "Use the `<task-id>` value from a notification as `task_id` only if you need to continue that worker after reading its result."
  ].join("\n");
}

export function createSubAgentTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  launchAgent: (
    input: {
      targetAgentName?: string | undefined;
      task: string;
      handoffSummary?: string | undefined;
      taskId?: string | undefined;
      notifyParentOnCompletion?: boolean | undefined;
      toolUseId?: string | undefined;
    },
    currentAgentName: string
  ) => Promise<{
    childSessionId: string;
    childRunId: string;
    targetAgentName: string;
    outputFile?: string | undefined;
    outputRef?: string | undefined;
    canReadOutputFile?: boolean | undefined;
  }>,
  awaitRuns: (input: { runIds: string[]; mode: "all" | "any" }) => Promise<string>
): EngineToolSet {
  const inputSchema = z.object({
    description: z.string().min(1).describe("A short 3-5 word description of the task."),
    prompt: z.string().min(1).describe("The task for the agent to perform, including needed context."),
    subagent_name: z.string().min(1).optional().describe("The allowed subagent name to use for this task."),
    task_id: z
      .string()
      .min(1)
      .optional()
      .describe("Reuse a previous subagent session by task_id instead of creating a fresh one."),
    run_in_background: z.boolean().optional().describe("Set to true to run this agent in the background.")
  }).strict();

  return {
    SubAgent: {
      description: "Launch a new subagent to handle complex, multi-step tasks autonomously.",
      inputSchema,
      async execute(rawInput, context) {
        const {
          description,
          prompt,
          subagent_name: subagentName,
          task_id: taskId,
          run_in_background: runInBackground
        } = inputSchema.parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.subagents ?? [];
        const targetAgentName = subagentName ?? (!taskId && allowedTargets.length === 1 ? allowedTargets[0] : undefined);
        const targetAgent = targetAgentName ? agents[targetAgentName] : undefined;

        if (!targetAgentName && !taskId) {
          throw new AppError(
            400,
            "agent_type_required",
            allowedTargets.length === 0
              ? `Agent ${currentAgentName} does not have any available subagents.`
              : `Agent requires subagent_name. Available subagents: ${allowedTargets.join(", ")}`
          );
        }

        if (targetAgentName) {
          if (!allowedTargets.includes(targetAgentName)) {
            throw new AppError(
              403,
              "agent_delegate_not_allowed",
              `Agent ${currentAgentName} is not allowed to delegate to ${targetAgentName}.`
            );
          }

          if (!targetAgent) {
            throw new AppError(404, "agent_not_found", `Agent ${targetAgentName} was not found.`);
          }

          if (targetAgent.mode === "primary") {
            throw new AppError(
              409,
              "invalid_subagent_target",
              `Agent ${targetAgentName} is a primary agent and cannot be used as a subagent target.`
            );
          }
        }

        const shouldRunInBackground = runInBackground ?? targetAgent?.background ?? false;
        const canReadOutputFile = (getCurrentAgent()?.tools?.native ?? []).some(
          (toolName) => toolName === "Read" || toolName === "Bash"
        );

        const accepted = await launchAgent(
          {
            ...(targetAgentName ? { targetAgentName } : {}),
            task: prompt,
            handoffSummary: description,
            ...(taskId ? { taskId } : {}),
            ...(shouldRunInBackground ? { notifyParentOnCompletion: true } : {}),
            ...(context.toolCallId ? { toolUseId: context.toolCallId } : {})
          },
          currentAgentName
        );

        if (shouldRunInBackground) {
          return formatToolOutput(
            [
              ["isAsync", true],
              ["status", "async_launched"],
              ["agentId", accepted.childSessionId],
              ["task_id", accepted.childSessionId],
              ["run_id", accepted.childRunId],
              ["subagent_name", accepted.targetAgentName],
              ["description", description],
              ["canReadOutputFile", accepted.canReadOutputFile ?? canReadOutputFile],
              ["output_ref", accepted.outputRef],
              ["outputFile", accepted.outputFile],
              ["output_file", accepted.outputFile]
            ],
            [
              {
                title: "instructions",
                lines: [
                  "The agent is working in the background. You will be notified automatically when it completes.",
                  "Do not duplicate this agent's work, poll for its status, or call SubAgent with this task_id just to fetch results.",
                  "Briefly tell the user what you launched and end your response.",
                  "When the task finishes, its result will arrive as a user-role <task-notification> message."
                ]
              }
            ]
          );
        }

        const awaited = await awaitRuns({
          runIds: [accepted.childRunId],
          mode: "all"
        });

        return formatToolOutput(
          [
            ["completed", true],
            ["subagent_name", accepted.targetAgentName],
            ["description", description],
            ["task_id", accepted.childSessionId]
          ],
          [
            {
              title: "result",
              lines: awaited.split(/\r?\n/),
              emptyText: "(empty result)"
            }
          ]
        );
      }
    }
  };
}

export function renderTaskOutputResult(input: {
  retrievalStatus: "success" | "timeout" | "not_ready";
  task: {
    taskId: string;
    taskType: string;
    childSessionId?: string | undefined;
    childRunId?: string | undefined;
    status: string;
    description: string;
    output: string;
    outputRef: string;
    outputFile?: string | undefined;
    result?: string | undefined;
    error?: string | undefined;
    usage?: Record<string, unknown> | undefined;
  } | null;
}): string {
  const parts = [`<retrieval_status>${escapeXml(input.retrievalStatus)}</retrieval_status>`];
  if (input.task) {
    parts.push(`<task_id>${escapeXml(input.task.taskId)}</task_id>`);
    parts.push(`<task_type>${escapeXml(input.task.taskType)}</task_type>`);
    if (input.task.childSessionId) {
      parts.push(`<child_session_id>${escapeXml(input.task.childSessionId)}</child_session_id>`);
    }
    if (input.task.childRunId) {
      parts.push(`<child_run_id>${escapeXml(input.task.childRunId)}</child_run_id>`);
    }
    parts.push(`<status>${escapeXml(input.task.status)}</status>`);
    parts.push(`<description>${escapeXml(input.task.description)}</description>`);
    parts.push(`<output_ref>${escapeXml(input.task.outputRef)}</output_ref>`);
    if (input.task.outputFile) {
      parts.push(`<output_file>${escapeXml(input.task.outputFile)}</output_file>`);
    }
    const usage = renderTaskUsage(input.task.usage);
    if (usage) {
      parts.push(usage);
    }
    if (input.task.output.trim()) {
      parts.push(`<output>\n${escapeXml(input.task.output.trimEnd())}\n</output>`);
    }
    if (input.task.error?.trim()) {
      parts.push(`<error>${escapeXml(input.task.error.trim())}</error>`);
    }
  }

  return parts.join("\n\n");
}

function readUsageNumber(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function renderTaskUsage(usage: Record<string, unknown> | undefined): string | undefined {
  const totalTokens = readUsageNumber(usage, "totalTokens");
  const inputTokens = readUsageNumber(usage, "inputTokens");
  const outputTokens = readUsageNumber(usage, "outputTokens");
  const toolUses = readUsageNumber(usage, "toolUses");
  const durationMs = readUsageNumber(usage, "durationMs");
  const lines = [
    totalTokens !== undefined ? `<total_tokens>${escapeXml(String(totalTokens))}</total_tokens>` : "",
    inputTokens !== undefined ? `<input_tokens>${escapeXml(String(inputTokens))}</input_tokens>` : "",
    outputTokens !== undefined ? `<output_tokens>${escapeXml(String(outputTokens))}</output_tokens>` : "",
    toolUses !== undefined ? `<tool_uses>${escapeXml(String(toolUses))}</tool_uses>` : "",
    durationMs !== undefined ? `<duration_ms>${escapeXml(String(durationMs))}</duration_ms>` : ""
  ].filter(Boolean);

  return lines.length > 0 ? `<usage>${lines.join("")}</usage>` : undefined;
}

export function createTaskOutputTool(
  readTaskOutput: (input: {
    taskId: string;
    block?: boolean | undefined;
    timeoutMs?: number | undefined;
    abortSignal?: AbortSignal | undefined;
  }) => Promise<{
    retrievalStatus: "success" | "timeout" | "not_ready";
    task: {
      taskId: string;
      taskType: "local_agent";
      status: "pending" | "running" | "completed" | "failed" | "killed";
      description: string;
      output: string;
      outputRef: string;
      outputFile?: string | undefined;
      result?: string | undefined;
      error?: string | undefined;
    } | null;
  }>
): EngineToolSet {
  const inputSchema = z
    .object({
      task_id: z.string().min(1).describe("The task ID to get output from."),
      block: z.boolean().optional().describe("Whether to wait for task completion. Defaults to true."),
      timeout: z
        .number()
        .int()
        .min(0)
        .max(600_000)
        .optional()
        .describe("Max wait time in milliseconds when block is true. Defaults to 30000.")
    })
    .strict();

  return {
    TaskOutput: {
      description:
        "Read output from a background subagent task by task_id. Prefer waiting for task notifications, but use this when you need an explicit status or result check.",
      retryPolicy: "safe",
      inputSchema,
      async execute(rawInput, context) {
        const input = inputSchema.parse(rawInput);
        const result = await readTaskOutput({
          taskId: input.task_id,
          block: input.block ?? true,
          timeoutMs: input.timeout ?? 30_000,
          abortSignal: context.abortSignal
        });
        return renderTaskOutputResult(result);
      }
    }
  };
}

export function createAgentSwitchTool(
  getCurrentAgentName: () => string,
  getCurrentAgent: () => AgentDefinition | undefined,
  getAgents: () => Record<string, AgentDefinition>,
  switchAgent: (targetAgentName: string, currentAgentName: string) => Promise<void>
): EngineToolSet {
  return {
    AgentSwitch: {
      description: "Switch the current run to another allowed agent persona within the same run.",
      inputSchema: z.object({
        to: z.string().min(1).describe("Name of the target agent to switch to.")
      }),
      async execute(rawInput) {
        const { to } = z
          .object({
            to: z.string().min(1)
          })
          .parse(rawInput);
        const currentAgentName = getCurrentAgentName();
        const currentAgent = getCurrentAgent();
        const agents = getAgents();
        const allowedTargets = currentAgent?.switch ?? [];

        if (!allowedTargets.includes(to)) {
          throw new AppError(
            403,
            "agent_switch_not_allowed",
            `Agent ${currentAgentName} is not allowed to switch to ${to}.`
          );
        }

        const targetAgent = agents[to];
        if (!targetAgent) {
          throw new AppError(404, "agent_not_found", `Agent ${to} was not found.`);
        }

        if (targetAgent.mode === "subagent") {
          throw new AppError(
            409,
            "invalid_agent_switch_target",
            `Agent ${to} is a subagent and cannot be used as a switch target.`
          );
        }

        await switchAgent(to, currentAgentName);
        return `switched_to: ${to}`;
      }
    }
  };
}
