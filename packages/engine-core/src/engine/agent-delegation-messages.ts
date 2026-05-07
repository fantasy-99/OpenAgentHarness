import path from "node:path";
import { tmpdir } from "node:os";

import type { Message, Run } from "@oah/api-contracts";

import { formatToolOutput } from "../capabilities/tool-output.js";
import type { LocalAgentTaskStateRecord } from "../types.js";

export interface AwaitedRunSummaryView {
  run: Run;
  outputContent?: string | undefined;
}

export function buildDelegatedTaskMessage(
  currentAgentName: string,
  targetAgentName: string,
  task: string,
  handoffSummary?: string | undefined
): string {
  return [
    `<delegated_task from_agent="${currentAgentName}" to_agent="${targetAgentName}">`,
    "<task>",
    task,
    "</task>",
    ...(handoffSummary ? ["<handoff_summary>", handoffSummary, "</handoff_summary>"] : []),
    "<output_contract>",
    "When the task is complete, your final assistant response must be the output returned to the parent agent.",
    "Write a concise, self-contained result. Include any important findings, decisions, files changed, errors, or blockers.",
    "Do not finish the run without a final assistant response. If there is nothing to report, say that explicitly.",
    "</output_contract>",
    "</delegated_task>"
  ].join("\n");
}

export function renderAwaitedRunSummary(summary: AwaitedRunSummaryView): string {
  return formatToolOutput(
    [
      ["task_id", summary.run.sessionId],
      ["run_id", summary.run.id],
      ["status", summary.run.status],
      ["subagent_name", summary.run.effectiveAgentName]
    ],
    [
      ...(summary.outputContent
        ? [
            {
              title: "output",
              lines: summary.outputContent.split(/\r?\n/),
              emptyText: "(empty output)"
            }
          ]
        : []),
      ...(summary.run.errorMessage
        ? [
            {
              title: "error_message",
              lines: summary.run.errorMessage.split(/\r?\n/),
              emptyText: "(empty error)"
            }
          ]
        : [])
    ]
  );
}

function taskOutputDir(sessionId: string): string {
  return path.join(process.env.OAH_TASK_OUTPUT_DIR ?? path.join(tmpdir(), "open-agent-harness"), sessionId, "tasks");
}

