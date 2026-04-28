import type { Message, Run, SessionEventContract, WorkspaceRuntime } from "@oah/api-contracts";

import type { ChatLine, VisibleWindow, WorkspaceCreateDialog, WorkspaceCreateField } from "./types.js";

export const STATUS_COLORS: Record<string, string> = {
  active: "green",
  archived: "yellow",
  closed: "yellow",
  disabled: "red",
  queued: "yellow",
  running: "cyan",
  waiting_tool: "magenta",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
  timed_out: "red"
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SLASH_COMMANDS = [
  { command: "/help", description: "Show shortcuts" },
  { command: "/clear", description: "Clear the current transcript view" },
  { command: "/workspace", description: "Switch workspace" },
  { command: "/session", description: "Switch session in current workspace" },
  { command: "/new-workspace", description: "Create workspace" },
  { command: "/new-session", description: "Create session" },
  { command: "/quit", description: "Exit OAH" }
] as const;

export function getSlashCommandMatches(value: string) {
  if (!value.startsWith("/") || value.includes(" ")) {
    return [];
  }
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(value));
}

const WORKSPACE_CREATE_FIELDS: WorkspaceCreateField[] = ["name", "runtime", "rootPath", "ownerId", "serviceName"];

export function insertTextAt(value: string, cursor: number, input: string) {
  return `${value.slice(0, cursor)}${input}${value.slice(cursor)}`;
}

export function clampIndex(index: number, length: number) {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

export function visibleWindow<T>(items: T[], selectedIndex: number, limit: number): VisibleWindow<T> {
  if (items.length <= limit) {
    return { items, offset: 0 };
  }
  const half = Math.floor(limit / 2);
  const offset = Math.max(0, Math.min(selectedIndex - half, items.length - limit));
  return {
    items: items.slice(offset, offset + limit),
    offset
  };
}

export function getRuntimeMatches(runtimes: WorkspaceRuntime[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return runtimes;
  }
  return runtimes
    .filter((runtime) => runtime.name.toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(needle);
      const rightStarts = right.name.toLowerCase().startsWith(needle);
      if (leftStarts === rightStarts) {
        return left.name.localeCompare(right.name);
      }
      return leftStarts ? -1 : 1;
    });
}

export function shortId(id: string | undefined) {
  if (!id) {
    return "-";
  }
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatTime(value: string | undefined) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringifyMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (isRecord(part)) {
          if (part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (part.type === "reasoning") {
            return "";
          }
          if (part.type === "tool-call" && typeof part.toolName === "string") {
            return `[tool-call] ${part.toolName}`;
          }
          if (part.type === "tool-result" && typeof part.toolName === "string") {
            return `[tool-result] ${part.toolName}`;
          }
          if (part.type === "file" && typeof part.filename === "string") {
            return `[file] ${part.filename}`;
          }
          if (part.type === "image") {
            return "[image]";
          }
          if (part.type === "tool-approval-request" && typeof part.toolCallId === "string") {
            return `[approval] ${part.toolCallId}`;
          }
        }
        return JSON.stringify(part);
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  return JSON.stringify(value);
}

export function messageToChatLine(message: Message): ChatLine {
  return {
    id: message.id,
    role: message.role,
    text: stringifyMessageContent(message.content),
    createdAt: message.createdAt
  };
}

export function runFailureToChatLine(run: Run): ChatLine | null {
  if (run.status !== "failed" && run.status !== "timed_out") {
    return null;
  }
  return {
    id: `run-error:${run.id}`,
    role: "system",
    text: run.errorMessage ?? (run.status === "timed_out" ? "Run timed out" : "Run failed"),
    createdAt: run.endedAt ?? run.createdAt,
    tone: "error"
  };
}

function eventChatLine(event: SessionEventContract): ChatLine | null {
  const toolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;
  const errorMessage = typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined;
  switch (event.event) {
    case "tool.started":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: toolName ? `Using ${toolName}` : "Using tool",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "tool.completed":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: toolName ? `Done ${toolName}` : "Tool completed",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "tool.failed":
      return {
        id: `event:${event.id}`,
        role: "tool",
        text: errorMessage ?? (toolName ? `Failed ${toolName}` : "Tool failed"),
        createdAt: event.createdAt,
        tone: "error"
      };
    case "agent.switched":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: typeof event.data.toAgent === "string" ? `Switched to ${event.data.toAgent}` : "Agent switched",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "run.failed":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: errorMessage ?? "Run failed",
        createdAt: event.createdAt,
        tone: "error"
      };
    case "run.cancelled":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: "Run cancelled",
        createdAt: event.createdAt,
        tone: "muted"
      };
    default:
      return null;
  }
}

