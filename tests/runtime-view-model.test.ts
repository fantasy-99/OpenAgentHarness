import { describe, expect, it } from "vitest";

import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import { buildRuntimeViewModel } from "../apps/web/src/app/runtime-view-model";

function createModelCallStep(input: Partial<RunStep> = {}): RunStep {
  return {
    id: "step_model_1",
    runId: "run_1",
    seq: 2,
    stepType: "model_call",
    status: "completed",
    input: {
      request: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [
          {
            role: "system",
            content: "trace system prompt"
          },
          {
            role: "user",
            content: "hello"
          }
        ]
      },
      runtime: {
        messageCount: 2,
        activeToolNames: [],
        runtimeToolNames: []
      }
    },
    output: {
      response: {
        text: "done",
        finishReason: "stop",
        toolCalls: [],
        toolResults: []
      },
      runtime: {
        toolCallsCount: 0,
        toolResultsCount: 0
      }
    },
    startedAt: "2026-04-07T00:00:00.000Z",
    endedAt: "2026-04-07T00:00:01.000Z",
    ...input
  };
}

function createAssistantMessage(input: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    sessionId: "ses_1",
    runId: "run_1",
    role: "assistant",
    content: "reply",
    createdAt: "2026-04-07T00:00:02.000Z",
    ...input
  };
}

function createEvent(input: Partial<SessionEventContract> & Pick<SessionEventContract, "cursor" | "event" | "data">): SessionEventContract {
  return {
    id: `evt_${input.cursor}`,
    sessionId: "ses_1",
    createdAt: "2026-04-07T00:00:00.000Z",
    ...input
  };
}

