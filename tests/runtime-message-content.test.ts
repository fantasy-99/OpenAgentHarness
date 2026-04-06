import { describe, expect, it } from "vitest";

import { contentToPromptMessage, toolResultContent } from "../packages/runtime-core/src/runtime-message-content";

describe("runtime message content normalization", () => {
  it("passes structured tool-result outputs through unchanged", () => {
    const promptMessage = contentToPromptMessage("tool", [
      {
        type: "tool-result",
        toolCallId: "call_bash",
        toolName: "Bash",
        output: {
          type: "text",
          value: "exit_code: 0\nstdout:\nhello"
        }
      }
    ]);

    expect(promptMessage).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_bash",
          toolName: "Bash",
          output: {
            type: "text",
            value: "exit_code: 0\nstdout:\nhello"
          }
        }
      ]
    });
  });

  it("stores tool results in AI SDK-compatible output format", () => {
    expect(
      toolResultContent({
        toolCallId: "call_bash",
        toolName: "Bash",
        output: "exit_code: 0\nstdout:\nhello"
      })
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_bash",
        toolName: "Bash",
        output: {
          type: "text",
          value: "exit_code: 0\nstdout:\nhello"
        }
      }
    ]);
  });
});
