import type { Message, Run, Session, SessionEventContract, WorkspaceRuntime } from "@oah/api-contracts";

import type {
  AskUserQuestionPrompt,
  AskUserQuestionSelection,
  ChatLine,
  VisibleWindow,
  WorkspaceCreateDialog,
  WorkspaceCreateField
} from "./types.js";

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

export function latestSessionRun(runs: Run[]): Run | undefined {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.endedAt ?? left.heartbeatAt ?? left.startedAt ?? left.createdAt);
    const rightTime = Date.parse(right.endedAt ?? right.heartbeatAt ?? right.startedAt ?? right.createdAt);
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return left.id.localeCompare(right.id);
    }
    if (Number.isNaN(leftTime)) {
      return 1;
    }
    if (Number.isNaN(rightTime)) {
      return -1;
    }
    return rightTime - leftTime;
  })[0];
}

export function formatSessionActivity(session: Session, run: Run | undefined): { label: string; tone: string; detail: string } {
  if (!run) {
    return {
      label: session.status,
      tone: STATUS_COLORS[session.status] ?? "white",
      detail: `updated ${formatTime(session.updatedAt)}`
    };
  }
  const runTime = run.endedAt ?? run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  switch (run.status) {
    case "queued":
      return { label: "queued", tone: STATUS_COLORS.queued ?? "yellow", detail: `queued ${formatTime(run.createdAt)}` };
    case "running":
      return { label: "running", tone: STATUS_COLORS.running ?? "cyan", detail: `started ${formatTime(run.startedAt ?? run.createdAt)}` };
    case "waiting_tool":
      return { label: "waiting tool", tone: STATUS_COLORS.waiting_tool ?? "magenta", detail: `waiting ${formatTime(run.heartbeatAt ?? runTime)}` };
    case "completed":
      return { label: "completed", tone: STATUS_COLORS.completed ?? "green", detail: `completed ${formatTime(run.endedAt ?? runTime)}` };
    case "failed":
      return { label: "failed", tone: STATUS_COLORS.failed ?? "red", detail: `failed ${formatTime(run.endedAt ?? runTime)}` };
    case "cancelled":
      return { label: "cancelled", tone: STATUS_COLORS.cancelled ?? "yellow", detail: `cancelled ${formatTime(run.endedAt ?? runTime)}` };
    case "timed_out":
      return { label: "timed out", tone: STATUS_COLORS.timed_out ?? "red", detail: `timed out ${formatTime(run.endedAt ?? runTime)}` };
    default:
      return { label: run.status, tone: STATUS_COLORS[run.status] ?? "white", detail: `updated ${formatTime(runTime)}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readAskUserQuestionPrompt(toolName: string, output: unknown): AskUserQuestionPrompt | undefined {
  if (toolName !== "AskUserQuestion" || !isRecord(output) || output.type !== "json" || !isRecord(output.value)) {
    return undefined;
  }
  if (output.value.status !== "awaiting_user" || !Array.isArray(output.value.questions)) {
    return undefined;
  }

  const questions = output.value.questions.flatMap((rawQuestion) => {
    if (!isRecord(rawQuestion)) {
      return [];
    }
    const question = readString(rawQuestion.question);
    if (!question) {
      return [];
    }
    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options.flatMap((rawOption) => {
          if (!isRecord(rawOption)) {
            return [];
          }
          const label = readString(rawOption.label);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: readString(rawOption.description)
            }
          ];
        })
      : undefined;
    return [
      {
        question,
        header: readString(rawQuestion.header),
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof rawQuestion.multiSelect === "boolean" ? { multiSelect: rawQuestion.multiSelect } : {}),
        ...(typeof rawQuestion.freeText === "boolean" ? { freeText: rawQuestion.freeText } : {})
      }
    ];
  });

  return questions.length > 0 ? { questions } : undefined;
}

function formatAskUserQuestionPrompt(prompt: AskUserQuestionPrompt) {
  const lines = ["User input needed"];
  prompt.questions.forEach((question, questionIndex) => {
    const prefix = prompt.questions.length > 1 ? `${questionIndex + 1}. ` : "";
    lines.push(`${prefix}${question.header ? `[${question.header}] ` : ""}${question.question}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`  ${optionIndex + 1}) ${option.label}${option.description ? ` - ${option.description}` : ""}`);
    });
    const hint = question.multiSelect ? "Enter option numbers separated by commas, or type a custom answer." : "Enter an option number, or type a custom answer.";
    lines.push(`  ${hint}`);
  });
  return lines.join("\n");
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readToolStatus(value: unknown): ChatLine["toolStatus"] | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "waiting" ||
    value === "started"
  ) {
    return value === "started" ? "running" : value;
  }
  return undefined;
}

