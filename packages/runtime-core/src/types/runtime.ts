import type {
  ChatMessage,
  ModelGenerateRequest,
  ModelGenerateResponse,
  RuntimeLogEventData,
  Run,
  RunStep,
  WorkspaceCatalog
} from "@oah/api-contracts";
import type { ZodTypeAny } from "zod";

export type RunStatus = Run["status"];
export type WorkspaceKind = "project";
export type AgentMode = "primary" | "subagent" | "all";
export type RunStepType = RunStep["stepType"];
export type RunStepStatus = RunStep["status"];
export type ActionRetryPolicy = "manual" | "safe";
export type RuntimeWorkspaceCatalog = WorkspaceCatalog;
export type SessionEventName =
  | "run.queued"
  | "run.started"
  | "message.delta"
  | "message.completed"
  | "agent.switch.requested"
  | "agent.switched"
  | "agent.delegate.started"
  | "agent.delegate.completed"
  | "agent.delegate.failed"
  | "hook.notice"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "runtime.log"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface CallerContext {
  subjectRef: string;
  authSource: string;
  scopes: string[];
  workspaceAccess: string[];
}

export interface SessionEvent {
  id: string;
  cursor: string;
  sessionId: string;
  runId?: string;
  event: SessionEventName;
  data: Record<string, unknown>;
  createdAt: string;
}

export type { RuntimeLogEventData };

export interface RuntimeLogger {
  debug?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface WorkspaceActivityTracker {
  touchWorkspace(workspaceId: string): Promise<void> | void;
}

export interface ModelDefinition {
  provider: string;
  key?: string;
  url?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateModelInput extends ModelGenerateRequest {
  modelDefinition?: ModelDefinition | undefined;
}

export interface RuntimeToolExecutionContext {
  abortSignal?: AbortSignal | undefined;
  toolCallId?: string | undefined;
}

export interface RuntimeToolDefinition {
  description: string;
  inputSchema: ZodTypeAny;
  retryPolicy?: ActionRetryPolicy | undefined;
  execute(input: unknown, context: RuntimeToolExecutionContext): Promise<unknown> | unknown;
}

export type RuntimeToolSet = Record<string, RuntimeToolDefinition>;

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ModelToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
}

export interface ModelStepResult {
  stepType?: string | undefined;
  text?: string | undefined;
  content?: unknown[] | undefined;
  reasoning?: unknown[] | undefined;
  usage?: Record<string, unknown> | undefined;
  warnings?: unknown[] | undefined;
  request?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
  finishReason?: string | undefined;
  toolCalls: ModelToolCall[];
  toolResults: ModelToolResult[];
}

export interface ModelStepPreparation {
  model?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  messages?: ChatMessage[] | undefined;
  systemMessages?: Array<{ role: "system"; content: string }> | undefined;
  activeToolNames?: string[] | undefined;
}

export interface ModelStreamOptions {
  signal?: AbortSignal | undefined;
  tools?: RuntimeToolSet | undefined;
  toolServers?: import("./workspace.js").ToolServerDefinition[] | undefined;
  maxSteps?: number | undefined;
  parallelToolCalls?: boolean | undefined;
  prepareStep?:
    | ((stepNumber: number) => Promise<ModelStepPreparation | undefined> | ModelStepPreparation | undefined)
    | undefined;
  onToolCallStart?: ((toolCall: ModelToolCall) => Promise<void> | void) | undefined;
  onToolCallFinish?: ((toolResult: ModelToolResult) => Promise<void> | void) | undefined;
  onStepFinish?: ((step: ModelStepResult) => Promise<void> | void) | undefined;
}

export interface StreamedModelResponse {
  readonly chunks: AsyncIterable<string>;
  readonly completed: Promise<ModelGenerateResponse>;
}

export interface ModelGateway {
  generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse>;
  stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse>;
}

export type ToolCallSourceType = "action" | "skill" | "agent" | "tool" | "native";