function taskOutputPath(sessionId: string, taskId: string): string {
  return path.join(taskOutputDir(sessionId), `${taskId}.output`);
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function taskNotificationContent(input: {
  taskId: string;
  childRunId?: string | undefined;
  toolUseId?: string | undefined;
  outputRef: string;
  status: "completed" | "failed" | "killed";
  summary: string;
  result?: string | undefined;
  error?: string | undefined;
  usage?: Record<string, unknown> | undefined;
}): string {
  const result = input.result?.trim();
  const error = input.error?.trim();
  const usageSection = renderUsageSection(input.usage);
  return [
    "<task-notification>",
    `<task-id>${escapeXmlText(input.taskId)}</task-id>`,
    ...(input.childRunId ? [`<child_run_id>${escapeXmlText(input.childRunId)}</child_run_id>`] : []),
    ...(input.toolUseId ? [`<tool_use_id>${escapeXmlText(input.toolUseId)}</tool_use_id>`] : []),
    `<output_ref>${escapeXmlText(input.outputRef)}</output_ref>`,
    `<status>${escapeXmlText(input.status)}</status>`,
    `<summary>${escapeXmlText(input.summary)}</summary>`,
    ...(result ? [`<result>${escapeXmlText(result)}</result>`] : []),
    ...(error ? [`<error>${escapeXmlText(error)}</error>`] : []),
    ...(usageSection ? [usageSection] : []),
    "</task-notification>"
  ].join("\n");
}

function usageNumber(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function renderUsageSection(usage: Record<string, unknown> | undefined): string | undefined {
  const totalTokens = usageNumber(usage, "totalTokens");
  const inputTokens = usageNumber(usage, "inputTokens");
  const outputTokens = usageNumber(usage, "outputTokens");
  const toolUses = usageNumber(usage, "toolUses");
  const durationMs = usageNumber(usage, "durationMs");
  const lines = [
    totalTokens !== undefined ? `<total_tokens>${totalTokens}</total_tokens>` : "",
    inputTokens !== undefined ? `<input_tokens>${inputTokens}</input_tokens>` : "",
    outputTokens !== undefined ? `<output_tokens>${outputTokens}</output_tokens>` : "",
    toolUses !== undefined ? `<tool_uses>${toolUses}</tool_uses>` : "",
    durationMs !== undefined ? `<duration_ms>${durationMs}</duration_ms>` : ""
  ].filter(Boolean);

  return lines.length > 0 ? `<usage>${lines.join("")}</usage>` : undefined;
}

export function buildDelegatedRunCompletedMessage(input: {
  messageId: string;
  runId: string;
  createdAt: string;
  parentSessionId: string;
  parentAgentName: string;
  childSummary: AwaitedRunSummaryView;
  toolUseId?: string | undefined;
  outputRef: string;
  outputFile: string;
  usage?: Record<string, unknown> | undefined;
  taskState?: LocalAgentTaskStateRecord | undefined;
}): Message {
  const taskId = input.childSummary.run.sessionId ?? input.childSummary.run.id;
  return {
    id: input.messageId,
    sessionId: input.parentSessionId,
    runId: input.runId,
    role: "user",
    origin: "engine",
    mode: "task-notification",
    content: taskNotificationContent({
      taskId,
      childRunId: input.childSummary.run.id,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      outputRef: input.outputRef,
      status: "completed",
      summary: `Agent "${input.childSummary.run.effectiveAgentName}" completed`,
      result: input.childSummary.outputContent,
      ...(input.usage ? { usage: input.usage } : {})
    }),
    metadata: {
      agentName: input.parentAgentName,
      effectiveAgentName: input.parentAgentName,
      runtimeKind: "task_notification",
      origin: "engine",
      mode: "task-notification",
      source: "engine",
      synthetic: true,
      taskNotification: true,
      delegatedUpdate: "completed",
      delegatedChildRunId: input.childSummary.run.id,
      delegatedChildSessionId: taskId,
      delegatedTaskId: taskId,
      ...(input.toolUseId ? { delegatedToolUseId: input.toolUseId } : {}),
      outputRef: input.outputRef,
      outputFile: input.outputFile,
      ...(input.taskState ? { taskState: input.taskState } : {}),
      ...(input.usage ? { usage: input.usage } : {})
    },
    createdAt: input.createdAt
  };
}

export function buildDelegatedRunFailedMessage(input: {
  messageId: string;
  runId: string;
  createdAt: string;
  parentSessionId: string;
  parentAgentName: string;
  childRun: Run;
  toolUseId?: string | undefined;
  outputRef: string;
  outputFile: string;
  usage?: Record<string, unknown> | undefined;
  taskState?: LocalAgentTaskStateRecord | undefined;
}): Message {
  const taskId = input.childRun.sessionId ?? input.childRun.id;
  return {
    id: input.messageId,
    sessionId: input.parentSessionId,
    runId: input.runId,
    role: "user",
    origin: "engine",
    mode: "task-notification",
    content: taskNotificationContent({
      taskId,
      childRunId: input.childRun.id,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      outputRef: input.outputRef,
      status: input.childRun.status === "cancelled" ? "killed" : "failed",
      summary: `Agent "${input.childRun.effectiveAgentName}" ${input.childRun.status}`,
      error: input.childRun.errorMessage,
      ...(input.usage ? { usage: input.usage } : {})
    }),
    metadata: {
      agentName: input.parentAgentName,
      effectiveAgentName: input.parentAgentName,
      runtimeKind: "task_notification",
      origin: "engine",
      mode: "task-notification",
      source: "engine",
      synthetic: true,
      taskNotification: true,
      delegatedUpdate: "failed",
      delegatedChildRunId: input.childRun.id,
      delegatedChildSessionId: taskId,
      delegatedTaskId: taskId,
      ...(input.toolUseId ? { delegatedToolUseId: input.toolUseId } : {}),
      outputRef: input.outputRef,
      outputFile: input.outputFile,
      ...(input.taskState ? { taskState: input.taskState } : {}),
      ...(input.usage ? { usage: input.usage } : {})
    },
    createdAt: input.createdAt
  };
}

export { taskOutputPath };