export function updateChatLinesFromEvent(lines: ChatLine[], event: SessionEventContract): ChatLine[] {
  const messageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
  if (!messageId) {
    const line = eventChatLine(event);
    if (!line || lines.some((item) => item.id === line.id)) {
      return lines;
    }
    return [...lines, line];
  }

  if (event.event === "message.delta") {
    const nextText =
      event.data.content !== undefined
        ? stringifyMessageContent(event.data.content)
        : typeof event.data.delta === "string"
          ? event.data.delta
          : "";
    if (!nextText) {
      return lines;
    }
    const existing = lines.find((line) => line.id === messageId);
    if (!existing) {
      return [
        ...lines,
        {
          id: messageId,
          role: "assistant",
          text: nextText,
          createdAt: event.createdAt
        }
      ];
    }
    return lines.map((line) =>
      line.id === messageId
        ? {
            ...line,
            text: event.data.content !== undefined ? nextText : `${line.text}${nextText}`
          }
        : line
    );
  }

  if (event.event === "message.completed" && event.data.content !== undefined) {
    const role = typeof event.data.role === "string" ? event.data.role : "assistant";
    const completed: ChatLine = {
      id: messageId,
      role,
      text: stringifyMessageContent(event.data.content),
      createdAt: event.createdAt
    };
    return lines.some((line) => line.id === messageId)
      ? lines.map((line) => (line.id === messageId ? completed : line))
      : [...lines, completed];
  }

  return lines;
}

export function mergeRefreshedChatLines(current: ChatLine[], refreshed: ChatLine[]): ChatLine[] {
  if (current.length === 0) {
    return refreshed;
  }

  const refreshedById = new Map(refreshed.map((line) => [line.id, line] as const));
  const refreshedUserTexts = new Set(
    refreshed.filter((line) => line.role === "user").map((line) => line.text.trim()).filter(Boolean)
  );
  const merged = refreshed.map((line) => {
    const existing = current.find((item) => item.id === line.id);
    if (!existing || existing.role !== "assistant" || line.role !== "assistant") {
      return line;
    }
    return existing.text.length > line.text.length ? { ...line, text: existing.text } : line;
  });

  for (const line of current) {
    if (refreshedById.has(line.id)) {
      continue;
    }
    if (line.id.startsWith("pending:") && refreshedUserTexts.has(line.text.trim())) {
      continue;
    }
    if (line.id.startsWith("event:") || line.id.startsWith("pending:")) {
      merged.push(line);
      continue;
    }
    if (line.role === "assistant" && line.text.trim().length > 0) {
      merged.push(line);
    }
  }

  return merged.sort(compareChatLines);
}

function compareChatLines(left: ChatLine, right: ChatLine) {
  const leftTime = Date.parse(left.createdAt ?? "");
  const rightTime = Date.parse(right.createdAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

export function isReturnInput(input: string, key: { return?: boolean }) {
  return key.return === true || /[\r\n]/u.test(input);
}

export function cleanSingleLineInput(input: string) {
  return input.replace(/[\r\n]/gu, "");
}

export function cleanControlInput(input: string) {
  return cleanSingleLineInput(input).replace(/[\u0000-\u001f\u007f]/gu, "");
}

export function hasRawControl(input: string, code: string) {
  return input.includes(code);
}

export function createWorkspaceDialog(defaultRuntime: string | undefined, runtimes: WorkspaceRuntime[] = []): WorkspaceCreateDialog {
  const runtime = defaultRuntime ?? "";
  const runtimeSelectedIndex = Math.max(
    0,
    runtimes.findIndex((item) => item.name === runtime)
  );
  return {
    kind: "workspace-create",
    field: "name",
    name: "",
    runtime,
    runtimeQuery: "",
    runtimeSelectedIndex,
    rootPath: "",
    ownerId: "",
    serviceName: ""
  };
}

export function moveWorkspaceCreateField(field: WorkspaceCreateField, delta: number) {
  const index = WORKSPACE_CREATE_FIELDS.indexOf(field);
  return WORKSPACE_CREATE_FIELDS[(index + delta + WORKSPACE_CREATE_FIELDS.length) % WORKSPACE_CREATE_FIELDS.length] ?? field;
}

export function cycleRuntime(currentRuntime: string, runtimes: WorkspaceRuntime[], delta: number) {
  if (runtimes.length === 0) {
    return currentRuntime;
  }
  const currentIndex = Math.max(0, runtimes.findIndex((runtime) => runtime.name === currentRuntime));
  return runtimes[(currentIndex + delta + runtimes.length) % runtimes.length]?.name ?? currentRuntime;
}
