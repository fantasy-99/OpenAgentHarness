import type { Message, Run } from "@oah/api-contracts";

import { toolErrorResultContent, toolResultContent } from "../runtime-message-content.js";
import { formatToolOutput } from "../tool-output.js";

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

export function buildDelegatedRunCompletedMessage(input: {
  createId: (prefix: string) => string;
  nowIso: () => string;
  parentSessionId: string;
  parentRunId: string;
  parentAgentName: string;
  childSummary: AwaitedRunSummaryView;
}): Message {
  return {
    id: input.createId("msg"),
    sessionId: input.parentSessionId,
    runId: input.parentRunId,
    role: "tool",
    content: toolResultContent({
      toolCallId: `delegate_${input.childSummary.run.id}`,
      toolName: "SubAgent",
      output: renderAwaitedRunSummary(input.childSummary)
    }),
    metadata: {
      agentName: input.parentAgentName,
      effectiveAgentName: input.parentAgentName,
      toolStatus: "completed",
      toolSourceType: "agent",
      synthetic: true,
      delegatedUpdate: "completed",
      delegatedChildRunId: input.childSummary.run.id,
      delegatedChildSessionId: input.childSummary.run.sessionId
    },
    createdAt: input.nowIso()
  };
}

export function buildDelegatedRunFailedMessage(input: {
  createId: (prefix: string) => string;
  nowIso: () => string;
  parentSessionId: string;
  parentRunId: string;
  parentAgentName: string;
  childRun: Run;
}): Message {
  return {
    id: input.createId("msg"),
    sessionId: input.parentSessionId,
    runId: input.parentRunId,
    role: "tool",
    content: toolErrorResultContent({
      toolCallId: `delegate_${input.childRun.id}`,
      toolName: "SubAgent",
      error: formatToolOutput(
        [
          ["task_id", input.childRun.sessionId],
          ["run_id", input.childRun.id],
          ["status", input.childRun.status],
          ["subagent_name", input.childRun.effectiveAgentName]
        ],
        [
          ...(input.childRun.errorMessage
            ? [
                {
                  title: "error_message",
                  lines: input.childRun.errorMessage.split(/\r?\n/),
                  emptyText: "(empty error)"
                }
              ]
            : [])
        ]
      )
    }),
    metadata: {
      agentName: input.parentAgentName,
      effectiveAgentName: input.parentAgentName,
      toolStatus: "failed",
      toolSourceType: "agent",
      synthetic: true,
      delegatedUpdate: "failed",
      delegatedChildRunId: input.childRun.id,
      delegatedChildSessionId: input.childRun.sessionId
    },
    createdAt: input.nowIso()
  };
}
