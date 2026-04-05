import type { ChatMessage, Message } from "@oah/api-contracts";

type MessageContent = Message["content"];
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];

function isTextMessagePart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

export function isMessageRole(value: unknown): value is Message["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function isMessagePartList(value: unknown): value is MessagePart[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((part) => {
    if (typeof part !== "object" || part === null || typeof (part as { type?: unknown }).type !== "string") {
      return false;
    }

    switch ((part as { type: string }).type) {
      case "text":
        return typeof (part as { text?: unknown }).text === "string";
      case "tool-call":
        return (
          typeof (part as { toolCallId?: unknown }).toolCallId === "string" &&
          typeof (part as { toolName?: unknown }).toolName === "string"
        );
      case "tool-result":
        return (
          typeof (part as { toolCallId?: unknown }).toolCallId === "string" &&
          typeof (part as { toolName?: unknown }).toolName === "string"
        );
      default:
        return false;
    }
  });
}

export function textContent(text: string): MessageContent {
  return text;
}

export function toolCallContent(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): MessageContent {
  return toolCalls.map((toolCall) => ({
    type: "tool-call" as const,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    ...(toolCall.input !== undefined ? { input: toolCall.input } : {})
  }));
}

export function toolResultContent(toolResult: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): MessageContent {
  return [
    {
      type: "tool-result" as const,
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      ...(toolResult.output !== undefined ? { output: toolResult.output } : {})
    }
  ];
}

export function extractTextFromContent(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(isTextMessagePart)
    .map((part) => part.text)
    .join("\n\n");
}

export function contentToPromptMessage(role: Message["role"], content: MessageContent): ChatMessage {
  return {
    role,
    content
  };
}
