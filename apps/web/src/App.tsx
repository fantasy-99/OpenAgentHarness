import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  CircleSlash2,
  Database,
  Download,
  Folder,
  FolderPlus,
  Network,
  Orbit,
  RefreshCw,
  Send,
  Sparkles,
  Trash2
} from "lucide-react";

import type {
  Message,
  MessageAccepted,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  SessionEventContract,
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage,
  Workspace,
  WorkspaceHistoryMirrorStatus,
  WorkspaceCatalog,
  WorkspaceTemplateList
} from "@oah/api-contracts";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

interface WorkspaceDraft {
  name: string;
  template: string;
  rootPath: string;
}

interface SavedWorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  template?: string;
  status: Workspace["status"];
  createdAt?: string;
  lastOpenedAt: string;
}

interface SavedSessionRecord {
  id: string;
  workspaceId: string;
  title?: string;
  agentName?: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface SessionDraft {
  title: string;
  agentName: string;
}

interface ModelDraft {
  model: string;
  prompt: string;
}

interface ModelProviderRecord {
  id: "openai" | "openai-compatible";
  packageName: string;
  description: string;
  requiresUrl: boolean;
  useCases: string[];
}

interface SseFrame {
  cursor?: string;
  event: string;
  data: Record<string, unknown>;
}

interface HealthReportResponse {
  status: "ok" | "degraded";
  storage: {
    primary: "postgres" | "memory";
    events: "redis" | "memory";
    runQueue: "redis" | "in_process";
  };
  process: {
    mode: "api_embedded_worker" | "api_only" | "standalone_worker";
    label: "API + embedded worker" | "API only" | "standalone worker";
    execution: "redis_queue" | "local_inline" | "none";
  };
  checks: {
    postgres: "up" | "down" | "not_configured";
    redisEvents: "up" | "down" | "not_configured";
    redisRunQueue: "up" | "down" | "not_configured";
    historyMirror: "up" | "degraded" | "not_configured";
  };
  worker: {
    mode: "embedded" | "external" | "disabled";
  };
  mirror: {
    worker: "running" | "disabled";
    enabledWorkspaces: number;
    idleWorkspaces: number;
    missingWorkspaces: number;
    errorWorkspaces: number;
  };
}

interface ReadinessReportResponse {
  status: "ready" | "not_ready";
  checks: {
    postgres: "up" | "down" | "not_configured";
    redisEvents: "up" | "down" | "not_configured";
    redisRunQueue: "up" | "down" | "not_configured";
  };
}

interface ModelProviderListResponse {
  items: ModelProviderRecord[];
}

type InspectorTab = "overview" | "context" | "calls" | "runtime" | "catalog" | "model";
type MainViewMode = "conversation" | "inspector";
type SurfaceMode = "runtime" | "storage";
type StorageBrowserTab = "postgres" | "redis";
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];

interface ModelCallTraceMessage {
  role: Message["role"];
  content: Message["content"];
}

interface ModelCallTraceToolCall {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

interface ModelCallTraceToolResult {
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
}

interface ModelCallTraceToolServer {
  name: string;
  transportType?: string;
  toolPrefix?: string;
  timeout?: number;
  include?: string[];
  exclude?: string[];
}

interface ModelCallTraceRuntimeTool {
  name: string;
  description?: string;
  retryPolicy?: string;
  inputSchema?: unknown;
}

interface ModelCallTraceInput {
  model?: string;
  canonicalModelRef?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  messageCount?: number;
  activeToolNames: string[];
  runtimeToolNames: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  toolServers: ModelCallTraceToolServer[];
  messages: ModelCallTraceMessage[];
}

interface ModelCallTraceOutput {
  stepType?: string;
  text?: string;
  content?: unknown[];
  usage?: Record<string, unknown>;
  warnings?: unknown[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  finishReason?: string;
  toolCallsCount?: number;
  toolResultsCount?: number;
  toolCalls: ModelCallTraceToolCall[];
  toolResults: ModelCallTraceToolResult[];
  errorMessage?: string;
}

interface ModelCallTrace {
  id: string;
  seq: number;
  name?: string;
  agentName?: string;
  status: RunStep["status"];
  startedAt?: string;
  endedAt?: string;
  input: ModelCallTraceInput;
  output: ModelCallTraceOutput;
  rawInput: unknown;
  rawOutput: unknown;
}

const storagePostgresTables: StoragePostgresTableName[] = [
  "workspaces",
  "sessions",
  "runs",
  "messages",
  "run_steps",
  "session_events",
  "tool_calls",
  "hook_runs",
  "artifacts",
  "history_events"
];

function storageTablePreviewLimit(table: StoragePostgresTableName) {
  switch (table) {
    case "session_events":
    case "run_steps":
      return 20;
    case "messages":
    case "tool_calls":
    case "hook_runs":
      return 25;
    default:
      return 50;
  }
}

const storageKeys = {
  connection: "oah.web.connection",
  workspaceDraft: "oah.web.workspaceDraft",
  sessionDraft: "oah.web.sessionDraft",
  modelDraft: "oah.web.modelDraft",
  workspaceId: "oah.web.workspaceId",
  sessionId: "oah.web.sessionId",
  savedWorkspaces: "oah.web.savedWorkspaces",
  savedSessions: "oah.web.savedSessions",
  recentWorkspaces: "oah.web.recentWorkspaces",
  recentSessions: "oah.web.recentSessions"
} as const;

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return initialValue;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function normalizeBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/u, "");
}

function buildUrl(baseUrl: string, path: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}${path}` : path;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isNotFoundError(error: unknown) {
  const message = toErrorMessage(error);
  return message.startsWith("404 ") || message.toLowerCase().includes("not found");
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function downloadJsonFile(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadCsvFile(filename: string, columns: string[], rows: Array<Record<string, unknown>>) {
  const escapeCsv = (value: unknown) => {
    const text =
      typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
    return `"${text.replaceAll('"', '""')}"`;
  };

  const csv = [columns.map(escapeCsv).join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\n");
  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function isMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "tool-call":
      return typeof value.toolCallId === "string" && typeof value.toolName === "string";
    case "tool-result":
      return typeof value.toolCallId === "string" && typeof value.toolName === "string";
    default:
      return false;
  }
}

function normalizeMessageContent(value: unknown): Message["content"] | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => isMessagePart(entry))) {
    return value;
  }

  return null;
}

function contentParts(content: Message["content"]): MessagePart[] {
  return Array.isArray(content) ? content : [];
}

function contentText(content: Message["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function contentToolRefs(content: Message["content"]) {
  return contentParts(content).flatMap((part) => {
    if (part.type === "tool-call" || part.type === "tool-result") {
      return [
        {
          type: part.type,
          toolName: part.toolName,
          toolCallId: part.toolCallId
        }
      ];
    }

    return [];
  });
}

function contentPreview(content: Message["content"], limit = 120) {
  const text = contentText(content).trim();
  if (text.length > 0) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  const refs = contentToolRefs(content);
  if (refs.length > 0) {
    return refs
      .map((ref) => `${ref.type}:${ref.toolName}`)
      .join(" · ");
  }

  return prettyJson(content);
}

function storageMessageFromRow(row: Record<string, unknown>): Message | null {
  const role = row.role;
  const content = normalizeMessageContent(row.content);
  const id = row.id;
  const sessionId = row.session_id;
  const createdAt = row.created_at;
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof createdAt !== "string" ||
    !["system", "user", "assistant", "tool"].includes(String(role)) ||
    content === null
  ) {
    return null;
  }

  return {
    id,
    sessionId,
    role: role as Message["role"],
    content,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {}),
    createdAt
  };
}

function storageRunStepFromRow(row: Record<string, unknown>): RunStep | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.seq !== "number" ||
    typeof row.step_type !== "string" ||
    typeof row.status !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    stepType: row.step_type as RunStep["stepType"],
    status: row.status as RunStep["status"],
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.agent_name === "string" ? { agentName: row.agent_name } : {}),
    ...("input" in row ? { input: row.input } : {}),
    ...("output" in row ? { output: row.output } : {}),
    ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
    ...(typeof row.ended_at === "string" ? { endedAt: row.ended_at } : {})
  };
}

function storageSessionEventFromRow(row: Record<string, unknown>): SessionEventContract | null {
  if (
    typeof row.id !== "string" ||
    typeof row.cursor !== "number" ||
    typeof row.session_id !== "string" ||
    typeof row.event !== "string" ||
    !isRecord(row.data) ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    cursor: String(row.cursor),
    sessionId: row.session_id,
    event: row.event as SessionEventContract["event"],
    data: row.data,
    createdAt: row.created_at,
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {})
  };
}

interface StorageToolCallRecord {
  id: string;
  runId: string;
  stepId?: string;
  sourceType: string;
  toolName: string;
  request?: unknown;
  response?: unknown;
  status: string;
  durationMs?: number;
  startedAt: string;
  endedAt: string;
}

function storageToolCallFromRow(row: Record<string, unknown>): StorageToolCallRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.source_type !== "string" ||
    typeof row.tool_name !== "string" ||
    typeof row.status !== "string" ||
    typeof row.started_at !== "string" ||
    typeof row.ended_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    sourceType: row.source_type,
    toolName: row.tool_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(typeof row.step_id === "string" ? { stepId: row.step_id } : {}),
    ...("request" in row ? { request: row.request } : {}),
    ...("response" in row ? { response: row.response } : {}),
    ...(typeof row.duration_ms === "number" ? { durationMs: row.duration_ms } : {})
  };
}

function readModelCallTraceMessages(value: unknown): ModelCallTraceMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const role = entry.role;
    const content = normalizeMessageContent(entry.content);
    if (!["system", "user", "assistant", "tool"].includes(String(role)) || content === null) {
      return [];
    }

    return [
      {
        role: role as Message["role"],
        content
      }
    ];
  });
}

function readModelCallTraceToolServers(value: unknown): ModelCallTraceToolServer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.transportType === "string" ? { transportType: entry.transportType } : {}),
        ...(typeof entry.toolPrefix === "string" ? { toolPrefix: entry.toolPrefix } : {}),
        ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
        ...(Array.isArray(entry.include) ? { include: readStringArray(entry.include) } : {}),
        ...(Array.isArray(entry.exclude) ? { exclude: readStringArray(entry.exclude) } : {})
      }
    ];
  });
}

function readModelCallTraceRuntimeTools(value: unknown): ModelCallTraceRuntimeTool[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.retryPolicy === "string" ? { retryPolicy: entry.retryPolicy } : {}),
        ...("inputSchema" in entry ? { inputSchema: entry.inputSchema } : {})
      }
    ];
  });
}

function readModelCallTraceToolCalls(value: unknown): ModelCallTraceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("input" in entry ? { input: entry.input } : {})
      }
    ];
  });
}

function readModelCallTraceToolResults(value: unknown): ModelCallTraceToolResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...("output" in entry ? { output: entry.output } : {})
      }
    ];
  });
}

function toModelCallTrace(step: RunStep): ModelCallTrace | null {
  if (step.stepType !== "model_call") {
    return null;
  }

  const input = isRecord(step.input) ? step.input : {};
  const output = isRecord(step.output) ? step.output : {};

  return {
    id: step.id,
    seq: step.seq,
    ...(step.name ? { name: step.name } : {}),
    ...(step.agentName ? { agentName: step.agentName } : {}),
    status: step.status,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    input: {
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.canonicalModelRef === "string" ? { canonicalModelRef: input.canonicalModelRef } : {}),
      ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { maxTokens: input.maxTokens } : {}),
      ...(typeof input.messageCount === "number" ? { messageCount: input.messageCount } : {}),
      activeToolNames: readStringArray(input.activeToolNames),
      runtimeToolNames: readStringArray(input.runtimeToolNames),
      runtimeTools: readModelCallTraceRuntimeTools(input.runtimeTools),
      toolServers: readModelCallTraceToolServers(input.toolServers),
      messages: readModelCallTraceMessages(input.messages)
    },
    output: {
      ...(typeof output.stepType === "string" ? { stepType: output.stepType } : {}),
      ...(typeof output.text === "string" ? { text: output.text } : {}),
      ...(Array.isArray(output.content) ? { content: output.content } : {}),
      ...(isRecord(output.usage) ? { usage: output.usage } : {}),
      ...(Array.isArray(output.warnings) ? { warnings: output.warnings } : {}),
      ...(isRecord(output.request) ? { request: output.request } : {}),
      ...(isRecord(output.response) ? { response: output.response } : {}),
      ...(isRecord(output.providerMetadata) ? { providerMetadata: output.providerMetadata } : {}),
      ...(typeof output.finishReason === "string" ? { finishReason: output.finishReason } : {}),
      ...(typeof output.toolCallsCount === "number" ? { toolCallsCount: output.toolCallsCount } : {}),
      ...(typeof output.toolResultsCount === "number" ? { toolResultsCount: output.toolResultsCount } : {}),
      ...(typeof output.errorMessage === "string" ? { errorMessage: output.errorMessage } : {}),
      toolCalls: readModelCallTraceToolCalls(output.toolCalls),
      toolResults: readModelCallTraceToolResults(output.toolResults)
    },
    rawInput: step.input,
    rawOutput: step.output
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function countMessagesByRole(messages: Array<{ role: Message["role"] }>) {
  return {
    system: messages.filter((message) => message.role === "system").length,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    tool: messages.filter((message) => message.role === "tool").length
  };
}

function upsertSessionMessage(current: Message[], incoming: Message) {
  const existingIndex = current.findIndex((message) => message.id === incoming.id);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = incoming;
    return next;
  }

  return [...current, incoming].sort((left, right) => {
    const leftValue = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
    const rightValue = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
    const timestampComparison =
      Number.isFinite(leftValue) && Number.isFinite(rightValue) ? leftValue - rightValue : 0;
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return left.id.localeCompare(right.id);
  });
}

function inferCompletedMessageRole(data: Record<string, unknown>): Message["role"] {
  return typeof data.toolName === "string" && typeof data.toolCallId === "string" ? "tool" : "assistant";
}

function addRecentId(list: string[], id: string) {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, 8);
}

function compareIsoTimestampDesc(left?: string, right?: string) {
  const leftValue = left ? Date.parse(left) : Number.NaN;
  const rightValue = right ? Date.parse(right) : Number.NaN;

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return rightValue - leftValue;
  }

  if (Number.isFinite(leftValue)) {
    return -1;
  }

  if (Number.isFinite(rightValue)) {
    return 1;
  }

  return 0;
}

function isTerminalRunEvent(event: string) {
  return event === "run.completed" || event === "run.failed" || event === "run.cancelled";
}

function isTerminalRunStatus(status?: Run["status"] | null) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "running":
    case "waiting_tool":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "queued":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "cancelled":
      return "border-slate-200 bg-slate-100 text-slate-600";
    case "failed":
    case "timed_out":
      return "border-rose-200 bg-rose-50 text-rose-700";
    default:
      return "";
  }
}

function probeTone(status: string): "sky" | "emerald" | "rose" | "amber" {
  switch (status) {
    case "ok":
    case "ready":
    case "up":
      return "emerald";
    case "degraded":
    case "not_configured":
    case "checking":
    case "idle":
      return "amber";
    case "error":
    case "not_ready":
    case "down":
      return "rose";
    default:
      return "sky";
  }
}

async function consumeSse(
  response: Response,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response body is not readable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let cursor: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("id:")) {
          cursor = line.slice(3).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      onFrame({
        event,
        data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
        ...(cursor ? { cursor } : {})
      });
    }
  }
}

