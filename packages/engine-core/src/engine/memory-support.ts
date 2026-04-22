import type { Message } from "@oah/api-contracts";

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

export function trimMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/u);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

export function stringifyMessageContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return part.text;
        case "tool-call":
          return `tool-call ${part.toolName}: ${JSON.stringify(part.input)}`;
        case "tool-result": {
          switch (part.output.type) {
            case "text":
            case "error-text":
              return `tool-result ${part.toolName}: ${part.output.value}`;
            case "json":
            case "error-json":
              return `tool-result ${part.toolName}: ${JSON.stringify(part.output.value)}`;
            case "execution-denied":
              return `tool-result ${part.toolName}: ${part.output.reason ?? "Execution denied."}`;
            case "content":
              return `tool-result ${part.toolName}: ${JSON.stringify(part.output.value)}`;
          }
        }
        case "tool-approval-request":
          return `tool-approval-request ${part.toolCallId}`;
        case "tool-approval-response":
          return `tool-approval-response ${part.approvalId}: ${part.approved ? "approved" : "denied"}`;
        case "image":
          return "[image]";
        case "file":
          return `[file:${part.filename ?? "unnamed"}]`;
      }
    })
    .join("\n\n");
}

export function renderMessagesForMemory(messages: Message[]): string {
  return messages
    .map((message, index) => `#${index + 1} ${message.role}\n${stringifyMessageContent(message.content)}`.trim())
    .join("\n\n");
}

export function selectMessagesSinceId(messages: Message[], lastMessageId?: string): Message[] {
  if (!lastMessageId) {
    return messages;
  }

  const index = messages.findIndex((message) => message.id === lastMessageId);
  if (index < 0) {
    return messages;
  }

  return messages.slice(index + 1);
}
