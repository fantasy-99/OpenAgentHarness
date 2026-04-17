import type {
  CreateMessageRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  Message,
  Run,
  RunStep,
  Session,
  Workspace
} from "@oah/api-contracts";

import type {
  CallerContext,
  ModelDefinition,
  ModelGateway,
  RuntimeLogger,
  WorkspaceActivityTracker
} from "./runtime.js";
import type {
  ArtifactRepository,
  HistoryEventRepository,
  HookRunAuditRepository,
  MessageRepository,
  RunQueue,
  RunRepository,
  RunStepRepository,
  RuntimeMessageRepository,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRepository,
  WorkspaceArchiveRepository,
  WorkspaceRepository
} from "./storage.js";
import type {
  WorkspaceCommandExecutor,
  WorkspaceDeletionHandler,
  WorkspaceExecutionProvider,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceInitializer
} from "./workspace.js";
import type { RuntimeMessage } from "../runtime/runtime-messages.js";

export interface RuntimeServiceOptions {
  defaultModel: string;
  modelGateway: ModelGateway;
  logger?: RuntimeLogger | undefined;
  workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  executionServicesMode?: "eager" | "lazy" | undefined;
  runHeartbeatIntervalMs?: number | undefined;
  staleRunRecovery?:
    | {
        strategy?: "fail" | "requeue_running" | "requeue_all" | undefined;
        maxAttempts?: number | undefined;
      }
    | undefined;
  platformModels?: Record<string, ModelDefinition> | undefined;
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runtimeMessageRepository?: RuntimeMessageRepository | undefined;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  runQueue?: RunQueue | undefined;
  toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  hookRunAuditRepository?: HookRunAuditRepository | undefined;
  artifactRepository?: ArtifactRepository | undefined;
  historyEventRepository?: HistoryEventRepository | undefined;
  workspaceArchiveRepository?: WorkspaceArchiveRepository | undefined;
  workspaceDeletionHandler?: WorkspaceDeletionHandler | undefined;
  workspaceInitializer?: WorkspaceInitializer | undefined;
  workspaceExecutionProvider?: WorkspaceExecutionProvider | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
  workspaceCommandExecutor?: WorkspaceCommandExecutor | undefined;
}

export type RunQueuePriority = "normal" | "subagent";

export interface CreateWorkspaceParams {
  input: CreateWorkspaceRequest;
}

export interface CreateSessionParams {
  workspaceId: string;
  caller: CallerContext;
  input: CreateSessionRequest;
}

export interface UpdateSessionParams {
  sessionId: string;
  input: import("@oah/api-contracts").UpdateSessionRequest;
}

export interface CreateSessionMessageParams {
  sessionId: string;
  caller: CallerContext;
  input: CreateMessageRequest;
}

export interface TriggerActionRunParams {
  workspaceId: string;
  caller: CallerContext;
  actionName: string;
  sessionId?: string | undefined;
  agentName?: string | undefined;
  input?: unknown;
  triggerSource?: "api" | "user" | undefined;
}

export interface CancelRunResult {
  runId: string;
  status: "cancellation_requested";
}

export interface RequeueRunResult {
  runId: string;
  status: "queued";
  previousStatus: "failed" | "timed_out";
  source: "manual_requeue";
}

export interface ActionRunAcceptedResult {
  runId: string;
  status: "queued";
  actionName: string;
  sessionId?: string | undefined;
}

export interface RuntimeMessageListResult {
  items: RuntimeMessage[];
  nextCursor?: string | undefined;
}

export interface MessageListResult {
  items: Message[];
  nextCursor?: string | undefined;
}

export interface WorkspaceListResult {
  items: Workspace[];
  nextCursor?: string | undefined;
}

export interface SessionListResult {
  items: Session[];
  nextCursor?: string | undefined;
}

export interface RunListResult {
  items: Run[];
  nextCursor?: string | undefined;
}

export interface RunStepListResult {
  items: RunStep[];
  nextCursor?: string | undefined;
}
