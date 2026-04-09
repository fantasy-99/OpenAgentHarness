import { describe, expect, it } from "vitest";

import type { Message, Run, RunStep, Session, SessionEventContract, WorkspaceCatalog } from "@oah/api-contracts";

import { resolveMessageAgentInfo } from "../apps/web/src/app/chat/message-agent-info";

function createAssistantMessage(input: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    sessionId: "ses_1",
    runId: "run_1",
    role: "assistant",
    content: "reply",
    createdAt: "2026-04-08T00:00:02.000Z",
    ...input
  };
}

function createEvent(input: Partial<SessionEventContract> & Pick<SessionEventContract, "cursor" | "event" | "data">): SessionEventContract {
  return {
    id: `evt_${input.cursor}`,
    sessionId: "ses_1",
    createdAt: "2026-04-08T00:00:00.000Z",
    ...input
  };
}

const catalog: WorkspaceCatalog = {
  actions: [],
  agents: [
    {
      name: "assistant",
      mode: "primary",
      source: "workspace",
      description: "Default agent"
    },
    {
      name: "planner",
      mode: "all",
      source: "workspace",
      description: "Planner agent"
    }
  ],
  models: [],
  hooks: [],
  skills: [],
  tools: [],
  prompts: []
};

const session: Session = {
  id: "ses_1",
  workspaceId: "ws_1",
  title: "Conversation",
  agentName: "assistant",
  activeAgentName: "planner",
  status: "active",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:10.000Z"
};

const run: Run = {
  id: "run_1",
  sessionId: "ses_1",
  status: "running",
  agentName: "assistant",
  effectiveAgentName: "assistant",
  createdAt: "2026-04-08T00:00:00.000Z",
  startedAt: "2026-04-08T00:00:00.000Z"
};

const staleRunSteps: RunStep[] = [
  {
    id: "step_model_1",
    runId: "run_1",
    seq: 1,
    stepType: "model_call",
    status: "completed",
    agentName: "assistant",
    startedAt: "2026-04-08T00:00:01.000Z",
    endedAt: "2026-04-08T00:00:02.000Z"
  }
];

describe("resolveMessageAgentInfo", () => {
  it("uses the latest switched agent for a live assistant message before run-step refresh", () => {
    const message = createAssistantMessage({
      id: "live:msg_2"
    });

    const agentInfo = resolveMessageAgentInfo({
      message,
      catalog,
      runSteps: staleRunSteps,
      run,
      session,
      sessionEvents: [
        createEvent({
          cursor: "10",
          runId: "run_1",
          event: "agent.switched",
          data: {
            runId: "run_1",
            fromAgent: "assistant",
            toAgent: "planner"
          }
        })
      ]
    });

    expect(agentInfo).toEqual({
      name: "planner",
      mode: "all"
    });
  });

  it("uses the switched agent that happened before the message completed", () => {
    const message = createAssistantMessage({
      id: "msg_2"
    });

    const agentInfo = resolveMessageAgentInfo({
      message,
      catalog,
      runSteps: staleRunSteps,
      run,
      session,
      sessionEvents: [
        createEvent({
          cursor: "10",
          runId: "run_1",
          event: "agent.switched",
          data: {
            runId: "run_1",
            fromAgent: "assistant",
            toAgent: "planner"
          }
        }),
        createEvent({
          cursor: "11",
          runId: "run_1",
          event: "message.completed",
          data: {
            runId: "run_1",
            messageId: "msg_2",
            content: "reply"
          }
        })
      ]
    });

    expect(agentInfo).toEqual({
      name: "planner",
      mode: "all"
    });
  });

  it("keeps the agent that was active when the first delta of the message started", () => {
    const message = createAssistantMessage({
      id: "msg_2"
    });

    const agentInfo = resolveMessageAgentInfo({
      message,
      catalog,
      runSteps: staleRunSteps,
      run,
      session,
      sessionEvents: [
        createEvent({
          cursor: "9",
          runId: "run_1",
          event: "message.delta",
          data: {
            runId: "run_1",
            messageId: "msg_2",
            delta: "计划已制定好"
          }
        }),
        createEvent({
          cursor: "10",
          runId: "run_1",
          event: "agent.switched",
          data: {
            runId: "run_1",
            fromAgent: "assistant",
            toAgent: "planner"
          }
        }),
        createEvent({
          cursor: "11",
          runId: "run_1",
          event: "message.completed",
          data: {
            runId: "run_1",
            messageId: "msg_2",
            content: "计划已制定好"
          }
        })
      ]
    });

    expect(agentInfo).toEqual({
      name: "assistant",
      mode: "primary"
    });
  });

  it("keeps the persisted message snapshot ahead of later switch events", () => {
    const message = createAssistantMessage({
      id: "msg_2",
      metadata: {
        agentName: "assistant",
        effectiveAgentName: "assistant",
        agentMode: "primary"
      }
    });

    const agentInfo = resolveMessageAgentInfo({
      message,
      catalog,
      runSteps: staleRunSteps,
      run,
      session,
      sessionEvents: [
        createEvent({
          cursor: "10",
          runId: "run_1",
          event: "agent.switched",
          data: {
            runId: "run_1",
            fromAgent: "assistant",
            toAgent: "planner"
          }
        }),
        createEvent({
          cursor: "11",
          runId: "run_1",
          event: "message.completed",
          data: {
            runId: "run_1",
            messageId: "msg_2",
            content: "reply"
          }
        })
      ]
    });

    expect(agentInfo).toEqual({
      name: "assistant",
      mode: "primary"
    });
  });

  it("uses live tool message metadata instead of guessing from later run state", () => {
    const message: Message = {
      id: "live:tool-result:call_1",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "Search",
          output: {
            type: "text",
            value: "done"
          }
        }
      ],
      metadata: {
        agentName: "assistant",
        effectiveAgentName: "assistant",
        agentMode: "primary"
      },
      createdAt: "2026-04-08T00:00:02.000Z"
    };

    const agentInfo = resolveMessageAgentInfo({
      message,
      catalog,
      runSteps: [
        ...staleRunSteps,
        {
          id: "step_model_2",
          runId: "run_1",
          seq: 2,
          stepType: "model_call",
          status: "completed",
          agentName: "planner",
          startedAt: "2026-04-08T00:00:03.000Z",
          endedAt: "2026-04-08T00:00:04.000Z"
        }
      ],
      run: {
        ...run,
        effectiveAgentName: "planner"
      },
      session: {
        ...session,
        activeAgentName: "planner"
      },
      sessionEvents: [
        createEvent({
          cursor: "10",
          runId: "run_1",
          event: "agent.switched",
          data: {
            runId: "run_1",
            fromAgent: "assistant",
            toAgent: "planner"
          }
        })
      ]
    });

    expect(agentInfo).toEqual({
      name: "assistant",
      mode: "primary"
    });
  });
});