function truncateSingleLine(value: string, limit = 96) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(1, limit - 1))}…` : normalized;
}

function jsonPreview(value: unknown, limit = 96) {
  try {
    return truncateSingleLine(typeof value === "string" ? value : JSON.stringify(value), limit);
  } catch {
    return truncateSingleLine(String(value), limit);
  }
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolInput(value: unknown) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncateSingleLine(value);
  }
  if (!isRecord(value)) {
    return jsonPreview(value);
  }

  for (const key of ["command", "cmd", "query", "path", "filePath", "filename", "url", "name"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) {
      return key === "command" || key === "cmd" ? `$ ${truncateSingleLine(field)}` : truncateSingleLine(field);
    }
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .slice(0, 3)
    .map(([key, entryValue]) => `${key}: ${jsonPreview(entryValue, 36)}`);
  return truncateSingleLine(entries.join(", "));
}

function readToolMetadata(metadata: unknown) {
  const record = isRecord(metadata) ? metadata : undefined;
  return {
    toolStatus: readToolStatus(record?.toolStatus),
    durationMs: readNumber(record?.toolDurationMs),
    sourceType: readString(record?.toolSourceType)
  };
}

function formatDuration(durationMs: number | undefined) {
  if (durationMs === undefined) {
    return "";
  }
  return durationMs < 1000 ? `${Math.max(0, Math.round(durationMs))} ms` : `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)} s`;
}

function toolOutputToText(output: unknown): { text: string; failed: boolean; denied: boolean } {
  if (!isRecord(output)) {
    return {
      text: typeof output === "string" ? output : prettyJson(output),
      failed: false,
      denied: false
    };
  }

  switch (output.type) {
    case "text":
      return { text: typeof output.value === "string" ? output.value : prettyJson(output.value), failed: false, denied: false };
    case "json":
      return { text: prettyJson(output.value), failed: false, denied: false };
    case "error-text":
      return { text: typeof output.value === "string" ? output.value : "Tool execution failed.", failed: true, denied: false };
    case "error-json":
      return { text: prettyJson(output.value), failed: true, denied: false };
    case "execution-denied":
      return {
        text: typeof output.reason === "string" ? output.reason : "Execution denied.",
        failed: true,
        denied: true
      };
    case "content":
      if (Array.isArray(output.value)) {
        return {
          text: output.value
            .map((item) => {
              if (!isRecord(item)) {
                return "";
              }
              if (item.type === "text" && typeof item.text === "string") {
                return item.text;
              }
              if (item.type === "file-data" || item.type === "file-url") {
                return `[file] ${readString(item.filename) ?? readString(item.url) ?? ""}`.trim();
              }
              if (item.type === "image-data" || item.type === "image-url") {
                return `[image] ${readString(item.url) ?? ""}`.trim();
              }
              return "";
            })
            .filter(Boolean)
            .join("\n"),
          failed: false,
          denied: false
        };
      }
      return { text: prettyJson(output.value), failed: false, denied: false };
    default:
      return { text: prettyJson(output), failed: false, denied: false };
  }
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
  return JSON.stringify(value) ?? String(value);
}

function makeLineId(messageId: string, index: number) {
  return index === 0 ? messageId : `${messageId}:part:${index}`;
}

export function messageToChatLines(message: Message): ChatLine[] {
  const metadata = "metadata" in message ? message.metadata : undefined;
  const toolMetadata = readToolMetadata(metadata);
  if (typeof message.content === "string") {
    return [
      {
        id: message.id,
        role: message.role,
        text: message.content,
        createdAt: message.createdAt,
        kind: message.role === "system" ? "system" : "message",
        tone: message.role === "system" ? "muted" : undefined
      }
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        id: message.id,
        role: message.role,
        text: stringifyMessageContent(message.content),
        createdAt: message.createdAt,
        kind: message.role === "system" ? "system" : "message",
        tone: message.role === "system" ? "muted" : undefined
      }
    ];
  }

  const lines: ChatLine[] = [];
  for (const [partIndex, part] of message.content.entries()) {
    if (part.type === "text" && part.text.trim().length > 0) {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.text,
        createdAt: message.createdAt,
        kind: "message"
      });
      continue;
    }
    if (part.type === "reasoning" && part.text.trim().length > 0) {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.text,
        title: "Thinking",
        createdAt: message.createdAt,
        kind: "reasoning",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-call") {
      const detail = summarizeToolInput(part.input);
      const status = toolMetadata.toolStatus ?? "running";
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: detail ? `${part.toolName} (${detail})` : part.toolName,
        title: part.toolName,
        detail,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        toolStatus: status,
        toolInput: part.input,
        durationMs: toolMetadata.durationMs,
        sourceType: toolMetadata.sourceType,
        createdAt: message.createdAt,
        kind: "tool",
        tone: status === "failed" ? "error" : "muted"
      });
      continue;
    }
    if (part.type === "tool-result") {
      const output = toolOutputToText(part.output);
      const status = output.denied ? "denied" : output.failed ? "failed" : (toolMetadata.toolStatus ?? "completed");
      const duration = formatDuration(toolMetadata.durationMs);
      const askUserQuestion = readAskUserQuestionPrompt(part.toolName, part.output);
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: askUserQuestion ? formatAskUserQuestionPrompt(askUserQuestion) : output.text,
        title: part.toolName,
        detail: duration,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        toolStatus: status,
        toolOutput: part.output,
        toolOutputText: askUserQuestion ? formatAskUserQuestionPrompt(askUserQuestion) : output.text,
        ...(askUserQuestion ? { askUserQuestion } : {}),
        durationMs: toolMetadata.durationMs,
        sourceType: toolMetadata.sourceType,
        createdAt: message.createdAt,
        kind: "tool",
        tone: status === "failed" || status === "denied" ? "error" : "muted"
      });
      continue;
    }
    if (part.type === "file") {
      const filename = part.filename ?? "file";
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: filename,
        title: `Read ${filename}`,
        detail: part.mediaType,
        createdAt: message.createdAt,
        kind: "attachment",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "image") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.mediaType ?? "image",
        title: "Attached image",
        detail: part.mediaType,
        createdAt: message.createdAt,
        kind: "attachment",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-approval-request") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: `Approval requested for ${part.toolCallId}`,
        title: "Approval requested",
        detail: part.toolCallId,
        toolCallId: part.toolCallId,
        toolStatus: "waiting",
        createdAt: message.createdAt,
        kind: "approval",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-approval-response") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: part.reason ?? (part.approved ? "Approved" : "Denied"),
        title: part.approved ? "Approved" : "Denied",
        detail: part.reason,
        toolStatus: part.approved ? "completed" : "denied",
        createdAt: message.createdAt,
        kind: "approval",
        tone: part.approved ? "muted" : "error"
      });
    }
    if (partIndex === message.content.length - 1 && lines.length === 0) {
      lines.push({
        id: message.id,
        role: message.role,
        text: stringifyMessageContent(message.content),
        createdAt: message.createdAt,
        kind: "message"
      });
    }
  }

  return lines.length > 0
    ? lines
    : [
        {
          id: message.id,
          role: message.role,
          text: stringifyMessageContent(message.content),
          createdAt: message.createdAt,
          kind: "message"
        }
      ];
}

export function messageToChatLine(message: Message): ChatLine {
  return messageToChatLines(message)[0] ?? {
    id: message.id,
    role: message.role,
    text: stringifyMessageContent(message.content),
    createdAt: message.createdAt,
    kind: "message"
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
  const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
  const errorMessage = typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined;
  const durationMs = typeof event.data.durationMs === "number" ? event.data.durationMs : undefined;
  const sourceType = typeof event.data.sourceType === "string" ? event.data.sourceType : undefined;
  switch (event.event) {
    case "tool.started":
      return {
        id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
        role: "tool",
        text: toolName ? `${toolName}${event.data.input !== undefined ? ` (${summarizeToolInput(event.data.input)})` : ""}` : "Using tool",
        title: toolName ?? "Tool",
        detail: event.data.input !== undefined ? summarizeToolInput(event.data.input) : "",
        toolName,
        toolCallId,
        toolStatus: "running",
        toolInput: event.data.input,
        sourceType,
        createdAt: event.createdAt,
        tone: "muted",
        kind: "tool"
      };
    case "tool.completed":
      {
        const output = toolOutputToText(event.data.output);
        const detail = formatDuration(durationMs);
        return {
          id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
          role: "tool",
          text: output.text || (toolName ? `Done ${toolName}` : "Tool completed"),
          title: toolName ?? "Tool",
          detail,
          toolName,
          toolCallId,
          toolStatus: output.failed ? "failed" : "completed",
          toolOutput: event.data.output,
          toolOutputText: output.text,
          durationMs,
          sourceType,
          createdAt: event.createdAt,
          tone: output.failed ? "error" : "muted",
          kind: "tool"
        };
      }
    case "tool.failed":
      return {
        id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
        role: "tool",
        text: errorMessage ?? (toolName ? `Failed ${toolName}` : "Tool failed"),
        title: toolName ?? "Tool failed",
        detail: formatDuration(durationMs),
        toolName,
        toolCallId,
        toolStatus: "failed",
        toolOutput: event.data.output,
        toolOutputText: errorMessage,
        durationMs,
        sourceType,
        createdAt: event.createdAt,
        tone: "error",
        kind: "tool"
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
        id: `run-error:${event.runId ?? event.id}`,
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
    if (!line) {
      return lines;
    }
    if (lines.some((item) => item.id === line.id)) {
      return lines.map((item) =>
        item.id === line.id
          ? {
              ...item,
              ...line,
              detail: line.detail || item.detail,
              text: line.text || item.text,
              title: line.title || item.title,
              toolInput: line.toolInput ?? item.toolInput,
              toolOutput: line.toolOutput ?? item.toolOutput,
              toolOutputText: line.toolOutputText ?? item.toolOutputText,
              createdAt: item.createdAt ?? line.createdAt
            }
          : item
      );
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
    const completed = messageToChatLines({
      id: messageId,
      sessionId: event.sessionId,
      ...(event.runId ? { runId: event.runId } : {}),
      role,
      content: event.data.content as Message["content"],
      ...(isRecord(event.data.metadata) ? { metadata: event.data.metadata } : {}),
      createdAt: event.createdAt
    } as Message);
    const cleaned = lines.filter((line) => line.id !== messageId && !line.id.startsWith(`${messageId}:part:`));
    return [...cleaned, ...completed].sort(compareChatLines);
  }

  return lines;
}

export function mergeRefreshedChatLines(current: ChatLine[], refreshed: ChatLine[]): ChatLine[] {
  if (current.length === 0) {
    return refreshed;
  }

  const refreshedById = new Map(refreshed.map((line) => [line.id, line] as const));
  const refreshedToolCallIds = new Set(refreshed.map((line) => line.toolCallId).filter((value): value is string => Boolean(value)));
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
    if (line.toolCallId && refreshedToolCallIds.has(line.toolCallId)) {
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

export function latestAskUserQuestionPrompt(lines: ChatLine[]): AskUserQuestionPrompt | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.role === "user") {
      return undefined;
    }
    if (line?.askUserQuestion) {
      return line.askUserQuestion;
    }
  }
  return undefined;
}

export function askUserQuestionPromptKey(prompt: AskUserQuestionPrompt) {
  return prompt.questions.map((question) => question.question).join("\n");
}

export function createAskUserQuestionSelection(prompt: AskUserQuestionPrompt): AskUserQuestionSelection {
  return {
    promptKey: askUserQuestionPromptKey(prompt),
    questionIndex: 0,
    optionIndex: 0,
    selectedByQuestion: {}
  };
}

export function isAskUserQuestionSelectionCurrent(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection | null | undefined) {
  return selection?.promptKey === askUserQuestionPromptKey(prompt);
}

export function moveAskUserQuestionSelection(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection, delta: number) {
  const question = prompt.questions[selection.questionIndex];
  const optionCount = Math.max(1, question?.options?.length ?? 1);
  return {
    ...selection,
    optionIndex: clampIndex(selection.optionIndex + delta, optionCount)
  };
}

export function moveAskUserQuestionQuestion(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection, delta: number) {
  const questionIndex = clampIndex(selection.questionIndex + delta, prompt.questions.length);
  const question = prompt.questions[questionIndex];
  const optionCount = Math.max(1, question?.options?.length ?? 1);
  return {
    ...selection,
    questionIndex,
    optionIndex: Math.min(selection.optionIndex, optionCount - 1)
  };
}

export function toggleAskUserQuestionSelection(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const question = prompt.questions[selection.questionIndex];
  const option = question?.options?.[selection.optionIndex];
  if (!question || !option) {
    return selection;
  }

  const current = selection.selectedByQuestion[selection.questionIndex] ?? [];
  const next = question.multiSelect
    ? current.includes(option.label)
      ? current.filter((item) => item !== option.label)
      : [...current, option.label]
    : [option.label];

  return {
    ...selection,
    selectedByQuestion: {
      ...selection.selectedByQuestion,
      [selection.questionIndex]: next
    }
  };
}

export function selectFocusedAskUserQuestionOption(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const question = prompt.questions[selection.questionIndex];
  if (question?.multiSelect) {
    return selection;
  }
  const option = question?.options?.[selection.optionIndex];
  if (!question || !option) {
    return selection;
  }
  return {
    ...selection,
    selectedByQuestion: {
      ...selection.selectedByQuestion,
      [selection.questionIndex]: [option.label]
    }
  };
}

export function formatAskUserQuestionSelectionAnswer(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const answers = prompt.questions.map((question, index) => {
    const selected = selection.selectedByQuestion[index] ?? [];
    return selected.length > 0 ? selected.join(", ") : "";
  });

  return `Answers to your questions:\n${prompt.questions
    .map((question, index) => `${index + 1}. ${question.question} ${answers[index]?.trim() || "(no answer)"}`)
    .join("\n")}`;
}

export function formatAskUserQuestionAnswer(prompt: AskUserQuestionPrompt, rawAnswer: string) {
  const trimmed = rawAnswer.trim();
  if (!trimmed) {
    return "";
  }

  if (prompt.questions.length === 1) {
    const question = prompt.questions[0]!;
    const selected = resolveAskUserQuestionSelection(question.options, trimmed, question.multiSelect === true);
    const answer = selected.length > 0 ? selected.join(", ") : trimmed;
    return `Answers to your questions:\n1. ${question.question} ${answer}`;
  }

  return `Answers to your questions:\n${trimmed}`;
}

function resolveAskUserQuestionSelection(options: { label: string }[] | undefined, rawAnswer: string, multiSelect: boolean) {
  if (!options || options.length === 0) {
    return [];
  }
  const parts = multiSelect ? rawAnswer.split(/[,\s]+/u) : [rawAnswer];
  const selected = parts
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= options.length)
    .map((value) => options[value - 1]?.label)
    .filter((value): value is string => typeof value === "string");
  return [...new Set(selected)];
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
