import type { ChatMessage, Message } from "@oah/api-contracts";

type MessageContent = Message["content"];
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];
type ToolCallMessagePart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultMessagePart = Extract<MessagePart, { type: "tool-result" }>;

function isTextMessagePart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

function isImageMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "image" && typeof value.image === "string";
}

function isFileMessagePart(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === "file" &&
    typeof value.data === "string" &&
    typeof value.mediaType === "string"
  );
}

function isReasoningMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "reasoning" && typeof value.text === "string";
}

function isToolCallMessagePart(value: unknown): value is ToolCallMessagePart {
  return (
    isJsonObject(value) &&
    value.type === "tool-call" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

function isToolResultMessagePart(value: unknown): value is ToolResultMessagePart {
  return (
    isJsonObject(value) &&
    value.type === "tool-result" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isStructuredToolResultOutput(value.output)
  );
}

function isToolApprovalRequestMessagePart(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === "tool-approval-request" &&
    typeof value.approvalId === "string" &&
    typeof value.toolCallId === "string"
  );
}

function isToolApprovalResponseMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "tool-approval-response" && typeof value.approvalId === "string" && typeof value.approved === "boolean";
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
        return isTextMessagePart(part as MessagePart);
      case "image":
        return isImageMessagePart(part);
      case "file":
        return isFileMessagePart(part);
      case "reasoning":
        return isReasoningMessagePart(part);
      case "tool-call":
        return isToolCallMessagePart(part);
      case "tool-result":
        return isToolResultMessagePart(part);
      case "tool-approval-request":
        return isToolApprovalRequestMessagePart(part);
      case "tool-approval-response":
        return isToolApprovalResponseMessagePart(part);
      default:
        return false;
    }
  });
}

export function isMessageContentForRole(role: Message["role"], content: unknown): content is MessageContent {
  if (role === "system") {
    return typeof content === "string";
  }

  if (role === "user") {
    if (typeof content === "string") {
      return true;
    }

    return (
      Array.isArray(content) &&
      content.every((part) => isTextMessagePart(part as MessagePart) || isImageMessagePart(part) || isFileMessagePart(part))
    );
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      return true;
    }

    return (
      Array.isArray(content) &&
      content.every(
        (part) =>
          isTextMessagePart(part as MessagePart) ||
          isFileMessagePart(part) ||
          isReasoningMessagePart(part) ||
          isToolCallMessagePart(part) ||
          isToolResultMessagePart(part) ||
          isToolApprovalRequestMessagePart(part)
      )
    );
  }

  return (
    Array.isArray(content) && content.every((part) => isToolResultMessagePart(part) || isToolApprovalResponseMessagePart(part))
  );
}

export function textContent(text: string): MessageContent {
  return text;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextToolResultOutput(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && value.type === "text" && typeof value.value === "string";
}

function isJsonToolResultOutput(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && value.type === "json" && "value" in value;
}

function isExecutionDeniedToolResultOutput(value: unknown): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    value.type === "execution-denied" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isErrorTextToolResultOutput(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && value.type === "error-text" && typeof value.value === "string";
}

function isErrorJsonToolResultOutput(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && value.type === "error-json" && "value" in value;
}

function isContentToolResultOutput(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && value.type === "content" && Array.isArray(value.value);
}

export function isStructuredToolResultOutput(value: unknown): value is Record<string, unknown> {
  return (
    isTextToolResultOutput(value) ||
    isJsonToolResultOutput(value) ||
    isExecutionDeniedToolResultOutput(value) ||
    isErrorTextToolResultOutput(value) ||
    isErrorJsonToolResultOutput(value) ||
    isContentToolResultOutput(value)
  );
}

export function normalizeToolResultOutput(output: unknown): Record<string, unknown> {
  if (isStructuredToolResultOutput(output)) {
    return output;
  }

  if (typeof output === "string") {
    return {
      type: "text",
      value: output
    };
  }

  return {
    type: "json",
    value:
      isJsonObject(output) || Array.isArray(output) || typeof output === "number" || typeof output === "boolean" || output === null
        ? output
        : output ?? null
  };
}

export function toolCallContent(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): MessageContent {
  return toolCalls.map((toolCall) => ({
    type: "tool-call" as const,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input ?? null
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
      ...(toolResult.output !== undefined ? { output: normalizeToolResultOutput(toolResult.output) } : {})
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