describe("buildRuntimeViewModel", () => {
  it("prefers the persisted message system prompt snapshot for the selected message", () => {
    const message = createAssistantMessage({
      metadata: {
        systemMessages: [
          {
            role: "system",
            content: "persisted message prompt"
          }
        ],
        modelCallStepId: "step_model_1",
        modelCallStepSeq: 2
      }
    });

    const viewModel = buildRuntimeViewModel({
      messages: [message],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {},
      selectedTraceId: "",
      selectedMessageId: message.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.composedSystemMessages.map((entry) => entry.content)).toEqual(["trace system prompt"]);
    expect(viewModel.selectedMessageSystemMessages.map((entry) => entry.content)).toEqual(["persisted message prompt"]);
  });

  it("falls back to the referenced model-call trace when the message snapshot is missing", () => {
    const message = createAssistantMessage({
      metadata: {
        modelCallStepId: "step_model_1",
        modelCallStepSeq: 2
      }
    });

    const viewModel = buildRuntimeViewModel({
      messages: [message],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {},
      selectedTraceId: "",
      selectedMessageId: message.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.selectedMessageSystemMessages.map((entry) => entry.content)).toEqual(["trace system prompt"]);
  });

  it("keeps multiple assistant bubbles from the same run when live output belongs to a different message", () => {
    const toolCallMessage = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "read_file",
          input: {
            path: "README.md"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const finalAssistantMessageId = "msg_final_assistant";

    const viewModel = buildRuntimeViewModel({
      messages: [toolCallMessage],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {
        [finalAssistantMessageId]: {
          messageId: finalAssistantMessageId,
          runId: "run_1",
          sessionId: "ses_1",
          content: "streaming final reply",
          createdAt: "2026-04-07T00:00:04.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: toolCallMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual(["msg_tool_call", "live:msg_final_assistant"]);
    expect(viewModel.messageFeed.map((message) => message.role)).toEqual(["assistant", "assistant"]);
  });

  it("replaces the persisted copy when live output is for the same assistant message", () => {
    const persistedAssistantMessage = createAssistantMessage({
      id: "msg_streaming",
      content: "stale persisted reply",
      createdAt: "2026-04-07T00:00:03.000Z"
    });

    const viewModel = buildRuntimeViewModel({
      messages: [persistedAssistantMessage],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {
        msg_streaming: {
          messageId: "msg_streaming",
          runId: "run_1",
          sessionId: "ses_1",
          content: "fresh live reply",
          createdAt: "2026-04-07T00:00:05.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: persistedAssistantMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed).toHaveLength(1);
    expect(viewModel.messageFeed[0]).toMatchObject({
      id: "live:msg_streaming",
      content: "fresh live reply",
      createdAt: "2026-04-07T00:00:03.000Z"
    });
  });

  it("preserves live assistant metadata for the conversation view", () => {
    const viewModel = buildRuntimeViewModel({
      messages: [],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {
        msg_streaming: {
          messageId: "msg_streaming",
          runId: "run_1",
          sessionId: "ses_1",
          content: "fresh live reply",
          metadata: {
            agentName: "plan",
            effectiveAgentName: "plan",
            agentMode: "primary"
          },
          createdAt: "2026-04-07T00:00:05.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed).toHaveLength(1);
    expect(viewModel.messageFeed[0]).toMatchObject({
      id: "live:msg_streaming",
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      }
    });
  });

  it("projects interrupted assistant text into separate bubbles using session events", () => {
    const userMessage: Message = {
      id: "msg_user",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const streamedAssistant = createAssistantMessage({
      id: "msg_streamed",
      content: [{ type: "text", text: "first part second part" }],
      createdAt: "2026-04-07T00:00:01.000Z"
    });
    const assistantToolCall = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          input: { to: "plan" }
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const toolResult: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          output: {
            type: "text",
            value: "switched"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:03.000Z"
    };

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, streamedAssistant, assistantToolCall, toolResult],
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "2",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_call",
            content: assistantToolCall.content
          }
        }),
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "first part"
          }
        }),
        createEvent({
          cursor: "3",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_result",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            content: toolResult.content
          }
        }),
        createEvent({
          cursor: "4",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "second part"
          }
        }),
        createEvent({
          cursor: "5",
          runId: "run_1",
          event: "run.completed",
          data: {
            runId: "run_1",
            status: "completed"
          }
        })
      ],
      liveOutput: {},
      selectedTraceId: "",
      selectedMessageId: streamedAssistant.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "msg_user",
      "segment:msg_streamed:1",
      "msg_tool_call",
      "msg_tool_result",
      "segment:msg_streamed:2"
    ]);
    expect(viewModel.messageFeed.map((message) => message.content)).toEqual([
      "hello",
      "first part",
      assistantToolCall.content,
      toolResult.content,
      "second part"
    ]);
  });

  it("keeps a live interrupted assistant segment in its projected position before completion", () => {
    const userMessage: Message = {
      id: "msg_user",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const assistantToolCall = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          input: { to: "plan" }
        }
      ],
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      },
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const toolResult: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          output: {
            type: "text",
            value: "switched"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:03.000Z"
    };

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, assistantToolCall, toolResult],
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "first part"
          }
        }),
        createEvent({
          cursor: "2",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_call",
            content: assistantToolCall.content
          }
        }),
        createEvent({
          cursor: "3",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_result",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            content: toolResult.content
          }
        }),
        createEvent({
          cursor: "4",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "second part"
          }
        })
      ],
      liveOutput: {
        msg_streamed: {
          messageId: "msg_streamed",
          runId: "run_1",
          sessionId: "ses_1",
          content: "first partsecond part",
          metadata: {
            agentName: "plan",
            effectiveAgentName: "plan",
            agentMode: "primary"
          },
          createdAt: "2026-04-07T00:00:01.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "msg_user",
      "segment:msg_streamed:1",
      "msg_tool_call",
      "msg_tool_result",
      "segment:msg_streamed:2"
    ]);
    expect(viewModel.messageFeed.map((message) => message.content)).toEqual([
      "hello",
      "first part",
      assistantToolCall.content,
      toolResult.content,
      "second part"
    ]);
    expect(viewModel.messageFeed[4]).toMatchObject({
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      }
    });
  });
});