export function App() {
  const [connection, setConnection] = usePersistentState<ConnectionSettings>(storageKeys.connection, {
    baseUrl: "",
    token: ""
  });
  const [workspaceDraft, setWorkspaceDraft] = usePersistentState<WorkspaceDraft>(storageKeys.workspaceDraft, {
    name: "debug-playground",
    template: "workspace",
    rootPath: ""
  });
  const [sessionDraft, setSessionDraft] = usePersistentState<SessionDraft>(storageKeys.sessionDraft, {
    title: "",
    agentName: ""
  });
  const [modelDraft, setModelDraft] = usePersistentState<ModelDraft>(storageKeys.modelDraft, {
    model: "",
    prompt: "你好，请简短回复一句话，确认模型链路已经接通。"
  });
  const [workspaceId, setWorkspaceId] = usePersistentState(storageKeys.workspaceId, "");
  const [sessionId, setSessionId] = usePersistentState(storageKeys.sessionId, "");
  const [savedWorkspaces, setSavedWorkspaces] = usePersistentState<SavedWorkspaceRecord[]>(storageKeys.savedWorkspaces, []);
  const [savedSessions, setSavedSessions] = usePersistentState<SavedSessionRecord[]>(storageKeys.savedSessions, []);
  const [recentWorkspaces, setRecentWorkspaces] = usePersistentState<string[]>(storageKeys.recentWorkspaces, []);
  const [recentSessions, setRecentSessions] = usePersistentState<string[]>(storageKeys.recentSessions, []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<WorkspaceHistoryMirrorStatus | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SessionEventContract[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [draftMessage, setDraftMessage] = useState("你好，帮我简单确认一下当前 session 和 run 是否正常工作。");
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [healthStatus, setHealthStatus] = useState("idle");
  const [healthReport, setHealthReport] = useState<HealthReportResponse | null>(null);
  const [readinessReport, setReadinessReport] = useState<ReadinessReportResponse | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderRecord[]>([]);
  const [storageOverview, setStorageOverview] = useState<StorageOverview | null>(null);
  const [selectedStorageTable, setSelectedStorageTable] = useState<StoragePostgresTableName>("runs");
  const [storageTablePage, setStorageTablePage] = useState<StoragePostgresTablePage | null>(null);
  const [storageTableOffset, setStorageTableOffset] = useState(0);
  const [selectedStorageRow, setSelectedStorageRow] = useState<Record<string, unknown> | null>(null);
  const [storageTableSearch, setStorageTableSearch] = useState("");
  const [storageTableWorkspaceId, setStorageTableWorkspaceId] = useState("");
  const [storageTableSessionId, setStorageTableSessionId] = useState("");
  const [storageTableRunId, setStorageTableRunId] = useState("");
  const [redisKeyPattern, setRedisKeyPattern] = useState("oah:*");
  const [redisKeyPage, setRedisKeyPage] = useState<StorageRedisKeyPage | null>(null);
  const [selectedRedisKey, setSelectedRedisKey] = useState("");
  const [selectedRedisKeys, setSelectedRedisKeys] = useState<string[]>([]);
  const [redisKeyDetail, setRedisKeyDetail] = useState<StorageRedisKeyDetail | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "listening" | "open" | "error">("idle");
  const [activity, setActivity] = useState("等待连接");
  const [errorMessage, setErrorMessage] = useState("");
  const [generateOutput, setGenerateOutput] = useState<ModelGenerateResponse | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [autoStream, setAutoStream] = useState(true);
  const [filterSelectedRun, setFilterSelectedRun] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const [sidebarMode, setSidebarMode] = useState<"workspaces" | "sessions">("workspaces");
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("runtime");
  const [storageBrowserTab, setStorageBrowserTab] = useState<StorageBrowserTab>("postgres");
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("conversation");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedStepId, setSelectedStepId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [runtimeInspectorMode, setRuntimeInspectorMode] = useState<"steps" | "events">("steps");
  const [showSessionCreator, setShowSessionCreator] = useState(false);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [mirrorToggleBusy, setMirrorToggleBusy] = useState(false);
  const [mirrorRebuildBusy, setMirrorRebuildBusy] = useState(false);
  const [workspaceManagementEnabled, setWorkspaceManagementEnabled] = useState(true);

  const deferredEvents = useDeferredValue(events);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastCursorRef = useRef<string | undefined>(undefined);
  const messageRefreshTimerRef = useRef<number | undefined>(undefined);
  const runRefreshTimerRef = useRef<number | undefined>(undefined);
  const runPollingTimerRef = useRef<number | undefined>(undefined);
  const conversationThreadRef = useRef<HTMLDivElement | null>(null);
  const conversationTailRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowConversationRef = useRef(true);
  const activeWorkspaceSessions = [...savedSessions]
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => {
      const timestampComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
      if (timestampComparison !== 0) {
        return timestampComparison;
      }

      return right.id.localeCompare(left.id);
    });
  const orderedSavedWorkspaces = [...savedWorkspaces].sort((left, right) => {
    const timestampComparison = compareIsoTimestampDesc(left.createdAt, right.createdAt);
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return right.id.localeCompare(left.id);
  });
  const selectedRunIdValue = selectedRunId.trim();
  const streamRunId = filterSelectedRun ? selectedRunIdValue : "";
  const modelCallTraces = runSteps.map(toModelCallTrace).filter((trace): trace is ModelCallTrace => trace !== null);
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const selectedModelCallTrace = modelCallTraces.find((trace) => trace.id === selectedTraceId) ?? firstModelCallTrace;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(messages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const selectedSessionMessage = messages.find((message) => message.id === selectedMessageId) ?? messages[0] ?? null;
  const selectedRunStep = runSteps.find((step) => step.id === selectedStepId) ?? runSteps[0] ?? null;
  const selectedSessionEvent = deferredEvents.find((event) => event.id === selectedEventId) ?? deferredEvents[0] ?? null;
  const allRuntimeToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.runtimeToolNames));
  const allAdvertisedToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.activeToolNames));
  const allRuntimeTools = [
    ...new Map(modelCallTraces.flatMap((trace) => trace.input.runtimeTools).map((tool) => [tool.name, tool])).values()
  ];
  const allToolServers = [...new Map(modelCallTraces.flatMap((trace) => trace.input.toolServers).map((server) => [server.name, server])).values()];
  const resolvedModelNames = uniqueStrings(modelCallTraces.map((trace) => trace.input.model).filter((value): value is string => Boolean(value)));
  const resolvedModelRefs = uniqueStrings(
    modelCallTraces.map((trace) => trace.input.canonicalModelRef).filter((value): value is string => Boolean(value))
  );
  const hasPersistedAssistantForSelectedRun = selectedRunId
    ? messages.some((message) => message.runId === selectedRunId && message.role === "assistant")
    : false;
  const messageFeed = [...messages];
  if (selectedRunId && liveOutput[selectedRunId] && !hasPersistedAssistantForSelectedRun) {
    messageFeed.push({
      id: `live:${selectedRunId}`,
      sessionId: sessionId || "live",
      runId: selectedRunId,
      role: "assistant",
      content: liveOutput[selectedRunId],
      createdAt: new Date().toISOString()
    });
  }

  async function request<T>(path: string, init?: RequestInit, options?: { auth?: boolean }) {
    const headers = new Headers(init?.headers);
    const authRequired = options?.auth ?? true;
    const token = connection.token.trim();

    if (authRequired && token) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await fetch(buildUrl(connection.baseUrl, path), {
      ...init,
      headers
    });

    if (!response.ok) {
      const body = await readJsonResponse<{ error?: { message?: string } }>(response).catch(() => undefined);
      throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    }

    return readJsonResponse<T>(response);
  }

  function downloadSessionTrace() {
    const selectedOrLatestRunId = run?.id ?? (selectedRunIdValue || "latest");
    const latestRequest = buildAiSdkLikeRequest(latestModelCallTrace);
    const exportPayload = {
      format: "oah.ai-sdk-session.v2",
      exportedAt: new Date().toISOString(),
      basic: {
        workspace: workspace
          ? {
              id: workspace.id,
              name: workspace.name,
              kind: workspace.kind,
              rootPath: workspace.rootPath,
              readOnly: workspace.readOnly
            }
          : null,
        session: session
          ? {
              id: session.id,
              title: session.title ?? currentSessionName,
              workspaceId: session.workspaceId,
              agentName: session.agentName,
              activeAgentName: session.activeAgentName,
              status: session.status,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt
            }
          : null,
        run: run
          ? {
              id: run.id,
              sessionId: run.sessionId,
              parentRunId: run.parentRunId,
              agentName: run.agentName,
              effectiveAgentName: run.effectiveAgentName,
              status: run.status,
              startedAt: run.startedAt,
              heartbeatAt: run.heartbeatAt,
              endedAt: run.endedAt
            }
          : {
              id: selectedOrLatestRunId
            },
        model: latestRequest
          ? {
              model: latestRequest.model,
              canonicalModelRef: latestRequest.canonicalModelRef,
              provider: latestRequest.provider,
              ...(latestRequest.temperature !== undefined ? { temperature: latestRequest.temperature } : {}),
              ...(latestRequest.maxTokens !== undefined ? { maxTokens: latestRequest.maxTokens } : {})
            }
          : null
      },
      tools: latestRequest
        ? {
            definitions: latestRequest.tools,
            activeTools: latestRequest.activeTools,
            toolServers: latestRequest.toolServers
          }
        : {
            definitions: {},
            activeTools: [],
            toolServers: []
          },
      Messages: buildAiSdkLikeStoredMessages(messages)
    };

    const sessionSegment = sanitizeFileSegment(session?.title ?? session?.id ?? currentSessionName);
    const runSegment = sanitizeFileSegment(selectedOrLatestRunId);
    downloadJsonFile(`${sessionSegment}-${runSegment}-session.json`, exportPayload);
  }

  function rememberWorkspace(
    workspaceRecord: Workspace,
    options?: {
      template?: string;
    }
  ) {
    const now = new Date().toISOString();
    setSavedWorkspaces((current) => {
      const existing = current.find((entry) => entry.id === workspaceRecord.id);
      const nextRecord: SavedWorkspaceRecord = {
        id: workspaceRecord.id,
        name: workspaceRecord.name,
        rootPath: workspaceRecord.rootPath,
        status: workspaceRecord.status,
        createdAt: workspaceRecord.createdAt ?? existing?.createdAt,
        lastOpenedAt: now
      };
      const templateValue = options?.template ?? existing?.template;
      if (templateValue) {
        nextRecord.template = templateValue;
      }

      if (existing) {
        return current.map((entry) => (entry.id === workspaceRecord.id ? nextRecord : entry));
      }

      return [...current, nextRecord].slice(-24);
    });
  }

  function rememberSession(sessionRecord: Session) {
    const now = new Date().toISOString();
    const nextRecord: SavedSessionRecord = {
      id: sessionRecord.id,
      workspaceId: sessionRecord.workspaceId,
      createdAt: sessionRecord.createdAt,
      lastOpenedAt: now
    };

    if (sessionRecord.title) {
      nextRecord.title = sessionRecord.title;
    }

    if (sessionRecord.activeAgentName) {
      nextRecord.agentName = sessionRecord.activeAgentName;
    }

    setSavedSessions((current) => [
      nextRecord,
      ...current.filter((entry) => entry.id !== sessionRecord.id)
    ].slice(0, 48));
  }

  function forgetWorkspace(workspaceToRemoveId: string) {
    if (workspaceId === workspaceToRemoveId) {
      clearWorkspaceSelection(workspaceToRemoveId);
      return;
    }

    setSavedWorkspaces((current) => current.filter((entry) => entry.id !== workspaceToRemoveId));
    setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== workspaceToRemoveId));
    setRecentWorkspaces((current) => current.filter((entry) => entry !== workspaceToRemoveId));
  }

  async function deleteWorkspace(workspaceToRemoveId: string) {
    const targetWorkspace = savedWorkspaces.find((entry) => entry.id === workspaceToRemoveId);
    const confirmed = window.confirm(
      `确认删除 workspace "${targetWorkspace?.name ?? workspaceToRemoveId}" 吗？这会删除服务端记录，并同步清理受管目录中的 workspace 文件夹。`
    );
    if (!confirmed) {
      return;
    }

    try {
      await request<void>(`/api/v1/workspaces/${workspaceToRemoveId}`, {
        method: "DELETE"
      });
      forgetWorkspace(workspaceToRemoveId);
      void refreshWorkspaceIndex(true);
      setActivity(`Workspace ${workspaceToRemoveId} 已删除`);
      setErrorMessage("");
    } catch (error) {
      if (isNotFoundError(error)) {
        forgetWorkspace(workspaceToRemoveId);
        setActivity(`Workspace ${workspaceToRemoveId} 已从列表清理`);
        setErrorMessage("");
        return;
      }

      setErrorMessage(toErrorMessage(error));
    }
  }

  function removeSavedSession(sessionToRemoveId: string) {
    setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToRemoveId));
    setRecentSessions((current) => current.filter((entry) => entry !== sessionToRemoveId));

    if (sessionId === sessionToRemoveId) {
      setSessionId("");
      setSession(null);
      setMessages([]);
      setEvents([]);
      setSelectedRunId("");
      setRun(null);
      setRunSteps([]);
      setLiveOutput({});
    }
  }

  function clearSessionSelection(sessionToClearId?: string) {
    const targetId = sessionToClearId ?? sessionId;
    lastCursorRef.current = undefined;
    streamAbortRef.current?.abort();
    window.clearTimeout(runPollingTimerRef.current);
    setStreamState("idle");
    setSessionId("");
    setSession(null);
    setMessages([]);
    setEvents([]);
    setSelectedRunId("");
    setRun(null);
    setRunSteps([]);
    setLiveOutput({});

    if (targetId) {
      setSavedSessions((current) => current.filter((entry) => entry.id !== targetId));
      setRecentSessions((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function clearWorkspaceSelection(workspaceToClearId?: string) {
    const targetId = workspaceToClearId ?? workspaceId;
    clearSessionSelection();
    setWorkspaceId("");
    setWorkspace(null);
    setCatalog(null);
    setMirrorStatus(null);

    if (targetId) {
      setSavedWorkspaces((current) => current.filter((entry) => entry.id !== targetId));
      setRecentWorkspaces((current) => current.filter((entry) => entry !== targetId));
      setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== targetId));
    }
  }

  function openWorkspace(targetId: string) {
    const nextWorkspaceId = targetId.trim();
    if (!nextWorkspaceId) {
      return;
    }

    const shouldClearSession =
      Boolean(sessionId.trim()) &&
      ((session?.workspaceId && session.workspaceId !== nextWorkspaceId) ||
        (!session?.workspaceId && workspaceId.trim() !== nextWorkspaceId));

    if (shouldClearSession) {
      clearSessionSelection();
    }

    setSidebarMode("sessions");
    setWorkspaceId(nextWorkspaceId);
    void refreshWorkspace(nextWorkspaceId);
  }

  function scheduleMessagesRefresh() {
    window.clearTimeout(messageRefreshTimerRef.current);
    messageRefreshTimerRef.current = window.setTimeout(() => {
      void refreshMessages(true);
    }, 120);
  }

  function scheduleRunRefresh(runId: string) {
    window.clearTimeout(runRefreshTimerRef.current);
    runRefreshTimerRef.current = window.setTimeout(() => {
      void refreshRun(runId, true);
      void refreshRunSteps(runId, true);
    }, 140);
  }

  async function pingHealth() {
    try {
      setHealthStatus("checking");
      const [healthResponse, readinessResponse] = await Promise.all([
        fetch(buildUrl(connection.baseUrl, "/healthz")),
        fetch(buildUrl(connection.baseUrl, "/readyz"))
      ]);

      if (!healthResponse.ok) {
        throw new Error(`${healthResponse.status} ${healthResponse.statusText}`);
      }

      const healthPayload = (await readJsonResponse<HealthReportResponse>(healthResponse)) ?? null;
      const readinessPayload = await readJsonResponse<ReadinessReportResponse>(readinessResponse).catch(() => null);

      setHealthReport(healthPayload);
      setReadinessReport(readinessPayload);
      setHealthStatus(healthPayload?.status ?? (readinessResponse.ok ? "ok" : "degraded"));
      setActivity(
        healthPayload?.status === "degraded" || readinessPayload?.status === "not_ready"
          ? "服务探针发现降级项"
          : "服务健康检查通过"
      );
      setErrorMessage("");
    } catch (error) {
      setHealthStatus("error");
      setHealthReport(null);
      setReadinessReport(null);
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshStorageOverview(quiet = false) {
    try {
      setStorageBusy(true);
      const response = await request<StorageOverview>("/api/v1/storage/overview");
      setStorageOverview(response);
      if (!quiet) {
        setActivity("已刷新 PG / Redis 存储概览");
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshStorageTable(
    table = selectedStorageTable,
    quiet = false,
    overrides?: {
      offset?: number;
      q?: string;
      workspaceId?: string;
      sessionId?: string;
      runId?: string;
    }
  ) {
    try {
      setStorageBusy(true);
      const pageSize = storageTablePreviewLimit(table);
      const params = new URLSearchParams({
        limit: String(pageSize)
      });
      const offset = overrides?.offset ?? storageTableOffset;
      const q = overrides?.q ?? storageTableSearch;
      const workspaceId = overrides?.workspaceId ?? storageTableWorkspaceId;
      const sessionId = overrides?.sessionId ?? storageTableSessionId;
      const runId = overrides?.runId ?? storageTableRunId;
      params.set("offset", String(offset));
      if (q.trim()) {
        params.set("q", q.trim());
      }
      if (workspaceId.trim()) {
        params.set("workspaceId", workspaceId.trim());
      }
      if (sessionId.trim()) {
        params.set("sessionId", sessionId.trim());
      }
      if (runId.trim()) {
        params.set("runId", runId.trim());
      }
      const response = await request<StoragePostgresTablePage>(`/api/v1/storage/postgres/tables/${table}?${params.toString()}`);
      setSelectedStorageTable(table);
      setStorageTableOffset(offset);
      setStorageTablePage(response);
      setSelectedStorageRow(response.rows[0] ?? null);
      if (!quiet) {
        setActivity(`已加载 ${table} 表预览`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeys(options?: { cursor?: string; quiet?: boolean }) {
    try {
      setStorageBusy(true);
      const pattern = redisKeyPattern.trim() || "oah:*";
      const params = new URLSearchParams({
        pattern
      });
      if (options?.cursor) {
        params.set("cursor", options.cursor);
      }
      params.set("pageSize", "100");
      const response = await request<StorageRedisKeyPage>(`/api/v1/storage/redis/keys?${params.toString()}`);
      setRedisKeyPage(response);
      if (!options?.quiet) {
        setActivity(`已加载 ${response.items.length} 个 Redis key`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!options?.quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshRedisKeyDetail(key = selectedRedisKey, quiet = false) {
    const targetKey = key.trim();
    if (!targetKey) {
      setRedisKeyDetail(null);
      return;
    }

    try {
      setStorageBusy(true);
      const params = new URLSearchParams({
        key: targetKey
      });
      const response = await request<StorageRedisKeyDetail>(`/api/v1/storage/redis/key?${params.toString()}`);
      setSelectedRedisKey(targetKey);
      setRedisKeyDetail(response);
      if (!quiet) {
        setActivity(`已加载 Redis key ${targetKey}`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setStorageBusy(false);
    }
  }

  async function deleteRedisKey() {
    const targetKey = selectedRedisKey.trim();
    if (!targetKey) {
      return;
    }

    if (!window.confirm(`Delete Redis key ${targetKey}?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      const params = new URLSearchParams({
        key: targetKey
      });
      await request(`/api/v1/storage/redis/key?${params.toString()}`, {
        method: "DELETE"
      });
      setSelectedRedisKeys((current) => current.filter((key) => key !== targetKey));
      setRedisKeyDetail(null);
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      setActivity(`已删除 Redis key ${targetKey}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function deleteSelectedRedisKeys() {
    if (selectedRedisKeys.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${selectedRedisKeys.length} Redis keys?`)) {
      return;
    }

    try {
      setStorageBusy(true);
      await request("/api/v1/storage/redis/keys/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          keys: selectedRedisKeys
        })
      });
      setSelectedRedisKeys([]);
      if (selectedRedisKey && selectedRedisKeys.includes(selectedRedisKey)) {
        setSelectedRedisKey("");
        setRedisKeyDetail(null);
      }
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      setActivity(`已删除 ${selectedRedisKeys.length} 个 Redis key`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function clearRedisSessionQueue(key: string) {
    try {
      setStorageBusy(true);
      await request("/api/v1/storage/redis/session-queue/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ key })
      });
      if (selectedRedisKey === key) {
        setRedisKeyDetail(null);
      }
      setSelectedRedisKeys((current) => current.filter((entry) => entry !== key));
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      setActivity(`已清空 queue ${key}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function releaseRedisSessionLock(key: string) {
    try {
      setStorageBusy(true);
      await request("/api/v1/storage/redis/session-lock/release", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ key })
      });
      if (selectedRedisKey === key) {
        setRedisKeyDetail(null);
      }
      setSelectedRedisKeys((current) => current.filter((entry) => entry !== key));
      await Promise.all([refreshStorageOverview(true), refreshRedisKeys({ quiet: true })]);
      setActivity(`已释放 lock ${key}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setStorageBusy(false);
    }
  }

  async function refreshWorkspaceTemplates(quiet = false) {
    try {
      const response = await request<WorkspaceTemplateList>("/api/v1/workspace-templates");
      startTransition(() => {
        setWorkspaceManagementEnabled(true);
        setWorkspaceTemplates(response.items.map((item) => item.name));
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模板`);
        setErrorMessage("");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("workspace_templates_unavailable") ||
          error.message.toLowerCase().includes("workspace templates are not available"))
      ) {
        startTransition(() => {
          setWorkspaceManagementEnabled(false);
          setWorkspaceTemplates([]);
        });
        if (!quiet) {
          setErrorMessage("");
        }
        return;
      }

      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspaceIndex(quiet = false) {
    try {
      const response = await request<{ items: Workspace[]; nextCursor?: string }>("/api/v1/workspaces?pageSize=200");
      startTransition(() => {
        setSavedWorkspaces((current) => {
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          return response.items.map((item) => {
            const existing = currentById.get(item.id);
            return {
              id: item.id,
              name: item.name,
              rootPath: item.rootPath,
              status: item.status,
              createdAt: item.createdAt,
              lastOpenedAt: existing?.lastOpenedAt ?? item.updatedAt,
              ...(existing?.template ? { template: existing.template } : {})
            } satisfies SavedWorkspaceRecord;
          });
        });
      });

      if (response.items.length === 1) {
        const onlyWorkspace = response.items[0]!;
        if (!sessionId.trim() && workspaceId !== onlyWorkspace.id) {
          setSidebarMode("sessions");
          void refreshWorkspace(onlyWorkspace.id, true);
        }
      } else if (workspaceId.trim() && !response.items.some((item) => item.id === workspaceId)) {
        clearWorkspaceSelection(workspaceId);
      }

      if (!quiet) {
        setActivity(`已同步 ${response.items.length} 个 workspace`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshModelProviders(quiet = false) {
    try {
      const response = await request<ModelProviderListResponse>("/api/v1/model-providers");
      startTransition(() => {
        setModelProviders(response.items);
      });
      if (!quiet) {
        setActivity(`已加载 ${response.items.length} 个模型 provider`);
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspace(targetId = workspaceId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const workspaceResponse = await request<Workspace>(`/api/v1/workspaces/${targetId}`);
      const [catalogResponse, mirrorStatusResponse] = await Promise.allSettled([
        request<WorkspaceCatalog>(`/api/v1/workspaces/${targetId}/catalog`),
        request<WorkspaceHistoryMirrorStatus>(`/api/v1/workspaces/${targetId}/history-mirror`)
      ]);
      const refreshWarnings = [catalogResponse, mirrorStatusResponse]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => toErrorMessage(result.reason));

      startTransition(() => {
        setWorkspace(workspaceResponse);
        setCatalog(catalogResponse.status === "fulfilled" ? catalogResponse.value : null);
        setMirrorStatus(mirrorStatusResponse.status === "fulfilled" ? mirrorStatusResponse.value : null);
        setWorkspaceId(targetId);
        setRecentWorkspaces((current) => addRecentId(current, targetId));
      });
      rememberWorkspace(workspaceResponse);
      setActivity(`Workspace ${targetId} 已加载`);
      if (!quiet && refreshWarnings.length > 0) {
        setErrorMessage(refreshWarnings.join(" | "));
      } else if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setWorkspace(null);
      setCatalog(null);
      setMirrorStatus(null);
      if (isNotFoundError(error)) {
        clearWorkspaceSelection(targetId);
      }
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createWorkspace() {
    try {
      const created = await request<Workspace>("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: workspaceDraft.name.trim(),
          template: workspaceDraft.template.trim(),
          ...(workspaceDraft.rootPath.trim() ? { rootPath: workspaceDraft.rootPath.trim() } : {}),
          executionPolicy: "local"
        })
      });

      startTransition(() => {
        setWorkspaceId(created.id);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setSession(null);
        setSessionId("");
        setMessages([]);
        setEvents([]);
        setWorkspace(created);
        setRecentWorkspaces((current) => addRecentId(current, created.id));
      });
      rememberWorkspace(created, {
        template: workspaceDraft.template.trim()
      });
      lastCursorRef.current = undefined;
      setShowWorkspaceCreator(false);
      setSidebarMode("sessions");
      await refreshWorkspace(created.id, true);
      await refreshWorkspaceIndex(true);
      setActivity(`Workspace ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function updateWorkspaceHistoryMirrorEnabled(enabled: boolean) {
    if (!workspaceId.trim() || !workspace) {
      setErrorMessage("请先加载 workspace。");
      return;
    }

    try {
      setMirrorToggleBusy(true);
      const updated = await request<Workspace>(`/api/v1/workspaces/${workspaceId}/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          historyMirrorEnabled: enabled
        })
      });

      startTransition(() => {
        setWorkspace(updated);
      });
      const nextMirrorStatus = await request<WorkspaceHistoryMirrorStatus>(
        `/api/v1/workspaces/${workspaceId}/history-mirror`
      );
      startTransition(() => {
        setMirrorStatus(nextMirrorStatus);
      });
      rememberWorkspace(updated);
      setActivity(`Mirror sync 已${enabled ? "开启" : "关闭"}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setMirrorToggleBusy(false);
    }
  }

  async function rebuildWorkspaceHistoryMirror() {
    if (!workspaceId.trim() || !workspace) {
      setErrorMessage("请先加载 workspace。");
      return;
    }

    try {
      setMirrorRebuildBusy(true);
      const nextMirrorStatus = await request<WorkspaceHistoryMirrorStatus>(
        `/api/v1/workspaces/${workspaceId}/history-mirror/rebuild`,
        {
          method: "POST"
        }
      );
      startTransition(() => {
        setMirrorStatus(nextMirrorStatus);
      });
      setActivity("Mirror sync 已重建");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setMirrorRebuildBusy(false);
    }
  }

  async function refreshSession(targetId = sessionId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const [sessionResponse, messagePage] = await Promise.all([
        request<Session>(`/api/v1/sessions/${targetId}`),
        request<{ items: Message[] }>(`/api/v1/sessions/${targetId}/messages?pageSize=200`)
      ]);
      const nextWorkspaceId = sessionResponse.workspaceId;
      const workspaceChanged = workspace?.id !== nextWorkspaceId;

      startTransition(() => {
        setSession(sessionResponse);
        setSessionId(targetId);
        setWorkspaceId(nextWorkspaceId);
        setMessages(messagePage.items);
        setRecentSessions((current) => addRecentId(current, targetId));
        if (workspaceChanged) {
          setWorkspace(null);
          setCatalog(null);
          setMirrorStatus(null);
        }
      });
      rememberSession(sessionResponse);
      if (workspaceChanged) {
        void refreshWorkspace(nextWorkspaceId, true);
      }
      setActivity(`Session ${targetId} 已加载`);
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      setSession(null);
      setMessages([]);
      if (isNotFoundError(error)) {
        clearSessionSelection(targetId);
      }
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createSession() {
    if (!workspaceId.trim()) {
      setErrorMessage("请先创建或加载 workspace。");
      return;
    }

    try {
      const created = await request<Session>(`/api/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(sessionDraft.title.trim() ? { title: sessionDraft.title.trim() } : {}),
          ...(sessionDraft.agentName.trim() ? { agentName: sessionDraft.agentName.trim() } : {})
        })
      });

      lastCursorRef.current = undefined;
      startTransition(() => {
        setEvents([]);
        setSelectedRunId("");
        setRun(null);
        setRunSteps([]);
        setLiveOutput({});
      });
      setShowSessionCreator(false);
      await refreshSession(created.id, true);
      rememberSession(created);
      setActivity(`Session ${created.id} 已创建`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshMessages(quiet = false) {
    if (!sessionId.trim()) {
      return;
    }

    try {
      const messagePage = await request<{ items: Message[] }>(`/api/v1/sessions/${sessionId}/messages?pageSize=200`);
      startTransition(() => {
        setMessages(messagePage.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRun(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const runResponse = await request<Run>(`/api/v1/runs/${targetId}`);
      startTransition(() => {
        setRun(runResponse);
        setSelectedRunId(targetId);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshRunSteps(targetId = selectedRunId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const page = await request<{ items: RunStep[] }>(`/api/v1/runs/${targetId}/steps?pageSize=200`);
      startTransition(() => {
        setRunSteps(page.items);
      });
      if (!quiet) {
        setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function sendMessage() {
    if (!sessionId.trim()) {
      setErrorMessage("请先创建或加载 session。");
      return;
    }

    const content = draftMessage.trim();
    if (!content) {
      return;
    }

    try {
      shouldAutoFollowConversationRef.current = true;
      const accepted = await request<MessageAccepted>(`/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          content
        })
      });

      startTransition(() => {
        setDraftMessage("");
        setSelectedRunId(accepted.runId);
        setLiveOutput((current) => ({
          ...current,
          [accepted.runId]: ""
        }));
      });
      if (autoStream) {
        setStreamRevision((current) => current + 1);
      }
      await Promise.all([refreshMessages(true), refreshRun(accepted.runId, true), refreshRunSteps(accepted.runId, true)]);
      setActivity(`消息已入队，run=${accepted.runId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function cancelCurrentRun() {
    if (!selectedRunId.trim()) {
      return;
    }

    try {
      await request(`/api/v1/runs/${selectedRunId}/cancel`, {
        method: "POST"
      });
      await refreshRun(selectedRunId, true);
      setActivity(`已请求取消 run ${selectedRunId}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function generateOnce() {
    try {
      setGenerateBusy(true);
      const response = await request<ModelGenerateResponse>(
        "/internal/v1/models/generate",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            prompt: modelDraft.prompt.trim(),
            ...(modelDraft.model.trim() ? { model: modelDraft.model.trim() } : {})
          })
        },
        { auth: false }
      );
      setGenerateOutput(response);
      setActivity(`内部模型网关 generate 成功，model=${response.model}`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setGenerateBusy(false);
    }
  }

  const handleSessionEvent = useEffectEvent((frame: SseFrame) => {
    const event = {
      id: frame.cursor ?? crypto.randomUUID(),
      cursor: frame.cursor ?? String(Date.now()),
      sessionId,
      runId: typeof frame.data.runId === "string" ? frame.data.runId : undefined,
      event: frame.event as SessionEventContract["event"],
      data: frame.data,
      createdAt: new Date().toISOString()
    } satisfies SessionEventContract;

    if (frame.cursor) {
      lastCursorRef.current = frame.cursor;
    }

    startTransition(() => {
      setEvents((current) => [event, ...current].slice(0, 200));
    });

    if (event.runId) {
      setSelectedRunId((current) => current || event.runId || "");
    }

    if (event.event === "message.delta" && typeof event.runId === "string" && typeof event.data.delta === "string") {
      setLiveOutput((current) => ({
        ...current,
        [event.runId!]: `${current[event.runId!] ?? ""}${event.data.delta as string}`
      }));
    }

    if (event.event === "message.completed" && typeof event.runId === "string") {
      const messageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
      const content = normalizeMessageContent(event.data.content);
      if (messageId && content !== null) {
        startTransition(() => {
          setMessages((current) =>
            upsertSessionMessage(current, {
              id: messageId,
              sessionId,
              runId: event.runId,
              role: inferCompletedMessageRole(event.data),
              content,
              createdAt: event.createdAt
            })
          );
        });
      }
      setLiveOutput((current) => {
        const next = { ...current };
        delete next[event.runId!];
        return next;
      });
      scheduleMessagesRefresh();
      scheduleRunRefresh(event.runId);
    }

    if (
      typeof event.runId === "string" &&
      [
        "run.queued",
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "tool.started",
        "tool.completed",
        "tool.failed",
        "agent.switched",
        "agent.delegate.started",
        "agent.delegate.completed",
        "agent.delegate.failed"
      ].includes(event.event)
    ) {
      scheduleRunRefresh(event.runId);
    }

    if (typeof event.runId === "string" && isTerminalRunEvent(event.event)) {
      scheduleMessagesRefresh();
    }

    setActivity(`${event.event}${event.runId ? ` · ${event.runId}` : ""}`);
  });

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      window.clearTimeout(messageRefreshTimerRef.current);
      window.clearTimeout(runRefreshTimerRef.current);
      window.clearTimeout(runPollingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    shouldAutoFollowConversationRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    void refreshWorkspaceIndex(true);
    void refreshWorkspaceTemplates(true);
    void refreshModelProviders(true);
  }, [connection.baseUrl, connection.token]);

  useEffect(() => {
    if (sessionId.trim()) {
      void refreshSession(sessionId, true);
      return;
    }

    if (workspaceId.trim()) {
      void refreshWorkspace(workspaceId, true);
    }
  }, [connection.baseUrl, connection.token]);

  useEffect(() => {
    if (surfaceMode !== "storage") {
      return;
    }

    void refreshStorageOverview(true);
    void refreshStorageTable(selectedStorageTable, true);
    void refreshRedisKeys({ quiet: true });
  }, [surfaceMode, connection.baseUrl, connection.token]);

  useEffect(() => {
    if (!sessionId.trim() || !autoStream || session?.id !== sessionId) {
      streamAbortRef.current?.abort();
      setStreamState("idle");
      return;
    }

    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    setStreamState("connecting");
    const listeningTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setStreamState((current) => (current === "connecting" ? "listening" : current));
      }
    }, 1200);

    const query = new URLSearchParams();
    if (streamRunId) {
      query.set("runId", streamRunId);
    }
    if (lastCursorRef.current) {
      query.set("cursor", lastCursorRef.current);
    }

    void (async () => {
      try {
        const headers = new Headers();
        const token = connection.token.trim();
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const response = await fetch(
          buildUrl(connection.baseUrl, `/api/v1/sessions/${sessionId}/events${query.size > 0 ? `?${query.toString()}` : ""}`),
          {
            signal: controller.signal,
            headers
          }
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        setStreamState("open");
        await consumeSse(response, handleSessionEvent, controller.signal);
        if (!controller.signal.aborted) {
          setStreamState("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (isNotFoundError(error)) {
            clearSessionSelection(sessionId);
            setActivity(`Session ${sessionId} 不存在，已清除本地选择`);
            setErrorMessage("");
            return;
          }
          setStreamState("error");
          setErrorMessage(toErrorMessage(error));
        }
      }
    })();

    return () => {
      window.clearTimeout(listeningTimer);
      controller.abort();
    };
  }, [
    autoStream,
    connection.baseUrl,
    connection.token,
    filterSelectedRun,
    session?.id,
    streamRunId,
    sessionId,
    streamRevision
  ]);

  useEffect(() => {
    window.clearTimeout(runPollingTimerRef.current);

    if (!sessionId.trim() || !selectedRunIdValue) {
      return;
    }

    if (run?.id === selectedRunIdValue && isTerminalRunStatus(run.status)) {
      return;
    }

    let cancelled = false;

    const pollRunSnapshot = async () => {
      try {
        const [nextRun, nextSteps, nextMessages] = await Promise.all([
          request<Run>(`/api/v1/runs/${selectedRunIdValue}`),
          request<{ items: RunStep[] }>(`/api/v1/runs/${selectedRunIdValue}/steps?pageSize=200`),
          request<{ items: Message[] }>(`/api/v1/sessions/${sessionId}/messages?pageSize=200`)
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setRun(nextRun);
          setRunSteps(nextSteps.items);
          setMessages(nextMessages.items);
        });

        const hasPersistedAssistant = nextMessages.items.some(
          (message) => message.runId === selectedRunIdValue && message.role === "assistant"
        );
        const shouldKeepPollingForCompletedMessage = nextRun.status === "completed" && !hasPersistedAssistant;

        if (!isTerminalRunStatus(nextRun.status) || shouldKeepPollingForCompletedMessage) {
          runPollingTimerRef.current = window.setTimeout(() => {
            void pollRunSnapshot();
          }, shouldKeepPollingForCompletedMessage ? 400 : 1000);
          return;
        }

        setLiveOutput((current) => {
          const next = { ...current };
          delete next[selectedRunIdValue];
          return next;
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        runPollingTimerRef.current = window.setTimeout(() => {
          void pollRunSnapshot();
        }, 1500);

        if (streamState === "error") {
          setErrorMessage(toErrorMessage(error));
        }
      }
    };

    runPollingTimerRef.current = window.setTimeout(() => {
      void pollRunSnapshot();
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(runPollingTimerRef.current);
    };
  }, [connection.baseUrl, connection.token, run?.id, run?.status, selectedRunIdValue, sessionId, streamState]);

  useEffect(() => {
    if (!shouldAutoFollowConversationRef.current) {
      return;
    }

    const thread = conversationThreadRef.current;
    const tail = conversationTailRef.current;
    if (!thread || !tail) {
      return;
    }

    window.requestAnimationFrame(() => {
      tail.scrollIntoView({ block: "end" });
    });
  }, [messageFeed.length, selectedRunIdValue, liveOutput]);

  const activeWorkspaceId = session?.workspaceId || workspaceId;
  const activeSavedWorkspace = savedWorkspaces.find((entry) => entry.id === activeWorkspaceId);
  const activeWorkspace = workspace?.id === activeWorkspaceId ? workspace : null;
  const currentWorkspaceName = activeWorkspace?.name ?? activeSavedWorkspace?.name ?? activeWorkspaceId ?? "No workspace";
  const currentSessionName = session?.title?.trim() || session?.id || "No session";
  const hasActiveSession = Boolean(sessionId.trim() && session);
  const latestEvent = deferredEvents[0];
  const inspectorSubtitle =
    inspectorTab === "overview"
      ? "Session / run summary and quick controls"
      : inspectorTab === "context"
        ? "System prompt and stored session messages"
        : inspectorTab === "calls"
          ? "Model calls, tool exchanges, and trace export"
          : inspectorTab === "runtime"
            ? "Run steps and SSE event feed"
            : inspectorTab === "catalog"
              ? "Workspace catalog and mirror controls"
              : "Single-shot model generation";

  return (
    <main className="app-shell overflow-x-hidden px-3 py-3 md:px-4 md:py-4 xl:h-screen xl:overflow-hidden xl:px-5 xl:py-5">
      <div className="mx-auto max-w-[1760px] xl:flex xl:h-full xl:flex-col xl:min-h-0">
        <header className="shell-card animate-rise mb-4 flex flex-wrap items-center justify-between gap-4 rounded-[30px] border px-5 py-4 md:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-[color:var(--accent)] text-[color:var(--accent-foreground)] shadow-[0_10px_22px_rgba(10,23,48,0.22)]">
              <Bot className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="brand-kicker">Runtime Workbench</p>
              <p className="surface-title truncate text-lg font-semibold text-[color:var(--foreground)]">
                Open Agent Harness
              </p>
              <p className="mt-0.5 truncate text-xs text-[color:var(--muted-foreground)]">
                {surfaceMode === "storage" ? "Global storage workbench" : `Workspace: ${currentWorkspaceName}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="segmented-shell">
              <div className="flex gap-2">
                <InspectorTabButton
                  label="Runtime"
                  active={surfaceMode === "runtime"}
                  onClick={() => setSurfaceMode("runtime")}
                />
                <InspectorTabButton
                  label="Storage"
                  active={surfaceMode === "storage"}
                  onClick={() => setSurfaceMode("storage")}
                />
              </div>
            </div>
            <StatusTile
              icon={Network}
              label="Health"
              value={healthStatus}
              tone={probeTone(healthStatus)}
              compact
            />
            <StatusTile
              icon={Orbit}
              label="Stream"
              value={streamState}
              tone={streamState === "open" ? "emerald" : streamState === "error" ? "rose" : streamState === "listening" ? "emerald" : "sky"}
              compact
            />
          </div>
        </header>

        {errorMessage ? (
          <div className="mb-4 rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {errorMessage}
          </div>
        ) : null}

        {surfaceMode === "storage" ? (
          <section className="xl:min-h-0 xl:flex-1">
            <Card className="shell-card overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-white/96 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="section-kicker">Global Storage</p>
                      <h1 className="truncate text-[28px] font-semibold tracking-[-0.04em] text-[color:var(--foreground)]">Storage</h1>
                      <p className="truncate text-sm text-[color:var(--muted-foreground)]">
                        全局数据库与队列管理视图，不依赖当前 session。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-[#f6f6f3] text-[color:var(--foreground)]">
                        {healthReport?.storage.primary ?? "unknown"} / {healthReport?.storage.runQueue ?? "unknown"}
                      </Badge>
                      {healthReport?.mirror ? (
                        <Badge>{`mirror ${healthReport.mirror.enabledWorkspaces}/${healthReport.mirror.errorWorkspaces}`}</Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-auto px-4 py-4 xl:min-h-0">
                  <StorageWorkbench
                    browserTab={storageBrowserTab}
                    onBrowserTabChange={setStorageBrowserTab}
                    overview={storageOverview}
                    tablePage={storageTablePage}
                    selectedTable={selectedStorageTable}
                    selectedRow={selectedStorageRow}
                    onSelectRow={setSelectedStorageRow}
                    storageTableSearch={storageTableSearch}
                    onStorageTableSearchChange={setStorageTableSearch}
                    storageTableWorkspaceId={storageTableWorkspaceId}
                    onStorageTableWorkspaceIdChange={setStorageTableWorkspaceId}
                    storageTableSessionId={storageTableSessionId}
                    onStorageTableSessionIdChange={setStorageTableSessionId}
                    storageTableRunId={storageTableRunId}
                    onStorageTableRunIdChange={setStorageTableRunId}
                    onSelectTable={(table) => void refreshStorageTable(table, false, { offset: 0 })}
                    redisKeyPattern={redisKeyPattern}
                    onRedisKeyPatternChange={setRedisKeyPattern}
                    redisKeyPage={redisKeyPage}
                    selectedRedisKey={selectedRedisKey}
                    selectedRedisKeys={selectedRedisKeys}
                    onSelectedRedisKeysChange={setSelectedRedisKeys}
                    onSelectRedisKey={(key) => void refreshRedisKeyDetail(key)}
                    redisKeyDetail={redisKeyDetail}
                    onRefreshOverview={() => void refreshStorageOverview()}
                    onRefreshTable={() => void refreshStorageTable()}
                    onPreviousTablePage={() =>
                      void refreshStorageTable(selectedStorageTable, false, {
                        offset: Math.max(0, storageTableOffset - (storageTablePage?.limit ?? storageTablePreviewLimit(selectedStorageTable)))
                      })
                    }
                    onNextTablePage={() =>
                      void refreshStorageTable(
                        selectedStorageTable,
                        false,
                        storageTablePage?.nextOffset !== undefined ? { offset: storageTablePage.nextOffset } : undefined
                      )
                    }
                    onClearTableFilters={() => {
                      setStorageTableSearch("");
                      setStorageTableWorkspaceId("");
                      setStorageTableSessionId("");
                      setStorageTableRunId("");
                      setStorageTableOffset(0);
                      void refreshStorageTable(selectedStorageTable, false, {
                        offset: 0,
                        q: "",
                        workspaceId: "",
                        sessionId: "",
                        runId: ""
                      });
                    }}
                    onDownloadTableCsv={() => {
                      if (!storageTablePage) {
                        return;
                      }

                      downloadCsvFile(
                        `${storageTablePage.table}.csv`,
                        storageTablePage.columns,
                        storageTablePage.rows
                      );
                    }}
                    onRefreshRedisKeys={() => void refreshRedisKeys()}
                    onLoadMoreRedisKeys={() =>
                      void refreshRedisKeys(redisKeyPage?.nextCursor ? { cursor: redisKeyPage.nextCursor } : undefined)
                    }
                    onRefreshRedisKey={() => void refreshRedisKeyDetail()}
                    onDeleteRedisKey={() => void deleteRedisKey()}
                    onDeleteSelectedRedisKeys={() => void deleteSelectedRedisKeys()}
                    onClearRedisSessionQueue={(key) => void clearRedisSessionQueue(key)}
                    onReleaseRedisSessionLock={(key) => void releaseRedisSessionLock(key)}
                    busy={storageBusy}
                  />
                </div>
              </div>
            </Card>
          </section>
        ) : (
        <section className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 xl:min-h-0">
            <Card className="shell-card overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className="border-b border-[color:var(--border)] bg-white/92 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="section-kicker">Runtime Navigator</p>
                      <p className="surface-title text-sm font-semibold text-[color:var(--foreground)]">Navigator</p>
                      <p className="text-xs text-[color:var(--muted-foreground)]">{orderedSavedWorkspaces.length} workspaces · {activeWorkspaceSessions.length} sessions</p>
                    </div>
                    {sidebarMode === "workspaces" && !workspaceManagementEnabled ? null : (
                      <button
                        className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:var(--border)] bg-white px-3 text-sm text-[color:var(--foreground)] transition hover:bg-[#f3f6fb]"
                        onClick={() => (sidebarMode === "workspaces" ? setShowWorkspaceCreator((current) => !current) : setShowSessionCreator((current) => !current))}
                      >
                        + New
                      </button>
                    )}
                  </div>
                  <div className="segmented-shell mt-4 flex">
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "workspaces" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("workspaces")}
                    >
                      Workspaces
                    </button>
                    <button
                      className={cn(
                        "flex-1 rounded-xl px-3 py-2 text-xs font-medium transition",
                        sidebarMode === "sessions" ? "bg-white text-[color:var(--foreground)] shadow-[0_1px_2px_rgba(15,15,15,0.06)]" : "text-[color:var(--muted-foreground)]"
                      )}
                      onClick={() => setSidebarMode("sessions")}
                    >
                      Sessions
                    </button>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-auto px-3 py-3 xl:min-h-0">
                  {sidebarMode === "workspaces" ? (
                    <>
                      <div className="px-1">
                        <p className="section-kicker">Workspace List</p>
                      </div>
                      {showWorkspaceCreator && workspaceManagementEnabled ? (
                        <div className="panel-card rounded-[22px] border p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Workspace</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowWorkspaceCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={workspaceDraft.name}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  name: event.target.value
                                }))
                              }
                              placeholder="Workspace name"
                            />
                            <Input
                              list="workspace-template-options"
                              value={workspaceDraft.template}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  template: event.target.value
                                }))
                              }
                              placeholder="Template"
                            />
                            <datalist id="workspace-template-options">
                              {workspaceTemplates.map((template) => (
                                <option key={template} value={template} />
                              ))}
                            </datalist>
                            <Input
                              value={workspaceDraft.rootPath}
                              onChange={(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  rootPath: event.target.value
                                }))
                              }
                              placeholder="Root path"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createWorkspace()}>
                                <FolderPlus className="h-4 w-4" />
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshWorkspaceTemplates()}>
                                <RefreshCw className="h-4 w-4" />
                                Templates
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {orderedSavedWorkspaces.length === 0 ? (
                          <EmptyState title="No workspaces" description="Create or load one." />
                        ) : (
                          orderedSavedWorkspaces.map((entry) => (
                            <WorkspaceSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === workspaceId}
                              sessionCount={savedSessions.filter((sessionEntry) => sessionEntry.workspaceId === entry.id).length}
                              canRemove={workspaceManagementEnabled}
                              onSelect={() => openWorkspace(entry.id)}
                              onRemove={() => void deleteWorkspace(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-1">
                        <p className="section-kicker">Session List</p>
                      </div>
                      {showSessionCreator ? (
                        <div className="panel-card rounded-[22px] border p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-[color:var(--foreground)]">New Session</p>
                            <button
                              className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                              onClick={() => setShowSessionCreator(false)}
                            >
                              Close
                            </button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              value={sessionDraft.title}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  title: event.target.value
                                }))
                              }
                              placeholder="Session title"
                            />
                            <Input
                              value={sessionDraft.agentName}
                              onChange={(event) =>
                                setSessionDraft((current) => ({
                                  ...current,
                                  agentName: event.target.value
                                }))
                              }
                              placeholder="Agent"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button className="flex-1" onClick={() => void createSession()}>
                                Create
                              </Button>
                              <Button className="flex-1" variant="secondary" onClick={() => void refreshSession()}>
                                Load
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-1">
                        {activeWorkspaceSessions.length === 0 ? (
                          <EmptyState title="No sessions" description="Select a workspace, then create one." />
                        ) : (
                          activeWorkspaceSessions.map((entry) => (
                            <SessionSidebarItem
                              key={entry.id}
                              entry={entry}
                              active={entry.id === sessionId}
                              onSelect={() => {
                                setSessionId(entry.id);
                                void refreshSession(entry.id);
                              }}
                              onRemove={() => removeSavedSession(entry.id)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t border-[color:var(--border)] bg-white/92 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToggleChip active={autoStream} label="Auto SSE" onClick={() => setAutoStream((current) => !current)} />
                    <ToggleChip active={filterSelectedRun} label="Current Run" onClick={() => setFilterSelectedRun((current) => !current)} />
                    <button
                      className="rounded-full border border-[color:var(--border)] bg-white px-3 py-1.5 text-xs font-medium text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                      onClick={() => setShowConnectionPanel((current) => !current)}
                    >
                      Server
                    </button>
                  </div>
                  {showConnectionPanel ? (
                    <div className="panel-card mt-3 space-y-3 rounded-[20px] border p-3">
                      <div>
                        <p className="section-kicker">Server Connection</p>
                        <p className="mt-1 text-sm text-[color:var(--foreground)]">调整当前 web 控制台连接的 OAH 服务地址与调试参数。</p>
                      </div>
                      <Input
                        value={connection.baseUrl}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            baseUrl: event.target.value
                          }))
                        }
                        placeholder="Base URL"
                      />
                      <Input
                        value={connection.token}
                        onChange={(event) =>
                          setConnection((current) => ({
                            ...current,
                            token: event.target.value
                          }))
                        }
                        placeholder="Bearer token (optional)"
                      />
                      <div className="flex gap-2">
                        <Button className="flex-1" variant="secondary" onClick={() => void pingHealth()}>
                          Health
                        </Button>
                        <Button className="flex-1" variant="ghost" onClick={() => setStreamRevision((current) => current + 1)}>
                          SSE
                        </Button>
                      </div>
                      {healthReport || readinessReport ? (
                        <div className="grid gap-2 pt-1">
                          <StatusTile
                            icon={Activity}
                            label="Readiness"
                            value={readinessReport?.status ?? "unknown"}
                            tone={probeTone(readinessReport?.status ?? "idle")}
                          />
                          <div className="grid gap-2 sm:grid-cols-2">
                            <StatusTile
                              icon={Database}
                              label="Postgres"
                              value={`${healthReport?.storage.primary ?? "unknown"} · ${healthReport?.checks.postgres ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.postgres ?? "idle")}
                            />
                            <StatusTile
                              icon={Network}
                              label="Events"
                              value={`${healthReport?.storage.events ?? "unknown"} · ${healthReport?.checks.redisEvents ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.redisEvents ?? "idle")}
                            />
                            <StatusTile
                              icon={Orbit}
                              label="Run Queue"
                              value={`${healthReport?.storage.runQueue ?? "unknown"} · ${healthReport?.checks.redisRunQueue ?? "unknown"}`}
                              tone={probeTone(healthReport?.checks.redisRunQueue ?? "idle")}
                            />
                            <StatusTile
                              icon={Bot}
                              label="Process"
                              value={
                                healthReport
                                  ? `${healthReport.process.label} · ${healthReport.process.execution}`
                                  : "unknown"
                              }
                              tone={probeTone(healthReport?.process.execution === "none" ? "degraded" : "ok")}
                            />
                            <StatusTile
                              icon={Database}
                              label="Mirror"
                              value={
                                healthReport
                                  ? `${healthReport.checks.historyMirror} · ${healthReport.mirror.enabledWorkspaces} enabled / ${healthReport.mirror.errorWorkspaces} error / ${healthReport.mirror.missingWorkspaces} missing`
                                  : "unknown"
                              }
                              tone={probeTone(healthReport?.checks.historyMirror ?? "idle")}
                            />
                          </div>
                        </div>
                      ) : null}
                        <div className="pt-1">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="section-kicker">
                              Model Providers
                            </p>
                          <button
                            className="text-xs text-[color:var(--muted-foreground)] transition hover:text-[color:var(--foreground)]"
                            onClick={() => void refreshModelProviders()}
                          >
                            Refresh
                          </button>
                        </div>
                          {modelProviders.length === 0 ? (
                            <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] px-3 py-3 text-xs leading-6 text-[color:var(--muted-foreground)]">
                            暂无 provider 列表。
                            </div>
                          ) : (
                            <div className="space-y-2">
                            {modelProviders.map((provider) => (
                              <div
                                key={provider.id}
                                className="subtle-panel rounded-[18px] border border-[color:var(--border)] px-3 py-3"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge>{provider.id}</Badge>
                                  <span className="text-xs text-[color:var(--muted-foreground)]">{provider.packageName}</span>
                                  <span className="text-xs text-[color:var(--muted-foreground)]">
                                    {provider.requiresUrl ? "requires url" : "url optional"}
                                  </span>
                                </div>
                                <p className="mt-2 text-sm leading-6 text-[color:var(--foreground)]">{provider.description}</p>
                                <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">
                                  {provider.useCases.join(" · ")}
                                </p>
                              </div>
                            ))}
                            </div>
                          )}
                        </div>
                      </div>
                  ) : null}
                </div>
              </div>
            </Card>
          </aside>

          <section className="min-w-0 xl:min-h-0">
            <Card className="shell-card overflow-hidden xl:h-full">
              <div className="flex h-full flex-col">
                <div className={cn("surface-header", mainViewMode === "conversation" ? "px-4 py-2.5" : "px-5 py-4")}>
                  <div className="surface-brow">
                    <div className="surface-toolbar">
                      <div className="min-w-0">
                        {mainViewMode === "inspector" ? <p className="section-kicker">Detailed Inspection</p> : null}
                        <h1
                          className={cn(
                            "truncate font-semibold tracking-[-0.04em] text-[color:var(--foreground)]",
                            mainViewMode === "conversation" ? "text-[20px]" : "text-[28px]"
                          )}
                        >
                          {mainViewMode === "conversation" ? (hasActiveSession ? currentSessionName : currentWorkspaceName) : "Inspector"}
                        </h1>
                        <p className={cn("truncate text-[color:var(--muted-foreground)]", mainViewMode === "conversation" ? "mt-0.5 text-xs" : "text-sm")}>
                          {mainViewMode === "conversation" ? (hasActiveSession ? `Workspace ${currentWorkspaceName}` : "Select a session to open the conversation surface.") : inspectorSubtitle}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="segmented-shell">
                          <InspectorTabButton
                            label="Conversation"
                            active={mainViewMode === "conversation"}
                            onClick={() => setMainViewMode("conversation")}
                          />
                          <InspectorTabButton
                            label="Inspector"
                            active={mainViewMode === "inspector"}
                            onClick={() => setMainViewMode("inspector")}
                          />
                        </div>
                        {mainViewMode === "inspector" && latestEvent ? <Badge>{latestEvent.event}</Badge> : null}
                      </div>
                    </div>

                    {(mainViewMode === "conversation" ? hasActiveSession : inspectorTab !== "overview") ? (
                      <div className={cn("surface-meta", mainViewMode === "conversation" ? "gap-1.5" : null)}>
                        <span className={cn("info-chip", mainViewMode === "conversation" ? "px-2.5 py-1 text-[11px]" : null)}>
                          <span className="operator-dot" />
                          {hasActiveSession ? `session ${session?.id ?? "n/a"}` : `workspace ${(workspace?.id ?? workspaceId) || "n/a"}`}
                        </span>
                        {mainViewMode === "inspector" ? (
                          <span className="info-chip">
                            <span className="operator-dot" />
                            run {selectedRunId || run?.id || "n/a"}
                          </span>
                        ) : selectedRunId ? (
                          <span className={cn("info-chip", "px-2.5 py-1 text-[11px]")}>
                            <span className="operator-dot" />
                            run {selectedRunId}
                          </span>
                        ) : null}
                        {hasActiveSession ? (
                          <span className={cn("info-chip", mainViewMode === "conversation" ? "px-2.5 py-1 text-[11px]" : null)}>
                            <span className="operator-dot" />
                            {session?.activeAgentName ?? run?.effectiveAgentName ?? "no agent"}
                          </span>
                        ) : null}
                        {mainViewMode === "inspector" ? (
                          <>
                            <span className="info-chip">
                              <span className="operator-dot" />
                              {runSteps.length} steps
                            </span>
                            <span className="info-chip">
                              <span className="operator-dot" />
                              {deferredEvents.length} events
                            </span>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {mainViewMode === "inspector" ? (
                      <div className="inspector-tabbar">
                        <div className="segmented-shell flex flex-wrap gap-2">
                          <InspectorTabButton
                            label="Overview"
                            active={inspectorTab === "overview"}
                            onClick={() => setInspectorTab("overview")}
                          />
                          <InspectorTabButton
                            label="Context"
                            active={inspectorTab === "context"}
                            onClick={() => setInspectorTab("context")}
                          />
                          <InspectorTabButton
                            label="Calls"
                            active={inspectorTab === "calls"}
                            onClick={() => setInspectorTab("calls")}
                          />
                          <InspectorTabButton
                            label="Runtime"
                            active={inspectorTab === "runtime"}
                            onClick={() => setInspectorTab("runtime")}
                          />
                          <InspectorTabButton label="Catalog" active={inspectorTab === "catalog"} onClick={() => setInspectorTab("catalog")} />
                          <InspectorTabButton label="Model" active={inspectorTab === "model"} onClick={() => setInspectorTab("model")} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {mainViewMode === "conversation" ? (
                  <div className="conversation-stage">
                    <div
                      ref={conversationThreadRef}
                      className="conversation-thread xl:min-h-0"
                      onScroll={(event) => {
                        const element = event.currentTarget;
                        const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                        shouldAutoFollowConversationRef.current = distanceToBottom < 120;
                      }}
                    >
                      <div className="conversation-thread-inner">
                        {!hasActiveSession ? (
                          <div className="flex h-full items-center justify-center px-6 py-16">
                            <div className="workbench-panel max-w-xl rounded-[30px] px-8 py-10 text-center">
                              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[color:var(--accent)] text-[color:var(--accent-foreground)] shadow-[0_10px_24px_rgba(10,23,48,0.22)]">
                                <Folder className="h-5 w-5" />
                              </div>
                              <p className="section-kicker">Workspace Surface</p>
                              <h2 className="surface-title mt-2 text-2xl font-semibold text-[color:var(--foreground)]">No session selected</h2>
                              <p className="mt-3 text-sm leading-7 text-[color:var(--muted-foreground)]">
                                当前已切换到 workspace <span className="font-medium text-[color:var(--foreground)]">{currentWorkspaceName}</span>，但还没有选中 session。
                                请在左侧选择一个 session，或先创建新的 session，再进入对话视图。
                              </p>
                            </div>
                          </div>
                        ) : messageFeed.length === 0 ? (
                          <div className="flex h-full items-center justify-center px-6 py-16">
                            <div className="workbench-panel max-w-xl rounded-[30px] px-8 py-10 text-center">
                              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[color:var(--accent)] text-[color:var(--accent-foreground)] shadow-[0_10px_24px_rgba(10,23,48,0.22)]">
                                <Bot className="h-5 w-5" />
                              </div>
                              <p className="section-kicker">Conversation Surface</p>
                              <h2 className="surface-title mt-2 text-2xl font-semibold text-[color:var(--foreground)]">Ready to chat</h2>
                              <p className="mt-3 text-sm leading-7 text-[color:var(--muted-foreground)]">选择 workspace 和 session 后，这里会按时间线展示对话、实时输出以及可跳转到对应 run 的上下文入口。</p>
                            </div>
                          </div>
                        ) : (
                          messageFeed.map((message) => {
                            const isUser = message.role === "user";
                            const isStreaming = message.id.startsWith("live:");

                            return (
                              <article key={message.id} className="conversation-row">
                                <div
                                  className={cn(
                                    "conversation-avatar",
                                    isUser ? "bg-[rgba(19,35,63,0.08)] text-[color:var(--foreground)]" : "bg-[color:var(--accent)] text-[color:var(--accent-foreground)]"
                                  )}
                                >
                                  {isUser ? "U" : "AI"}
                                </div>
                                <div className="min-w-0">
                                  <div
                                    className={cn(
                                      "conversation-bubble",
                                      isUser ? "conversation-bubble-user" : "conversation-bubble-assistant"
                                    )}
                                  >
                                    <div className="mb-3 flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-medium text-[color:var(--foreground)]">{isUser ? "You" : "Assistant"}</span>
                                      {message.runId ? (
                                        <button
                                          className="rounded-full border border-[color:var(--border)] bg-white px-2.5 py-1 text-[11px] text-[color:var(--muted-foreground)] transition hover:border-black/10 hover:text-[color:var(--foreground)]"
                                          onClick={() => {
                                            setSelectedRunId(message.runId ?? "");
                                            setMainViewMode("inspector");
                                            setInspectorTab("calls");
                                            void Promise.all([refreshRun(message.runId, true), refreshRunSteps(message.runId, true)]);
                                          }}
                                        >
                                          {message.runId}
                                        </button>
                                      ) : null}
                                      <MessageToolRefChips content={message.content} />
                                      {isStreaming ? <span className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">Streaming</span> : null}
                                      <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                                    </div>
                                    <MessageContentDetail content={message.content} maxHeightClassName="max-h-[28rem]" />
                                  </div>
                                </div>
                              </article>
                            );
                          })
                        )}
                        <div ref={conversationTailRef} aria-hidden="true" />
                      </div>
                    </div>

                    {hasActiveSession ? (
                      <div className="conversation-composer-wrap">
                        <div className="conversation-composer-shell p-3">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-2 pt-1">
                            <div>
                              <p className="section-kicker">Composer</p>
                              <p className="text-sm text-[color:var(--foreground)]">在当前 session 里继续提问、追问或触发下一轮执行。</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted-foreground)]">
                              {selectedRunId ? <span className="info-chip">{`Run ${selectedRunId}`}</span> : null}
                              <span className="info-chip">{`${messages.length} stored`}</span>
                            </div>
                          </div>
                            <Textarea
                              value={draftMessage}
                              onChange={(event) => setDraftMessage(event.target.value)}
                              placeholder="Message the current session"
                              className="min-h-28 border-0 bg-transparent px-1 py-1 shadow-none focus:ring-0"
                            />
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-2 pb-1">
                              <p className="text-xs text-[color:var(--muted-foreground)]">
                                输入区保持简洁；tool、step、model payload 请在 Inspector 里查看。
                              </p>
                              <div className="flex gap-2">
                                <Button variant="ghost" size="sm" onClick={() => void refreshMessages()}>
                                  <RefreshCw className="h-4 w-4" />
                                  Refresh
                                </Button>
                                <Button className="min-w-[92px]" onClick={() => void sendMessage()}>
                                  <Send className="h-4 w-4" />
                                  Send
                                </Button>
                              </div>
                            </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="inspector-stage space-y-3 xl:min-h-0">
                    <div className="inspector-summary px-5 py-5">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="section-kicker">Inspection Surface</p>
                          <h2 className="surface-title text-[24px] font-semibold text-[color:var(--foreground)]">
                            {inspectorTab === "overview"
                              ? "Runtime overview"
                              : inspectorTab === "context"
                                ? "Prompt and messages"
                                : inspectorTab === "calls"
                                  ? "Model calls"
                                  : inspectorTab === "runtime"
                                    ? "Execution timeline"
                                    : inspectorTab === "catalog"
                                      ? "Workspace catalog"
                                      : "Model gateway"}
                          </h2>
                          <p className="mt-2 max-w-2xl text-sm leading-7 text-[color:var(--muted-foreground)]">
                            这里专门用来核对 message list、tool payload、run step 和运行记录。先看摘要，再按分栏深入，不和 Conversation 争抢主工作面。
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {session?.id ? <Badge>{session.id}</Badge> : null}
                          {selectedRunId || run?.id ? <Badge>{selectedRunId || run?.id}</Badge> : null}
                          {run?.status ? <Badge className={statusTone(run.status)}>{run.status}</Badge> : null}
                        </div>
                      </div>
                      <div className="inspector-summary-grid mt-5 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="conversation-stat">
                          <p className="section-kicker">Messages</p>
                          <p className="mt-2 text-lg font-semibold text-[color:var(--foreground)]">{messages.length}</p>
                        </div>
                        <div className="conversation-stat">
                          <p className="section-kicker">Model Calls</p>
                          <p className="mt-2 text-lg font-semibold text-[color:var(--foreground)]">{modelCallTraces.length}</p>
                        </div>
                        <div className="conversation-stat">
                          <p className="section-kicker">Run Steps</p>
                          <p className="mt-2 text-lg font-semibold text-[color:var(--foreground)]">{runSteps.length}</p>
                        </div>
                        <div className="conversation-stat">
                          <p className="section-kicker">Events</p>
                          <p className="mt-2 text-lg font-semibold text-[color:var(--foreground)]">{deferredEvents.length}</p>
                        </div>
                      </div>
                    </div>

                    {inspectorTab === "overview" ? (
                      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
                        <div className="space-y-3">
                          <InspectorOverviewCard
                            session={session}
                            run={run}
                            workspace={workspace}
                            sessionName={currentSessionName}
                            workspaceName={currentWorkspaceName}
                            selectedRunId={selectedRunId}
                            onSelectedRunIdChange={setSelectedRunId}
                            onRefreshRun={() => void refreshRun()}
                            onRefreshRunSteps={() => void refreshRunSteps()}
                            onCancelRun={() => void cancelCurrentRun()}
                            modelCallCount={modelCallTraces.length}
                            stepCount={runSteps.length}
                            eventCount={deferredEvents.length}
                            messageCount={messages.length}
                            latestEvent={latestEvent}
                          />
                          <OverviewRecordsCard run={run} session={session} workspace={workspace} />
                        </div>
                        <div className="space-y-3">
                          <RuntimeActivityCard
                            latestEvent={latestEvent}
                            events={deferredEvents}
                            runSteps={runSteps}
                            messages={messages}
                            latestTrace={latestModelCallTrace}
                          />
                        </div>
                      </div>
                    ) : null}

                    {inspectorTab === "context" ? (
                      <ContextWorkbench
                        systemMessages={composedSystemMessages}
                        firstTrace={firstModelCallTrace}
                        messages={messages}
                        selectedMessage={selectedSessionMessage}
                        onSelectMessage={setSelectedMessageId}
                      />
                    ) : null}

                    {inspectorTab === "calls" ? (
                      <CallsWorkbench
                        traces={modelCallTraces}
                        selectedTrace={selectedModelCallTrace}
                        onSelectTrace={setSelectedTraceId}
                        latestTrace={latestModelCallTrace}
                        latestModelMessageCounts={latestModelMessageCounts}
                        resolvedModelNames={resolvedModelNames}
                        resolvedModelRefs={resolvedModelRefs}
                        runtimeTools={allRuntimeTools}
                        runtimeToolNames={allRuntimeToolNames}
                        activeToolNames={allAdvertisedToolNames}
                        toolServers={allToolServers}
                        onDownload={downloadSessionTrace}
                      />
                    ) : null}

                    {inspectorTab === "runtime" ? (
                      <RuntimeWorkbench
                        mode={runtimeInspectorMode}
                        onModeChange={setRuntimeInspectorMode}
                        steps={runSteps}
                        selectedStep={selectedRunStep}
                        onSelectStep={setSelectedStepId}
                        events={deferredEvents}
                        selectedEvent={selectedSessionEvent}
                        onSelectEvent={setSelectedEventId}
                      />
                    ) : null}

                    {inspectorTab === "catalog" ? (
                      catalog ? (
                        <>
                          {workspace ? (
                            <div className="panel-card rounded-[20px] border p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-[color:var(--foreground)]">Mirror Sync</p>
                                  <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">
                                    将中心历史异步同步到当前 workspace 的 <code>.openharness/data/history.db</code>。
                                  </p>
                                </div>
                                <Badge className={workspace.historyMirrorEnabled ? "bg-emerald-600 text-white" : ""}>
                                  {workspace.historyMirrorEnabled ? "Enabled" : "Disabled"}
                                </Badge>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                  variant={workspace.historyMirrorEnabled ? "secondary" : "default"}
                                  size="sm"
                                  disabled={mirrorToggleBusy || workspace.kind !== "project" || workspace.historyMirrorEnabled}
                                  onClick={() => void updateWorkspaceHistoryMirrorEnabled(true)}
                                >
                                  Enable
                                </Button>
                                <Button
                                  variant={!workspace.historyMirrorEnabled ? "secondary" : "default"}
                                  size="sm"
                                  disabled={mirrorToggleBusy || workspace.kind !== "project" || !workspace.historyMirrorEnabled}
                                  onClick={() => void updateWorkspaceHistoryMirrorEnabled(false)}
                                >
                                  Disable
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={mirrorToggleBusy || mirrorRebuildBusy}
                                  onClick={() => void refreshWorkspace(workspace.id, true)}
                                >
                                  Refresh
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={mirrorRebuildBusy || mirrorToggleBusy || workspace.kind !== "project" || !workspace.historyMirrorEnabled}
                                  onClick={() => void rebuildWorkspaceHistoryMirror()}
                                >
                                  Rebuild
                                </Button>
                              </div>
                              {mirrorStatus ? (
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                  <CatalogLine label="mirrorState" value={mirrorStatus.state} />
                                  <CatalogLine label="lastEventId" value={mirrorStatus.lastEventId ? String(mirrorStatus.lastEventId) : "n/a"} />
                                  <CatalogLine label="lastSyncedAt" value={mirrorStatus.lastSyncedAt ? formatTimestamp(mirrorStatus.lastSyncedAt) : "n/a"} />
                                  <CatalogLine label="dbPath" value={mirrorStatus.dbPath ?? "n/a"} />
                                </div>
                              ) : null}
                              {mirrorStatus?.errorMessage ? (
                                <div className="mt-3 rounded-[18px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-700">
                                  {mirrorStatus.errorMessage}
                                </div>
                              ) : null}
                              {workspace.kind !== "project" ? (
                                <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">
                                  `chat` workspace 不支持本地 history mirror。
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="grid gap-2">
                            <CatalogLine label="agents" value={catalog.agents.length} />
                            <CatalogLine label="models" value={catalog.models.length} />
                            <CatalogLine label="actions" value={catalog.actions.length} />
                            <CatalogLine label="skills" value={catalog.skills.length} />
                            <CatalogLine label="tools" value={catalog.tools?.length ?? catalog.mcp?.length ?? 0} />
                            <CatalogLine label="hooks" value={catalog.hooks.length} />
                            <CatalogLine label="nativeTools" value={catalog.nativeTools.length} />
                          </div>
                          <EntityPreview title={catalog.workspaceId} data={catalog} />
                        </>
                      ) : (
                        <EmptyState title="No catalog" description="Load a workspace first." />
                      )
                    ) : null}

                    {inspectorTab === "model" ? (
                      <div className="space-y-3">
                        <Input
                          value={modelDraft.model}
                          onChange={(event) =>
                            setModelDraft((current) => ({
                              ...current,
                              model: event.target.value
                            }))
                          }
                          placeholder="Model"
                        />
                        <Textarea
                          value={modelDraft.prompt}
                          onChange={(event) =>
                            setModelDraft((current) => ({
                              ...current,
                              prompt: event.target.value
                            }))
                          }
                          className="min-h-28"
                          placeholder="Prompt"
                        />
                        <Button onClick={() => void generateOnce()} disabled={generateBusy}>
                          <Sparkles className="h-4 w-4" />
                          Generate
                        </Button>
                        {generateOutput ? <EntityPreview title={generateOutput.model} data={generateOutput} /> : <EmptyState title="No output" description="Generate output appears here." />}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </Card>
          </section>
        </section>
        )}
      </div>
    </main>
  );
}

function WorkspaceSidebarItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  sessionCount: number;
  canRemove: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[20px] border px-3 py-3 transition",
        props.active
          ? "border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,243,249,0.92))] shadow-[0_12px_24px_rgba(21,35,58,0.08)]"
          : "border-transparent hover:border-[color:var(--border)] hover:bg-[rgba(255,255,255,0.64)]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-[14px] transition",
            props.active ? "bg-[color:var(--accent)] text-white shadow-[0_10px_18px_rgba(10,23,48,0.22)]" : "bg-[rgba(19,35,63,0.06)] text-[color:var(--muted-foreground)]"
          )}
        >
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.name}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.template ? `${props.entry.template} · ` : ""}
            {props.sessionCount} sessions
          </p>
        </div>
      </button>
      {props.canRemove ? (
        <button
          className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
          onClick={props.onRemove}
          title="删除 workspace"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function SessionSidebarItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[20px] border px-3 py-3 transition",
        props.active
          ? "border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,243,249,0.92))] shadow-[0_12px_24px_rgba(21,35,58,0.08)]"
          : "border-transparent hover:border-[color:var(--border)] hover:bg-[rgba(255,255,255,0.64)]"
      )}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-1 rounded-full transition", props.active ? "bg-[color:var(--accent)]" : "bg-transparent")} />
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-[14px] transition",
            props.active ? "bg-[color:var(--accent)] text-white shadow-[0_10px_18px_rgba(10,23,48,0.22)]" : "bg-[rgba(19,35,63,0.06)] text-[color:var(--muted-foreground)]"
          )}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[color:var(--foreground)]">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-[color:var(--muted-foreground)]">
            {props.entry.agentName ? `${props.entry.agentName} · ` : ""}
            {formatTimestamp(props.entry.createdAt)}
          </p>
        </div>
      </button>
      <button
        className="rounded-lg p-2 text-[color:var(--muted-foreground)] opacity-0 transition hover:bg-black/4 hover:text-[color:var(--foreground)] group-hover:opacity-100"
        onClick={props.onRemove}
        title="从本地侧栏移除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToggleChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-foreground)] shadow-[0_10px_20px_rgba(10,23,48,0.18)]"
          : "border-[color:var(--border)] bg-[rgba(255,255,255,0.72)] text-[color:var(--muted-foreground)] hover:border-[rgba(19,35,63,0.16)] hover:text-[color:var(--foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InspectorTabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-[14px] px-3.5 py-2 text-xs font-medium transition",
        props.active
          ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(241,245,251,0.92))] text-[color:var(--foreground)] shadow-[0_10px_18px_rgba(21,35,58,0.09)]"
          : "text-[color:var(--muted-foreground)] hover:bg-white/60 hover:text-[color:var(--foreground)]"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InsightRow(props: { label: string; value: string }) {
  return (
    <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">{props.label}</p>
      <p className="mt-2 truncate text-[15px] font-semibold text-[color:var(--foreground)]">{props.value}</p>
    </div>
  );
}

function EntityPreview(props: { title: string; data: unknown }) {
  return (
    <div className="panel-card overflow-hidden rounded-[24px] border">
      <div className="subtle-panel border-b border-[color:var(--border)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-72 overflow-auto p-4 text-xs leading-6 text-slate-700">{prettyJson(props.data)}</pre>
    </div>
  );
}

function JsonBlock(props: { title: string; value: unknown }) {
  return (
    <div className="panel-card overflow-hidden rounded-[22px] border">
      <div className="subtle-panel border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
        {props.title}
      </div>
      <pre className="max-h-64 overflow-auto p-3 text-xs leading-6 text-slate-700">{prettyJson(props.value)}</pre>
    </div>
  );
}

function modelMessageTone(role: Message["role"]) {
  switch (role) {
    case "system":
      return "bg-slate-900 text-white";
    case "user":
      return "bg-sky-100 text-sky-700";
    case "assistant":
      return "bg-emerald-100 text-emerald-700";
    case "tool":
      return "bg-amber-100 text-amber-700";
    default:
      return "";
  }
}

function PayloadValueView(props: {
  value: unknown;
  maxHeightClassName?: string | undefined;
  mode?: "input" | "result" | undefined;
}) {
  const kindLabel =
    props.value === null
      ? "null"
      : Array.isArray(props.value)
        ? "array"
        : typeof props.value === "object"
          ? "object"
          : typeof props.value;
  const sizeLabel =
    Array.isArray(props.value)
      ? `${props.value.length} items`
      : isRecord(props.value)
        ? `${Object.keys(props.value).length} keys`
        : undefined;

  if (typeof props.value === "string") {
    const lineCount = props.value.length === 0 ? 0 : props.value.split(/\r?\n/u).length;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge>{props.mode === "result" ? "text result" : "text payload"}</Badge>
          <Badge>{`${lineCount} lines`}</Badge>
          <Badge>{`${props.value.length} chars`}</Badge>
        </div>
        <div className="rounded-[16px] border border-[color:var(--border)] bg-[rgba(248,250,252,0.9)] p-3">
          <pre
            className={cn(
              "overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700",
              props.maxHeightClassName
            )}
          >
            {props.value}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge>{props.mode === "result" ? "structured result" : "structured payload"}</Badge>
        <Badge>{kindLabel}</Badge>
        {sizeLabel ? <Badge>{sizeLabel}</Badge> : null}
      </div>
      <div className="rounded-[16px] border border-[color:var(--border)] bg-[rgba(248,250,252,0.9)] p-3">
        <pre className={cn("overflow-auto text-xs leading-6 text-slate-700", props.maxHeightClassName)}>{prettyJson(props.value)}</pre>
      </div>
    </div>
  );
}

function compactPreviewText(value: Message["content"], limit = 120) {
  const compact = contentPreview(value, limit).replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact || " ";
  }

  return `${compact.slice(0, limit)}...`;
}

function buildAiSdkToolsObject(tools: ModelCallTraceRuntimeTool[]) {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
      }
    ])
  );
}

function buildAiSdkLikeRequest(trace: ModelCallTrace | null) {
  if (!trace) {
    return null;
  }

  return {
    model: trace.input.model ?? null,
    canonicalModelRef: trace.input.canonicalModelRef ?? null,
    provider: trace.input.provider ?? null,
    ...(trace.input.temperature !== undefined ? { temperature: trace.input.temperature } : {}),
    ...(trace.input.maxTokens !== undefined ? { maxTokens: trace.input.maxTokens } : {}),
    messages: trace.input.messages,
    tools: buildAiSdkToolsObject(trace.input.runtimeTools),
    activeTools: trace.input.activeToolNames,
    toolServers: trace.input.toolServers
  };
}

function buildAiSdkLikeStoredMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    _meta: {
      id: message.id,
      sessionId: message.sessionId,
      ...(message.runId ? { runId: message.runId } : {}),
      createdAt: message.createdAt,
      ...(message.metadata ? { metadata: message.metadata } : {})
    }
  }));
}

function InspectorPanelHeader(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="surface-title text-base font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <p className="mt-1 max-w-2xl text-xs leading-6 text-[color:var(--muted-foreground)]">{props.description}</p>
      </div>
      {props.action ? <div className="shrink-0">{props.action}</div> : null}
    </div>
  );
}

function MessageToolRefChips(props: { content: Message["content"] }) {
  const refs = contentToolRefs(props.content);
  if (refs.length === 0) {
    return null;
  }

  return (
    <>
      {refs.map((ref, index) => (
        <Badge key={`${ref.type}:${ref.toolCallId}:${index}`}>{`${ref.type}:${ref.toolName}`}</Badge>
      ))}
    </>
  );
}

function MessageContentDetail(props: { content: Message["content"]; maxHeightClassName?: string }) {
  if (typeof props.content === "string") {
    return (
      <pre className={cn("overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700", props.maxHeightClassName)}>
        {props.content}
      </pre>
    );
  }

  if (props.content.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">Empty message parts.</p>;
  }

  return (
    <div className="space-y-2">
      {props.content.map((part, index) => (
        <div key={`${part.type}:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <Badge>{part.type}</Badge>
            {"toolName" in part ? <Badge>{part.toolName}</Badge> : null}
            {"toolCallId" in part ? <Badge>{part.toolCallId}</Badge> : null}
          </div>
          {part.type === "text" ? (
            <pre className={cn("overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700", props.maxHeightClassName)}>
              {part.text}
            </pre>
          ) : part.type === "tool-call" ? (
            <PayloadValueView value={part.input ?? {}} maxHeightClassName={props.maxHeightClassName} mode="input" />
          ) : (
            <PayloadValueView value={part.output} maxHeightClassName={props.maxHeightClassName} mode="result" />
          )}
        </div>
      ))}
    </div>
  );
}

function InspectorDisclosure(props: {
  title: string;
  description?: string;
  badge?: string | number;
  children: ReactNode;
}) {
  return (
    <details className="workbench-panel overflow-hidden rounded-[20px]">
      <summary className="list-none cursor-pointer px-4 py-3 transition hover:bg-[rgba(244,248,252,0.55)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[color:var(--foreground)]">{props.title}</p>
            {props.description ? <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">{props.description}</p> : null}
          </div>
          {props.badge !== undefined ? <Badge>{String(props.badge)}</Badge> : null}
        </div>
      </summary>
      <div className="border-t border-[color:var(--border)] p-3">{props.children}</div>
    </details>
  );
}

function ToolNameChips(props: { names: string[]; emptyLabel: string }) {
  if (props.names.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {props.names.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
    </div>
  );
}

function RuntimeToolList(props: { tools: ModelCallTraceRuntimeTool[] }) {
  if (props.tools.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No runtime tool definitions recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.tools.map((tool) => (
        <div key={tool.name} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{tool.name}</Badge>
            {tool.retryPolicy ? <Badge>{tool.retryPolicy}</Badge> : null}
          </div>
          {tool.description ? <p className="mt-2 text-xs leading-6 text-slate-700">{tool.description}</p> : null}
          {"inputSchema" in tool ? (
            <div className="mt-3">
              <JsonBlock title="Input Schema" value={tool.inputSchema} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ToolServerList(props: { servers: ModelCallTraceToolServer[] }) {
  if (props.servers.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No external tool server metadata recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.servers.map((server) => (
        <div key={server.name} className="subtle-panel rounded-[16px] border border-[color:var(--border)] px-3 py-2 text-xs leading-6 text-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{server.name}</Badge>
            {server.transportType ? <Badge>{server.transportType}</Badge> : null}
            {server.toolPrefix ? <Badge>{server.toolPrefix}</Badge> : null}
            {server.timeout !== undefined ? <Badge>{`${server.timeout}ms`}</Badge> : null}
          </div>
          {server.include && server.include.length > 0 ? <p className="mt-2">include: {server.include.join(", ")}</p> : null}
          {server.exclude && server.exclude.length > 0 ? <p className="mt-1">exclude: {server.exclude.join(", ")}</p> : null}
        </div>
      ))}
    </div>
  );
}

function ModelMessageList(props: { traceId: string; messages: ModelCallTraceMessage[] }) {
  if (props.messages.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No recorded model-facing messages.</p>;
  }

  return (
    <div className="space-y-2">
      {props.messages.map((message, index) => (
        <div key={`${props.traceId}:message:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
              {message.role}
            </span>
            <MessageToolRefChips content={message.content} />
          </div>
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-72" />
        </div>
      ))}
    </div>
  );
}

function ContextWorkbench(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
  selectedMessage: Message | null;
  onSelectMessage: (messageId: string) => void;
}) {
  const combinedSystemPrompt = props.systemMessages.map((message) => contentText(message.content)).join("\n\n");

  return (
    <section className="space-y-3">
      <section className="panel-card space-y-3 rounded-[24px] border p-4">
        <InspectorPanelHeader
          title="System Prompt"
          description="这里显示真正发给模型的合成后 system prompt。当前 runtime 会把多个 system message 用空行连接后发送。"
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <InsightRow label="Source Step" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
          <InsightRow label="Message Count" value={String(props.systemMessages.length)} />
          <InsightRow label="Characters" value={String(combinedSystemPrompt.length)} />
        </div>
        {combinedSystemPrompt.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect the composed system prompt." />
        ) : (
          <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-4">
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{combinedSystemPrompt}</pre>
          </div>
        )}
      </section>

      <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
        <section className="panel-card space-y-3 rounded-[24px] border p-4">
          <InspectorPanelHeader
            title="Session Message Timeline"
            description="左侧先定位一条消息，再在右侧看完整内容、metadata 和关联 run/tool 信息。"
          />
          <div className="space-y-2">
            {props.messages.length === 0 ? (
              <EmptyState title="No messages" description="Open a session to inspect stored message records." />
            ) : (
              props.messages.map((message) => (
                <button
                  key={message.id}
                  className={cn(
                    "w-full rounded-[18px] border p-3 text-left transition",
                    props.selectedMessage?.id === message.id
                      ? "border-[rgba(19,35,63,0.14)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(238,243,250,0.92))] shadow-[0_10px_24px_rgba(21,35,58,0.06)]"
                      : "border-[color:var(--border)] bg-[rgba(255,255,255,0.72)] hover:bg-[rgba(247,250,253,0.94)]"
                  )}
                  onClick={() => props.onSelectMessage(message.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{message.role}</Badge>
                    {message.runId ? <Badge>{message.runId}</Badge> : null}
                    <MessageToolRefChips content={message.content} />
                    <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                  </div>
                  <p className="text-sm leading-6 text-[color:var(--foreground)]">{compactPreviewText(message.content)}</p>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="panel-card space-y-3 rounded-[24px] border p-4">
          <InspectorPanelHeader
            title="Message Detail"
            description="查看当前选中消息的完整正文、metadata，以及与 run / tool 的关联字段。"
          />
          {props.selectedMessage ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{props.selectedMessage.role}</Badge>
                {props.selectedMessage.runId ? <Badge>{props.selectedMessage.runId}</Badge> : null}
                <MessageToolRefChips content={props.selectedMessage.content} />
                <Badge>{formatTimestamp(props.selectedMessage.createdAt)}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <InsightRow label="Message ID" value={props.selectedMessage.id} />
                <InsightRow label="Session ID" value={props.selectedMessage.sessionId} />
              </div>
              <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-4">
                <MessageContentDetail content={props.selectedMessage.content} maxHeightClassName="max-h-[28rem]" />
              </div>
              {props.selectedMessage.metadata ? <JsonBlock title="Metadata" value={props.selectedMessage.metadata} /> : null}
            </>
          ) : (
            <EmptyState title="No message selected" description="Choose a message from the left timeline to inspect its full detail." />
          )}
        </section>
      </div>
    </section>
  );
}

function CallsWorkbench(props: {
  traces: ModelCallTrace[];
  selectedTrace: ModelCallTrace | null;
  onSelectTrace: (traceId: string) => void;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
}) {
  return (
    <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
      <div className="space-y-3">
        <LlmSummaryCard
          modelCallCount={props.traces.length}
          latestTrace={props.latestTrace}
          latestModelMessageCounts={props.latestModelMessageCounts}
          resolvedModelNames={props.resolvedModelNames}
          resolvedModelRefs={props.resolvedModelRefs}
          runtimeTools={props.runtimeTools}
          runtimeToolNames={props.runtimeToolNames}
          activeToolNames={props.activeToolNames}
          toolServers={props.toolServers}
          onDownload={props.onDownload}
        />
        <section className="panel-card space-y-3 rounded-[24px] border p-4">
          <InspectorPanelHeader
            title="Model Call List"
            description="左侧先定位一次调用，右侧再看这次调用的完整 message list、tool 调用和原始 payload。"
          />
          {props.traces.length === 0 ? (
            <EmptyState title="No model calls" description="Load run steps to inspect model-facing calls." />
          ) : (
            <div className="space-y-2">
              {props.traces.map((trace) => (
                <button
                  key={trace.id}
                  className={cn(
                    "w-full rounded-[18px] border p-3 text-left transition",
                    props.selectedTrace?.id === trace.id
                      ? "border-[rgba(19,35,63,0.14)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(238,243,250,0.92))] shadow-[0_10px_24px_rgba(21,35,58,0.06)]"
                      : "border-[color:var(--border)] bg-[rgba(255,255,255,0.72)] hover:bg-[rgba(247,250,253,0.94)]"
                  )}
                  onClick={() => props.onSelectTrace(trace.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{`step ${trace.seq}`}</Badge>
                    <Badge>{trace.input.model ?? "n/a"}</Badge>
                    <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {trace.output.toolCalls.length} tool calls · {trace.output.toolResults.length} tool results
                    </p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">{trace.output.finishReason ?? "finish n/a"}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="space-y-3">
        {props.selectedTrace ? (
          <ModelCallTraceCard trace={props.selectedTrace} />
        ) : (
          <EmptyState title="No model call selected" description="Choose a model call from the left list to inspect its full detail." />
        )}
      </div>
    </div>
  );
}

function RuntimeWorkbench(props: {
  mode: "steps" | "events";
  onModeChange: (mode: "steps" | "events") => void;
  steps: RunStep[];
  selectedStep: RunStep | null;
  onSelectStep: (stepId: string) => void;
  events: SessionEventContract[];
  selectedEvent: SessionEventContract | null;
  onSelectEvent: (eventId: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="panel-card rounded-[24px] border p-4">
        <InspectorPanelHeader
          title="Runtime Inspector"
          description="把执行视角收在一个分栏里，切换查看 step timeline 或 SSE event feed。"
        />
        <div className="segmented-shell mt-4">
          <InspectorTabButton label="Steps" active={props.mode === "steps"} onClick={() => props.onModeChange("steps")} />
          <InspectorTabButton label="Events" active={props.mode === "events"} onClick={() => props.onModeChange("events")} />
        </div>
      </div>

      {props.mode === "steps" ? (
        <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.76fr)_minmax(0,1.24fr)]">
          <section className="panel-card space-y-3 rounded-[24px] border p-4">
            <InspectorPanelHeader title="Step List" description="左侧按顺序浏览 step，右侧看选中 step 的完整 input / output。" />
            {props.steps.length === 0 ? (
              <EmptyState title="No steps" description="Run steps appear here after the selected run starts executing." />
            ) : (
              <div className="space-y-2">
                {props.steps.map((step) => (
                  <button
                    key={step.id}
                    className={cn(
                      "w-full rounded-[18px] border p-3 text-left transition",
                      props.selectedStep?.id === step.id
                        ? "border-[rgba(19,35,63,0.14)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(238,243,250,0.92))] shadow-[0_10px_24px_rgba(21,35,58,0.06)]"
                        : "border-[color:var(--border)] bg-[rgba(255,255,255,0.72)] hover:bg-[rgba(247,250,253,0.94)]"
                    )}
                    onClick={() => props.onSelectStep(step.id)}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge>{`step ${step.seq}`}</Badge>
                      <Badge>{step.stepType}</Badge>
                      <Badge className={statusTone(step.status)}>{step.status}</Badge>
                    </div>
                    <p className="text-sm text-[color:var(--foreground)]">{step.name ?? step.stepType}</p>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel-card space-y-3 rounded-[24px] border p-4">
            <InspectorPanelHeader title="Step Detail" description="查看当前选中 step 的完整输入输出。" />
            {props.selectedStep ? (
              props.selectedStep.stepType === "model_call" && toModelCallTrace(props.selectedStep) ? (
                <ModelCallTraceCard trace={toModelCallTrace(props.selectedStep)!} />
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{`step ${props.selectedStep.seq}`}</Badge>
                    <Badge>{props.selectedStep.stepType}</Badge>
                    <Badge className={statusTone(props.selectedStep.status)}>{props.selectedStep.status}</Badge>
                    {props.selectedStep.name ? <Badge>{props.selectedStep.name}</Badge> : null}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <JsonBlock title="Input" value={props.selectedStep.input ?? {}} />
                    <JsonBlock title="Output" value={props.selectedStep.output ?? {}} />
                  </div>
                </>
              )
            ) : (
              <EmptyState title="No step selected" description="Choose a step from the left list to inspect its full payload." />
            )}
          </section>
        </div>
      ) : (
        <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.76fr)_minmax(0,1.24fr)]">
          <section className="panel-card space-y-3 rounded-[24px] border p-4">
            <InspectorPanelHeader title="Event List" description="左侧浏览 SSE 事件，右侧查看选中事件的完整 payload。" />
            {props.events.length === 0 ? (
              <EmptyState title="No events" description="SSE events appear here when the current session emits runtime updates." />
            ) : (
              <div className="space-y-2">
                {props.events.map((event) => (
                  <button
                    key={event.id}
                    className={cn(
                      "w-full rounded-[18px] border p-3 text-left transition",
                      props.selectedEvent?.id === event.id
                        ? "border-[rgba(19,35,63,0.14)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(238,243,250,0.92))] shadow-[0_10px_24px_rgba(21,35,58,0.06)]"
                        : "border-[color:var(--border)] bg-[rgba(255,255,255,0.72)] hover:bg-[rgba(247,250,253,0.94)]"
                    )}
                    onClick={() => props.onSelectEvent(event.id)}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge>{event.event}</Badge>
                      {event.runId ? <Badge>{event.runId}</Badge> : null}
                    </div>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {formatTimestamp(event.createdAt)} · cursor {event.cursor}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel-card space-y-3 rounded-[24px] border p-4">
            <InspectorPanelHeader title="Event Detail" description="查看当前选中 SSE event 的完整 data payload。" />
            {props.selectedEvent ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge>{props.selectedEvent.event}</Badge>
                  {props.selectedEvent.runId ? <Badge>{props.selectedEvent.runId}</Badge> : null}
                  <Badge>{`cursor ${props.selectedEvent.cursor}`}</Badge>
                </div>
                <JsonBlock title={formatTimestamp(props.selectedEvent.createdAt)} value={props.selectedEvent.data} />
              </>
            ) : (
              <EmptyState title="No event selected" description="Choose an event from the left list to inspect its full payload." />
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function InspectorOverviewCard(props: {
  session: Session | null;
  run: Run | null;
  workspace: Workspace | null;
  sessionName: string;
  workspaceName: string;
  selectedRunId: string;
  onSelectedRunIdChange: (value: string) => void;
  onRefreshRun: () => void;
  onRefreshRunSteps: () => void;
  onCancelRun: () => void;
  modelCallCount: number;
  stepCount: number;
  eventCount: number;
  messageCount: number;
  latestEvent: SessionEventContract | undefined;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Inspector Overview"
        description="当前 session / run 的身份、状态、数量统计和常用操作都收在这里，其他分栏只负责深入查看某一类数据。"
      />

      <div className="flex flex-wrap gap-2">
        <Badge>{props.workspaceName}</Badge>
        <Badge>{props.sessionName}</Badge>
        {props.run?.id ? <Badge>{props.run.id}</Badge> : null}
        <Badge className={statusTone(props.run?.status ?? "idle")}>{props.run?.status ?? "no-run"}</Badge>
        {props.latestEvent ? <Badge>{props.latestEvent.event}</Badge> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Workspace" value={props.workspace?.id ?? props.workspaceName} />
        <InsightRow label="Session" value={props.session?.id ?? props.sessionName} />
        <InsightRow label="Run" value={props.run?.id ?? "n/a"} />
        <InsightRow label="Agent" value={props.run?.effectiveAgentName ?? props.session?.activeAgentName ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Run Status" value={props.run?.status ?? "n/a"} />
        <InsightRow label="Workspace Mode" value={props.workspace?.kind ?? "n/a"} />
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Last Updated" value={formatTimestamp(props.run?.heartbeatAt ?? props.run?.endedAt ?? props.session?.updatedAt)} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="messages" value={props.messageCount} />
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="run steps" value={props.stepCount} />
        <CatalogLine label="events" value={props.eventCount} />
      </div>

      <div className="panel-card rounded-[20px] border p-3">
        <p className="section-kicker">Run Control</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <Input
            value={props.selectedRunId}
            onChange={(event) => props.onSelectedRunIdChange(event.target.value)}
            placeholder="Selected run"
          />
          <Button variant="secondary" onClick={props.onRefreshRun}>
            Load Run
          </Button>
          <Button variant="secondary" onClick={props.onRefreshRunSteps}>
            Load Steps
          </Button>
          <Button variant="destructive" onClick={props.onCancelRun}>
            <CircleSlash2 className="h-4 w-4" />
            Cancel
          </Button>
        </div>
        <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">
          用这里统一切换目标 run、刷新 run record / step timeline，或直接发起取消。
        </p>
      </div>
    </section>
  );
}

function OverviewRecordsCard(props: {
  run: Run | null;
  session: Session | null;
  workspace: Workspace | null;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Raw Records"
        description="需要核对数据库记录、接口字段或调试导出内容时，可以直接看这些原始对象。"
      />

      <InspectorDisclosure title="Run Record" description="当前 run 的完整记录。" badge={props.run ? "ready" : "n/a"}>
        {props.run ? <EntityPreview title={props.run.id} data={props.run} /> : <EmptyState title="No run" description="Pick a run from the conversation or load one manually." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Session Record" description="当前 session 的基础字段与状态。" badge={props.session ? "ready" : "n/a"}>
        {props.session ? <EntityPreview title={props.session.id} data={props.session} /> : <EmptyState title="No session" description="Open a session to inspect its record." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Workspace Record" description="当前 workspace 的配置与运行状态。" badge={props.workspace ? "ready" : "n/a"}>
        {props.workspace ? <EntityPreview title={props.workspace.id} data={props.workspace} /> : <EmptyState title="No workspace" description="Select a workspace to inspect its record." />}
      </InspectorDisclosure>
    </section>
  );
}

function RuntimeActivityCard(props: {
  latestEvent: SessionEventContract | undefined;
  events: SessionEventContract[];
  runSteps: RunStep[];
  messages: Message[];
  latestTrace: ModelCallTrace | null;
}) {
  const recentEvents = props.events.slice(0, 5);

  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Activity Snapshot"
        description="先快速看最近的事件、消息和模型调用，再决定去 LLM 还是 Runtime 分栏深挖。"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Last Step" value={props.runSteps.at(-1)?.name ?? props.runSteps.at(-1)?.stepType ?? "n/a"} />
        <InsightRow label="Last Message" value={props.messages.at(-1)?.role ?? "n/a"} />
      </div>

      <InspectorDisclosure
        title="Recent Event Feed"
        description="这里只展示最近几条事件做快速浏览；完整事件流请切到 Runtime 分栏。"
        badge={recentEvents.length}
      >
        {recentEvents.length === 0 ? (
          <EmptyState title="No recent events" description="SSE events will appear here after the session starts producing updates." />
        ) : (
          <div className="space-y-2">
            {recentEvents.map((event) => (
              <div key={event.id} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{event.event}</Badge>
                  {event.runId ? <Badge>{event.runId}</Badge> : null}
                  <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(event.createdAt)}</span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{prettyJson(event.data)}</pre>
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function LlmSummaryCard(props: {
  modelCallCount: number;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="LLM Summary"
        description="这一栏只放模型侧真值：模型解析结果、消息统计、工具注入快照和导出入口。"
        action={
          <Button variant="secondary" size="sm" disabled={props.modelCallCount === 0} onClick={props.onDownload}>
            <Download className="h-4 w-4" />
            Download Session JSON
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={props.latestTrace?.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Provider" value={props.latestTrace?.input.provider ?? "n/a"} />
        <InsightRow label="Latest Finish" value={props.latestTrace?.output.finishReason ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="runtime tools" value={props.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={props.activeToolNames.length} />
        <CatalogLine label="tool servers" value={props.toolServers.length} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow
          label="Latest Call Messages"
          value={`S ${props.latestModelMessageCounts.system} · U ${props.latestModelMessageCounts.user} · A ${props.latestModelMessageCounts.assistant} · T ${props.latestModelMessageCounts.tool}`}
        />
        <InsightRow label="Latest Step" value={props.latestTrace ? `step ${props.latestTrace.seq}` : "n/a"} />
      </div>

      <InspectorDisclosure
        title="Resolved Models"
        description="汇总这次 run 里所有 model call 最终解析到的模型名与 canonical ref。"
        badge={props.resolvedModelNames.length + props.resolvedModelRefs.length}
      >
        <div className="space-y-3">
          <ToolNameChips names={props.resolvedModelNames} emptyLabel="No resolved model names recorded." />
          {props.resolvedModelRefs.length > 0 ? (
            <div className="space-y-2">
              {props.resolvedModelRefs.map((ref) => (
                <div key={ref} className="subtle-panel rounded-[16px] border border-[color:var(--border)] px-3 py-2 text-xs leading-6 text-slate-700">
                  {ref}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--muted-foreground)]">No canonical model refs recorded.</p>
          )}
        </div>
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Tool Snapshot"
        description="工具定义和外部 tool server 信息在这里统一展示，不再在每个 model call 卡片里重复展开。"
        badge={props.runtimeTools.length}
      >
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Names</p>
            <ToolNameChips names={props.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tool Names</p>
            <ToolNameChips names={props.activeToolNames} emptyLabel="No active tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Definitions</p>
            <RuntimeToolList tools={props.runtimeTools} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">External Tool Servers</p>
            <ToolServerList servers={props.toolServers} />
          </div>
        </div>
      </InspectorDisclosure>
    </section>
  );
}

function SessionContextCard(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Session Context"
        description="把模型真正看到的 system prompt，以及 runtime 持久化下来的 session message timeline 放在一起看。"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="System Prompt Source" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
        <InsightRow label="Stored Messages" value={String(props.messages.length)} />
      </div>

      <InspectorDisclosure
        title="Composed System Prompt"
        description="首个 model call 中真正发给模型的 system message 内容。"
        badge={props.systemMessages.length}
      >
        {props.systemMessages.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect system messages." />
        ) : (
          <div className="space-y-2">
            {props.systemMessages.map((message, index) => (
              <div key={`system-prompt:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{index + 1}</Badge>
                  <Badge>system</Badge>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-[28rem]" />
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Stored Session Messages"
        description="runtime 持久化后的 AI SDK 风格消息时间线，直接展示 role + content。"
        badge={props.messages.length}
      >
        {props.messages.length === 0 ? (
          <EmptyState title="No session messages" description="Open a session to inspect stored message records." />
        ) : (
          <div className="space-y-2">
            {props.messages.map((message) => (
              <article key={message.id} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{message.role}</Badge>
                  {message.runId ? <Badge>{message.runId}</Badge> : null}
                  <MessageToolRefChips content={message.content} />
                  <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-48" />
                {message.metadata ? (
                  <div className="mt-3">
                    <JsonBlock title="Metadata" value={message.metadata} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function ModelCallTimelineCard(props: { traces: ModelCallTrace[] }) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Model Call Timeline"
        description="按 step 顺序查看真正送给模型的 message list，以及模型返回的 tool call / tool result / 原始 payload。"
      />
      {props.traces.length === 0 ? (
        <EmptyState title="No LLM trace" description="Load run steps to inspect the exact model-facing message list." />
      ) : (
        <div className="space-y-3">
          {props.traces.map((trace) => (
            <ModelCallTraceCard key={trace.id} trace={trace} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCallTraceCard(props: { trace: ModelCallTrace }) {
  const { trace } = props;

  return (
    <article className="workbench-panel rounded-[22px] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${trace.seq}`}</Badge>
        <Badge>{trace.name ?? trace.input.model ?? "model_call"}</Badge>
        <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
        {trace.agentName ? <Badge>{trace.agentName}</Badge> : null}
        {trace.input.provider ? <Badge>{trace.input.provider}</Badge> : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Model" value={trace.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={trace.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Messages" value={String(trace.input.messageCount ?? trace.input.messages.length)} />
        <InsightRow label="Finish" value={trace.output.finishReason ?? "n/a"} />
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="runtime tools" value={trace.input.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={trace.input.activeToolNames.length} />
        <CatalogLine label="tool calls" value={trace.output.toolCalls.length} />
        <CatalogLine label="tool results" value={trace.output.toolResults.length} />
      </div>

      {(trace.output.stepType || trace.output.usage) ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <InsightRow label="AI SDK Step" value={trace.output.stepType ?? "n/a"} />
          <InsightRow
            label="Input Tokens"
            value={typeof trace.output.usage?.inputTokens === "number" ? String(trace.output.usage.inputTokens) : "n/a"}
          />
          <InsightRow
            label="Output Tokens"
            value={typeof trace.output.usage?.outputTokens === "number" ? String(trace.output.usage.outputTokens) : "n/a"}
          />
          <InsightRow
            label="Total Tokens"
            value={typeof trace.output.usage?.totalTokens === "number" ? String(trace.output.usage.totalTokens) : "n/a"}
          />
        </div>
      ) : null}

      {trace.output.text ? (
        <div className="mt-3 rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Assistant Reply</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{trace.output.text}</pre>
        </div>
      ) : null}

      {trace.input.activeToolNames.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tools In This Call</p>
          <ToolNameChips names={trace.input.activeToolNames} emptyLabel="No active tool names recorded." />
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <InspectorDisclosure
          title="LLM Messages"
          description="这一段就是当前 step 真正送给模型的 message list。"
          badge={trace.input.messages.length}
        >
          <ModelMessageList traceId={trace.id} messages={trace.input.messages} />
        </InspectorDisclosure>

        {(trace.output.toolCalls.length > 0 || trace.output.toolResults.length > 0) ? (
          <InspectorDisclosure
            title="Tool Calls And Results"
            description="查看这次 model call 产生的 tool 调用参数，以及回填给模型的结果。"
            badge={trace.output.toolCalls.length + trace.output.toolResults.length}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Calls</p>
                {trace.output.toolCalls.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool calls recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolCalls.map((toolCall, index) => (
                      <div key={`${trace.id}:tool-call:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolCall.toolName ?? "unknown"}</Badge>
                          {toolCall.toolCallId ? <Badge>{toolCall.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolCall.input ?? {}} maxHeightClassName="max-h-56" mode="input" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Results</p>
                {trace.output.toolResults.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool results recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolResults.map((toolResult, index) => (
                      <div key={`${trace.id}:tool-result:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolResult.toolName ?? "unknown"}</Badge>
                          {toolResult.toolCallId ? <Badge>{toolResult.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolResult.output} maxHeightClassName="max-h-56" mode="result" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </InspectorDisclosure>
        ) : null}

        <InspectorDisclosure
          title="Raw Step Payload"
          description="保留原始 step.input / step.output，便于核对 audit 记录。"
          badge="raw"
        >
          <div className="space-y-2">
            {trace.output.content && trace.output.content.length > 0 ? <JsonBlock title="AI SDK Content" value={trace.output.content} /> : null}
            {trace.output.request ? <JsonBlock title="AI SDK Request" value={trace.output.request} /> : null}
            {trace.output.response ? <JsonBlock title="AI SDK Response" value={trace.output.response} /> : null}
            {trace.output.providerMetadata ? <JsonBlock title="Provider Metadata" value={trace.output.providerMetadata} /> : null}
            {trace.output.warnings && trace.output.warnings.length > 0 ? <JsonBlock title="Warnings" value={trace.output.warnings} /> : null}
            <JsonBlock title="Raw Input" value={trace.rawInput ?? {}} />
            <JsonBlock title="Raw Output" value={trace.rawOutput ?? {}} />
          </div>
        </InspectorDisclosure>
      </div>
    </article>
  );
}

function RunStepsCard(props: { steps: RunStep[] }) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Run Steps"
        description="这里看 runtime 级别的 step timeline，包括 step 类型、状态以及原始 input / output。"
      />
      {props.steps.length === 0 ? (
        <EmptyState title="No steps" description="Run steps appear here after the selected run starts executing." />
      ) : (
        <div className="space-y-3">
          {props.steps.map((step) => (
            <article key={step.id} className="workbench-panel rounded-[20px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{`step ${step.seq}`}</Badge>
                <Badge>{step.stepType}</Badge>
                <Badge className={statusTone(step.status)}>{step.status}</Badge>
                {step.name ? <Badge>{step.name}</Badge> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <JsonBlock title="Input" value={step.input ?? {}} />
                <JsonBlock title="Output" value={step.output ?? {}} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SessionEventsCard(props: { events: SessionEventContract[] }) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Session Events"
        description="这里看 SSE event feed，适合核对前端实时流、cursor 以及 event payload。"
      />
      {props.events.length === 0 ? (
        <EmptyState title="No events" description="SSE events appear here when the current session emits runtime updates." />
      ) : (
        <div className="space-y-3">
          {props.events.map((event) => (
            <article key={event.id} className="workbench-panel rounded-[20px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{event.event}</Badge>
                {event.runId ? <Badge>{event.runId}</Badge> : null}
                <span className="text-xs text-[color:var(--muted-foreground)]">cursor {event.cursor}</span>
              </div>
              <JsonBlock title={formatTimestamp(event.createdAt)} value={event.data} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function StorageWorkbench(props: {
  browserTab: StorageBrowserTab;
  onBrowserTabChange: (tab: StorageBrowserTab) => void;
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  storageTableSearch: string;
  onStorageTableSearchChange: (value: string) => void;
  storageTableWorkspaceId: string;
  onStorageTableWorkspaceIdChange: (value: string) => void;
  storageTableSessionId: string;
  onStorageTableSessionIdChange: (value: string) => void;
  storageTableRunId: string;
  onStorageTableRunIdChange: (value: string) => void;
  onSelectTable: (table: StoragePostgresTableName) => void;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshOverview: () => void;
  onRefreshTable: () => void;
  onPreviousTablePage: () => void;
  onNextTablePage: () => void;
  onClearTableFilters: () => void;
  onDownloadTableCsv: () => void;
  onRefreshRedisKeys: () => void;
  onLoadMoreRedisKeys: () => void;
  onRefreshRedisKey: () => void;
  onDeleteRedisKey: () => void;
  onDeleteSelectedRedisKeys: () => void;
  onClearRedisSessionQueue: (key: string) => void;
  onReleaseRedisSessionLock: (key: string) => void;
  busy: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="panel-card rounded-[24px] border p-4">
        <InspectorPanelHeader
          title="Storage Workbench"
          description="面向全局服务状态的数据库工作台。这里把 OAH 自己的 Postgres 表和 Redis 关键 keyspace 组织成可直接排障、巡检和维护的界面。"
          action={
            <Button variant="secondary" size="sm" onClick={props.onRefreshOverview} disabled={props.busy}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          }
        />
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <StorageBackendSummaryCard
            title="Postgres"
            status={props.overview?.postgres.available ? "connected" : props.overview?.postgres.configured ? "degraded" : "not configured"}
            description={
              props.overview?.postgres.database
                ? `database ${props.overview.postgres.database}`
                : "当前服务没有启用 Postgres 持久化。"
            }
            details={[
              `configured: ${props.overview?.postgres.configured ? "yes" : "no"}`,
              `primary: ${props.overview?.postgres.primaryStorage ? "yes" : "no"}`,
              `tables: ${props.overview?.postgres.tables.length ?? 0}`
            ]}
          />
          <StorageBackendSummaryCard
            title="Redis"
            status={props.overview?.redis.available ? "connected" : props.overview?.redis.configured ? "degraded" : "not configured"}
            description={
              props.overview?.redis.available
                ? `prefix ${props.overview.redis.keyPrefix} · dbsize ${props.overview.redis.dbSize ?? 0}`
                : "当前服务没有启用 Redis 或 Redis 当前不可达。"
            }
            details={[
              `configured: ${props.overview?.redis.configured ? "yes" : "no"}`,
              `event bus: ${props.overview?.redis.eventBusEnabled ? "yes" : "no"}`,
              `run queue: ${props.overview?.redis.runQueueEnabled ? "yes" : "no"}`
            ]}
          />
        </div>
        <div className="segmented-shell mt-4 flex gap-2">
          <InspectorTabButton
            label={`Postgres${props.overview?.postgres.available ? ` · ${props.overview.postgres.tables.length}` : ""}`}
            active={props.browserTab === "postgres"}
            onClick={() => props.onBrowserTabChange("postgres")}
          />
          <InspectorTabButton
            label={`Redis${props.overview?.redis.available ? ` · ${props.overview.redis.dbSize ?? 0}` : ""}`}
            active={props.browserTab === "redis"}
            onClick={() => props.onBrowserTabChange("redis")}
          />
        </div>
      </div>

      <div className="grid gap-3">
        {props.browserTab === "postgres" ? (
          <StoragePostgresPanel
            overview={props.overview}
            tablePage={props.tablePage}
            selectedTable={props.selectedTable}
            selectedRow={props.selectedRow}
            onSelectRow={props.onSelectRow}
            search={props.storageTableSearch}
            onSearchChange={props.onStorageTableSearchChange}
            workspaceId={props.storageTableWorkspaceId}
            onWorkspaceIdChange={props.onStorageTableWorkspaceIdChange}
            sessionId={props.storageTableSessionId}
            onSessionIdChange={props.onStorageTableSessionIdChange}
            runId={props.storageTableRunId}
            onRunIdChange={props.onStorageTableRunIdChange}
            onSelectTable={props.onSelectTable}
            onRefresh={props.onRefreshTable}
            onPreviousPage={props.onPreviousTablePage}
            onNextPage={props.onNextTablePage}
            onClearFilters={props.onClearTableFilters}
            onDownloadCsv={props.onDownloadTableCsv}
            busy={props.busy}
          />
        ) : null}
        {props.browserTab === "redis" ? (
          <StorageRedisPanel
            overview={props.overview}
            redisKeyPattern={props.redisKeyPattern}
            onRedisKeyPatternChange={props.onRedisKeyPatternChange}
            redisKeyPage={props.redisKeyPage}
            selectedRedisKey={props.selectedRedisKey}
            selectedRedisKeys={props.selectedRedisKeys}
            onSelectedRedisKeysChange={props.onSelectedRedisKeysChange}
            onSelectRedisKey={props.onSelectRedisKey}
            redisKeyDetail={props.redisKeyDetail}
            onRefreshKeys={props.onRefreshRedisKeys}
            onLoadMoreKeys={props.onLoadMoreRedisKeys}
            onRefreshKey={props.onRefreshRedisKey}
            onDeleteKey={props.onDeleteRedisKey}
            onDeleteSelectedKeys={props.onDeleteSelectedRedisKeys}
            onClearSessionQueue={props.onClearRedisSessionQueue}
            onReleaseSessionLock={props.onReleaseRedisSessionLock}
            busy={props.busy}
          />
        ) : null}
      </div>
    </section>
  );
}

function StorageBackendSummaryCard(props: {
  title: string;
  status: string;
  description: string;
  details: string[];
}) {
  return (
    <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <Badge className={statusTone(props.status === "connected" ? "completed" : props.status === "degraded" ? "failed" : "queued")}>
          {props.status}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-6 text-[color:var(--foreground)]">{props.description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.details.map((detail) => (
          <Badge key={detail}>{detail}</Badge>
        ))}
      </div>
    </div>
  );
}

function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  workspaceId: string;
  onWorkspaceIdChange: (value: string) => void;
  sessionId: string;
  onSessionIdChange: (value: string) => void;
  runId: string;
  onRunIdChange: (value: string) => void;
  onSelectTable: (table: StoragePostgresTableName) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onClearFilters: () => void;
  onDownloadCsv: () => void;
  busy: boolean;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Postgres Browser"
        description="按 OAH 自己的核心表浏览数据。上方先选表，下面直接以大表格方式查看最近 50 行，尽量接近表格工作台。"
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={props.busy || !props.overview?.postgres.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Table
          </Button>
        }
      />

      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {props.overview.postgres.tables.map((table) => (
              <button
                key={table.name}
                className={cn(
                  "rounded-[18px] border p-3 text-left transition",
                  props.selectedTable === table.name
                    ? "border-[rgba(19,35,63,0.12)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(238,243,250,0.92))] shadow-[0_12px_24px_rgba(21,35,58,0.06)]"
                    : "border-[color:var(--border)] bg-[rgba(255,255,255,0.76)] hover:bg-[rgba(247,250,253,0.94)]"
                )}
                onClick={() => props.onSelectTable(table.name)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[color:var(--foreground)]">{table.name}</p>
                  <Badge>{table.rowCount}</Badge>
                </div>
                <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">{table.description}</p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">{table.orderBy}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-2 xl:grid-cols-[minmax(220px,1.4fr)_minmax(160px,0.8fr)_minmax(160px,0.8fr)_minmax(160px,0.8fr)_auto_auto]">
            <Input value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Search row JSON" />
            <Input value={props.workspaceId} onChange={(event) => props.onWorkspaceIdChange(event.target.value)} placeholder="workspaceId" />
            <Input value={props.sessionId} onChange={(event) => props.onSessionIdChange(event.target.value)} placeholder="sessionId" />
            <Input value={props.runId} onChange={(event) => props.onRunIdChange(event.target.value)} placeholder="runId" />
            <Button variant="secondary" onClick={props.onRefresh} disabled={props.busy}>
              Apply
            </Button>
            <Button variant="ghost" onClick={props.onClearFilters} disabled={props.busy}>
              Clear
            </Button>
          </div>

          {props.tablePage ? (
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
              <div className="subtle-panel space-y-3 rounded-[20px] border border-[color:var(--border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.tablePage.table}</p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {props.tablePage.rowCount} rows · ordered by {props.tablePage.orderBy}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {props.tablePage.appliedFilters ? <Badge>filtered</Badge> : null}
                    <Badge>{props.tablePage.rows.length} preview rows</Badge>
                    <Button variant="ghost" size="sm" onClick={props.onDownloadCsv}>
                      <Download className="h-4 w-4" />
                      CSV
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-[color:var(--muted-foreground)]">
                    offset {props.tablePage.offset} · limit {props.tablePage.limit}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={props.onPreviousPage} disabled={props.busy || props.tablePage.offset === 0}>
                      Prev
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={props.onNextPage}
                      disabled={props.busy || props.tablePage.nextOffset === undefined}
                    >
                      Next
                    </Button>
                  </div>
                </div>
                <StorageDataGrid
                  tableName={props.tablePage.table}
                  columns={props.tablePage.columns}
                  rows={props.tablePage.rows}
                  selectedRow={props.selectedRow}
                  onSelectRow={props.onSelectRow}
                />
              </div>
              <div className="subtle-panel space-y-3 rounded-[20px] border border-[color:var(--border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--foreground)]">
                      {props.tablePage.table === "messages"
                        ? "Message Detail"
                        : props.tablePage.table === "run_steps"
                          ? "Run Step Detail"
                          : props.tablePage.table === "tool_calls"
                            ? "Tool Call Detail"
                            : props.tablePage.table === "session_events"
                              ? "Session Event Detail"
                          : "Row Detail"}
                    </p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {props.tablePage.table === "messages"
                        ? "messages 表会按 AI SDK 风格拆开 content，直接查看 role、parts 和 tool trace。"
                        : props.tablePage.table === "run_steps"
                          ? "run_steps 表会优先给出结构化 step 视图，model_call 会直接还原成 LLM trace。"
                          : props.tablePage.table === "tool_calls"
                            ? "tool_calls 表会拆出工具审计的 request / response，方便直接核对实际调度参数。"
                            : props.tablePage.table === "session_events"
                              ? "session_events 表会优先解释常见事件 payload，message 内容会直接按 AI SDK 风格显示。"
                          : "点选表格行后，在这里查看完整字段和值。"}
                    </p>
                  </div>
                  {props.selectedRow ? <Badge>selected</Badge> : null}
                </div>
                {props.selectedRow ? (
                  props.tablePage.table === "messages" ? (
                    <StorageMessageRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "run_steps" ? (
                    <StorageRunStepRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "tool_calls" ? (
                    <StorageToolCallRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "session_events" ? (
                    <StorageSessionEventRowDetail row={props.selectedRow} />
                  ) : (
                    <JsonBlock title="Row" value={props.selectedRow} />
                  )
                ) : (
                  <EmptyState title="No row selected" description="Select a row from the table to inspect the full record." />
                )}
              </div>
            </div>
          ) : (
            <EmptyState title="No table selected" description="Select a Postgres table to inspect recent rows." />
          )}
        </>
      )}
    </section>
  );
}

function StorageRedisPanel(props: {
  overview: StorageOverview | null;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshKeys: () => void;
  onLoadMoreKeys: () => void;
  onRefreshKey: () => void;
  onDeleteKey: () => void;
  onDeleteSelectedKeys: () => void;
  onClearSessionQueue: (key: string) => void;
  onReleaseSessionLock: (key: string) => void;
  busy: boolean;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
      <InspectorPanelHeader
        title="Redis Browser"
        description="先看 OAH 自己的 ready queue / session queue / lock / event buffer，再像工作表一样浏览 key 列表和选中 key 的详细值。"
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy || !props.overview?.redis.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Keys
          </Button>
        }
      />

      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <CatalogLine label="dbsize" value={props.overview.redis.dbSize ?? 0} />
            <CatalogLine label="ready queue" value={props.overview.redis.readyQueue?.length ?? 0} />
            <CatalogLine label="session queues" value={props.overview.redis.sessionQueues.length} />
            <CatalogLine label="session locks" value={props.overview.redis.sessionLocks.length} />
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
            <div className="space-y-3">
              <div className="subtle-panel rounded-[20px] border border-[color:var(--border)] p-3">
                <p className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Queue And Lock Snapshot</p>
                <div className="space-y-4">
                  <StorageKeySummaryList
                    title="Session Queues"
                    items={props.overview.redis.sessionQueues.map((item) => ({
                      label: item.sessionId,
                      value: `${item.length} items`,
                      keyName: item.key
                    }))}
                    emptyLabel="No queued sessions."
                    onSelect={props.onSelectRedisKey}
                    actionLabel="Clear"
                    onAction={props.onClearSessionQueue}
                  />
                  <StorageKeySummaryList
                    title="Session Locks"
                    items={props.overview.redis.sessionLocks.map((item) => ({
                      label: item.sessionId,
                      value: item.ttlMs !== undefined ? `${item.ttlMs}ms` : "ttl n/a",
                      keyName: item.key
                    }))}
                    emptyLabel="No active session locks."
                    onSelect={props.onSelectRedisKey}
                    actionLabel="Release"
                    onAction={props.onReleaseSessionLock}
                  />
                  <StorageKeySummaryList
                    title="Event Buffers"
                    items={props.overview.redis.eventBuffers.map((item) => ({
                      label: item.sessionId,
                      value: `${item.length} events`,
                      keyName: item.key
                    }))}
                    emptyLabel="No session event buffers."
                    onSelect={props.onSelectRedisKey}
                  />
                </div>
              </div>
              <div className="subtle-panel rounded-[20px] border border-[color:var(--border)] p-3">
                <div className="flex gap-2">
                  <Input value={props.redisKeyPattern} onChange={(event) => props.onRedisKeyPatternChange(event.target.value)} placeholder="oah:*" />
                  <Button variant="secondary" onClick={props.onRefreshKeys} disabled={props.busy}>
                    Load
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={props.onDeleteSelectedKeys}
                    disabled={props.busy || props.selectedRedisKeys.length === 0}
                  >
                    Delete Selected
                  </Button>
                </div>
                <div className="mt-3">
                  <StorageRedisKeyGrid
                    items={props.redisKeyPage?.items ?? []}
                    selectedKey={props.selectedRedisKey}
                    selectedKeys={props.selectedRedisKeys}
                    onToggleSelected={(key) =>
                      props.onSelectedRedisKeysChange(
                        props.selectedRedisKeys.includes(key)
                          ? props.selectedRedisKeys.filter((entry) => entry !== key)
                          : [...props.selectedRedisKeys, key]
                      )
                    }
                    onToggleSelectAll={(keys) =>
                      props.onSelectedRedisKeysChange(
                        keys.every((key) => props.selectedRedisKeys.includes(key))
                          ? props.selectedRedisKeys.filter((entry) => !keys.includes(entry))
                          : [...new Set([...props.selectedRedisKeys, ...keys])]
                      )
                    }
                    onSelect={props.onSelectRedisKey}
                  />
                  {props.redisKeyPage?.nextCursor ? (
                    <div className="mt-3">
                      <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                        Load More
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="subtle-panel rounded-[20px] border border-[color:var(--border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--foreground)]">Selected Redis Key</p>
                  <p className="text-xs text-[color:var(--muted-foreground)]">{props.redisKeyDetail?.key ?? "Pick a key from the list or snapshot above."}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={props.onRefreshKey} disabled={props.busy || !props.selectedRedisKey}>
                    Refresh
                  </Button>
                  {props.selectedRedisKey.endsWith(":queue") ? (
                    <Button variant="secondary" size="sm" onClick={() => props.onClearSessionQueue(props.selectedRedisKey)} disabled={props.busy}>
                      Clear Queue
                    </Button>
                  ) : null}
                  {props.selectedRedisKey.endsWith(":lock") ? (
                    <Button variant="secondary" size="sm" onClick={() => props.onReleaseSessionLock(props.selectedRedisKey)} disabled={props.busy}>
                      Release Lock
                    </Button>
                  ) : null}
                  <Button variant="destructive" size="sm" onClick={props.onDeleteKey} disabled={props.busy || !props.selectedRedisKey}>
                    Delete Key
                  </Button>
                </div>
              </div>
              {props.redisKeyDetail ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge>{props.redisKeyDetail.type}</Badge>
                    {props.redisKeyDetail.size !== undefined ? <Badge>{`size ${props.redisKeyDetail.size}`}</Badge> : null}
                    {props.redisKeyDetail.ttlMs !== undefined ? <Badge>{`ttl ${props.redisKeyDetail.ttlMs}ms`}</Badge> : null}
                  </div>
                  <JsonBlock title="Value" value={props.redisKeyDetail.value ?? {}} />
                </div>
              ) : (
                <EmptyState title="No key selected" description="Choose a Redis key to inspect its current value and metadata." />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function StorageKeySummaryList(props: {
  title: string;
  items: Array<{ label: string; value: string; keyName: string }>;
  emptyLabel: string;
  onSelect: (key: string) => void;
  actionLabel?: string;
  onAction?: (key: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {props.items.map((item) => (
            <div key={item.keyName} className="rounded-[16px] border border-[color:var(--border)] bg-white/88 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => props.onSelect(item.keyName)}>
                  <span className="truncate text-sm font-medium text-[color:var(--foreground)]">{item.label}</span>
                </button>
                <div className="flex items-center gap-2">
                  <Badge>{item.value}</Badge>
                  {props.actionLabel && props.onAction ? (
                    <Button variant="ghost" size="sm" onClick={() => props.onAction?.(item.keyName)}>
                      {props.actionLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
              <button className="mt-1 w-full text-left" onClick={() => props.onSelect(item.keyName)}>
                <p className="break-all text-xs leading-6 text-[color:var(--muted-foreground)]">{item.keyName}</p>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatStorageCellPreview(
  value: unknown,
  options?: {
    tableName?: StoragePostgresTableName;
    columnName?: string;
  }
) {
  if (options?.tableName === "messages" && options.columnName === "content") {
    const normalized = normalizeMessageContent(value);
    if (normalized !== null) {
      return contentPreview(normalized, 180);
    }
  }

  if (options?.tableName === "run_steps" && (options.columnName === "input" || options.columnName === "output") && isRecord(value)) {
    if (options.columnName === "input") {
      if (typeof value.model === "string") {
        const messageCount = typeof value.messageCount === "number" ? ` · ${value.messageCount} msgs` : "";
        return `${value.model}${messageCount}`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} input`;
      }
    }

    if (options.columnName === "output") {
      if (typeof value.finishReason === "string") {
        const calls = Array.isArray(value.toolCalls) ? value.toolCalls.length : 0;
        const results = Array.isArray(value.toolResults) ? value.toolResults.length : 0;
        return `${value.finishReason} · ${calls} calls · ${results} results`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} output`;
      }
    }
  }

  if (options?.tableName === "tool_calls") {
    if (options.columnName === "request" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const actionName = typeof value.actionName === "string" ? value.actionName : undefined;
      if (actionName) {
        return `${actionName}${sourceType ? ` · ${sourceType}` : ""}`;
      }
      return sourceType ? `${sourceType} request` : "request";
    }

    if (options.columnName === "response" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const duration = typeof value.durationMs === "number" ? ` · ${value.durationMs}ms` : "";
      return `${sourceType ?? "response"}${duration}`;
    }
  }

  if (options?.tableName === "session_events" && options.columnName === "data" && isRecord(value)) {
    const normalizedContent = normalizeMessageContent(value.content);
    if (normalizedContent !== null) {
      return contentPreview(normalizedContent, 180);
    }

    if (typeof value.toolName === "string") {
      return `${value.toolName}${typeof value.toolCallId === "string" ? ` · ${value.toolCallId}` : ""}`;
    }

    if (typeof value.status === "string") {
      return value.status;
    }
  }

  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact || " ";
  }

  return `${compact.slice(0, 180)}...`;
}

function StorageDataGrid(props: {
  tableName: StoragePostgresTableName;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown>) => void;
}) {
  if (props.rows.length === 0) {
    return <EmptyState title="No rows" description="This table is currently empty." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-[color:var(--border)] bg-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-slate-700">
          <thead className="bg-[rgba(245,248,252,0.96)]">
            <tr>
              {props.columns.map((column) => (
                <th key={column} className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <tr
                key={`row:${index}`}
                className={cn(
                  "cursor-pointer align-top odd:bg-white even:bg-[rgba(247,250,253,0.78)] hover:bg-[rgba(241,246,252,0.96)]",
                  props.selectedRow === row ? "bg-[rgba(232,239,249,0.96)] even:bg-[rgba(232,239,249,0.96)]" : ""
                )}
                onClick={() => props.onSelectRow(row)}
              >
                {props.columns.map((column) => (
                  <td key={`${index}:${column}`} className="max-w-[280px] border-b border-[color:var(--border)] px-3 py-2">
                    <div
                      className="line-clamp-4 break-words text-xs leading-6 text-slate-700"
                      title={typeof row[column] === "string" ? row[column] : prettyJson(row[column])}
                    >
                      {formatStorageCellPreview(row[column], {
                        tableName: props.tableName,
                        columnName: column
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StorageMessageRowDetail(props: { row: Record<string, unknown> }) {
  const message = storageMessageFromRow(props.row);

  if (!message) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const text = contentText(message.content);
  const refs = contentToolRefs(message.content);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
            {message.role}
          </span>
          {message.runId ? <Badge>{message.runId}</Badge> : null}
          <MessageToolRefChips content={message.content} />
          <Badge>{formatTimestamp(message.createdAt)}</Badge>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Message ID" value={message.id} />
          <InsightRow label="Session ID" value={message.sessionId} />
          <InsightRow label="Parts" value={String(Array.isArray(message.content) ? message.content.length : 1)} />
          <InsightRow label="Text Size" value={String(text.length)} />
        </div>
      </div>

      <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Message Content</p>
        <div className="mt-3">
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-[26rem]" />
        </div>
      </div>

      {refs.length > 0 ? (
        <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Trace</p>
          <div className="mt-3 space-y-2">
            {refs.map((ref, index) => (
              <div key={`${ref.type}:${ref.toolCallId}:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{ref.type}</Badge>
                  <Badge>{ref.toolName}</Badge>
                  <Badge>{ref.toolCallId}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {message.metadata ? <JsonBlock title="Metadata" value={message.metadata} /> : null}
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRunStepRowDetail(props: { row: Record<string, unknown> }) {
  const step = storageRunStepFromRow(props.row);

  if (!step) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const modelTrace = toModelCallTrace(step);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{`step ${step.seq}`}</Badge>
          <Badge>{step.stepType}</Badge>
          <Badge className={statusTone(step.status)}>{step.status}</Badge>
          {step.name ? <Badge>{step.name}</Badge> : null}
          {step.agentName ? <Badge>{step.agentName}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Step ID" value={step.id} />
          <InsightRow label="Run ID" value={step.runId} />
          <InsightRow label="Started" value={formatTimestamp(step.startedAt)} />
          <InsightRow label="Ended" value={formatTimestamp(step.endedAt)} />
        </div>
      </div>

      {modelTrace ? (
        <div className="space-y-3">
          <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
            <InspectorPanelHeader
              title="Model Call Trace"
              description="Storage 里的 run_step 已直接还原成 model call 视图，方便在数据库维度核对一次模型请求与返回。"
            />
          </div>
          <ModelCallTraceCard trace={modelTrace} />
        </div>
      ) : (
        <>
          <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Structured Step Payload</p>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <JsonBlock title="Input" value={step.input ?? {}} />
              <JsonBlock title="Output" value={step.output ?? {}} />
            </div>
          </div>
        </>
      )}

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageToolCallRowDetail(props: { row: Record<string, unknown> }) {
  const record = storageToolCallFromRow(props.row);

  if (!record) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{record.toolName}</Badge>
          <Badge>{record.sourceType}</Badge>
          <Badge className={statusTone(record.status)}>{record.status}</Badge>
          {record.stepId ? <Badge>{record.stepId}</Badge> : null}
          {record.durationMs !== undefined ? <Badge>{`${record.durationMs}ms`}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Tool Call ID" value={record.id} />
          <InsightRow label="Run ID" value={record.runId} />
          <InsightRow label="Started" value={formatTimestamp(record.startedAt)} />
          <InsightRow label="Ended" value={formatTimestamp(record.endedAt)} />
        </div>
      </div>

      <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Audit Payload</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="panel-card overflow-hidden rounded-[22px] border">
            <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
              Request
            </div>
            <div className="p-3">
              <PayloadValueView value={record.request ?? {}} maxHeightClassName="max-h-72" mode="input" />
            </div>
          </div>
          <div className="panel-card overflow-hidden rounded-[22px] border">
            <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
              Response
            </div>
            <div className="p-3">
              <PayloadValueView value={record.response ?? {}} maxHeightClassName="max-h-72" mode="result" />
            </div>
          </div>
        </div>
      </div>

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageSessionEventRowDetail(props: { row: Record<string, unknown> }) {
  const event = storageSessionEventFromRow(props.row);

  if (!event) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const eventContent = normalizeMessageContent(event.data.content);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{event.event}</Badge>
          {event.runId ? <Badge>{event.runId}</Badge> : null}
          <Badge>{`cursor ${event.cursor}`}</Badge>
          {typeof event.data.toolName === "string" ? <Badge>{String(event.data.toolName)}</Badge> : null}
          {typeof event.data.toolCallId === "string" ? <Badge>{String(event.data.toolCallId)}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Event ID" value={event.id} />
          <InsightRow label="Session ID" value={event.sessionId} />
          <InsightRow label="Created" value={formatTimestamp(event.createdAt)} />
          <InsightRow label="Payload Keys" value={String(Object.keys(event.data).length)} />
        </div>
      </div>

      {eventContent !== null ? (
        <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Message Payload</p>
          <div className="mt-3">
            <MessageContentDetail content={eventContent} maxHeightClassName="max-h-[24rem]" />
          </div>
        </div>
      ) : null}

      <JsonBlock title="Event Data" value={event.data} />
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRedisKeyGrid(props: {
  items: StorageRedisKeyPage["items"];
  selectedKey: string;
  selectedKeys: string[];
  onToggleSelected: (key: string) => void;
  onToggleSelectAll: (keys: string[]) => void;
  onSelect: (key: string) => void;
}) {
  if (props.items.length === 0) {
    return <EmptyState title="No keys loaded" description="Load Redis keys by pattern to inspect current keyspace." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-[color:var(--border)] bg-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-slate-700">
          <thead className="bg-[rgba(245,248,252,0.96)]">
            <tr>
              <th className="w-10 border-b border-[color:var(--border)] px-3 py-2">
                <input
                  type="checkbox"
                  checked={props.items.length > 0 && props.items.every((item) => props.selectedKeys.includes(item.key))}
                  onChange={() => props.onToggleSelectAll(props.items.map((item) => item.key))}
                />
              </th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">key</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">type</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">size</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">ttl</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr
                key={item.key}
                className={cn(
                  "cursor-pointer align-top transition odd:bg-white even:bg-[rgba(247,250,253,0.78)] hover:bg-[rgba(241,246,252,0.96)]",
                  props.selectedKey === item.key ? "bg-[rgba(232,239,249,0.96)] even:bg-[rgba(232,239,249,0.96)]" : ""
                )}
                onClick={() => props.onSelect(item.key)}
              >
                <td className="border-b border-[color:var(--border)] px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={props.selectedKeys.includes(item.key)} onChange={() => props.onToggleSelected(item.key)} />
                </td>
                <td className="max-w-[520px] border-b border-[color:var(--border)] px-3 py-2">
                  <div className="break-all text-xs leading-6 text-slate-700">{item.key}</div>
                </td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.type}</td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.size ?? "n/a"}</td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.ttlMs !== undefined ? `${item.ttlMs}ms` : "persistent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="subtle-panel rounded-[22px] border border-dashed border-[color:var(--border)] px-4 py-8 text-center">
      <p className="surface-title text-sm font-medium text-[color:var(--foreground)]">{props.title}</p>
      <p className="mt-2 text-sm leading-6 text-[color:var(--muted-foreground)]">{props.description}</p>
    </div>
  );
}

function CatalogLine(props: { label: string; value: number | string }) {
  return (
    <div className="panel-card flex items-center justify-between rounded-[22px] border px-4 py-3 text-sm">
      <span className="text-[color:var(--muted-foreground)]">{props.label}</span>
      <span className="font-semibold text-[color:var(--foreground)]">{props.value}</span>
    </div>
  );
}

function StatusTile(props: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "sky" | "emerald" | "rose" | "amber";
  compact?: boolean;
}) {
  const colorClass =
    props.tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : props.tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : props.tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-sky-200 bg-sky-50 text-sky-700";

  const Icon = props.icon;

  if (props.compact) {
    return (
      <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs", colorClass)}>
        <Icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-[0.16em]">{props.label}</span>
        <span className="max-w-[120px] truncate font-medium normal-case tracking-normal">{props.value}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-[22px] border px-4 py-3 shadow-[0_10px_22px_rgba(21,35,58,0.04)]", colorClass)}>
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
        <Icon className="h-4 w-4" />
        {props.label}
      </div>
      <div className="truncate text-sm font-medium">{props.value}</div>
    </div>
  );
}
