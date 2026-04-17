import type {
  ArtifactRepository,
  HistoryEventRepository,
  HookRunAuditRepository,
  MessageRepository,
  RuntimeMessageRepository,
  RunRepository,
  RunStepRepository,
  SessionEventStore,
  SessionRepository,
  ToolCallAuditRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";
import { SQLitePersistenceCoordinator, SQLiteWorkspaceRepository } from "./coordinator.js";
import {
  SQLiteArtifactRepository,
  SQLiteHistoryEventRepository,
  SQLiteHookRunAuditRepository,
  SQLiteMessageRepository,
  SQLiteRunRepository,
  SQLiteRunStepRepository,
  SQLiteRuntimeMessageRepository,
  SQLiteSessionEventStore,
  SQLiteSessionRepository,
  SQLiteToolCallAuditRepository
} from "./repositories.js";
import { defaultProjectDbPath, shadowDbPath, shouldPersistProjectDbInsideWorkspace } from "./shared.js";

export interface SQLiteRuntimePersistence {
  driver: "sqlite";
  workspaceRepository: WorkspaceRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runtimeMessageRepository: RuntimeMessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  toolCallAuditRepository: ToolCallAuditRepository;
  hookRunAuditRepository: HookRunAuditRepository;
  artifactRepository: ArtifactRepository;
  historyEventRepository: HistoryEventRepository;
  listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
  listPersistedWorkspaces(): Promise<WorkspaceRecord[]>;
  close(): Promise<void>;
}

export interface CreateSQLiteRuntimePersistenceOptions {
  shadowRoot: string;
}

export function sqliteWorkspaceHistoryDbPath(
  workspace: Pick<WorkspaceRecord, "id" | "kind" | "readOnly" | "rootPath">,
  options: CreateSQLiteRuntimePersistenceOptions
): string {
  if (shouldPersistProjectDbInsideWorkspace(workspace)) {
    return defaultProjectDbPath(workspace);
  }

  return shadowDbPath(options.shadowRoot, workspace.id);
}

export async function createSQLiteRuntimePersistence(
  options: CreateSQLiteRuntimePersistenceOptions
): Promise<SQLiteRuntimePersistence> {
  const coordinator = new SQLitePersistenceCoordinator(options.shadowRoot);
  const workspaceRepository = new SQLiteWorkspaceRepository({
    onUpsert: async (workspace) => {
      await coordinator.upsertWorkspace(workspace);
    },
    onDelete: async (workspaceId) => {
      await coordinator.deleteWorkspace(workspaceId);
    }
  });
  const sessionRepository = new SQLiteSessionRepository(coordinator);
  const messageRepository = new SQLiteMessageRepository(coordinator);
  const runtimeMessageRepository = new SQLiteRuntimeMessageRepository(coordinator);
  const runRepository = new SQLiteRunRepository(coordinator);
  const runStepRepository = new SQLiteRunStepRepository(coordinator);
  const sessionEventStore = new SQLiteSessionEventStore(coordinator);
  const toolCallAuditRepository = new SQLiteToolCallAuditRepository(coordinator);
  const hookRunAuditRepository = new SQLiteHookRunAuditRepository(coordinator);
  const artifactRepository = new SQLiteArtifactRepository(coordinator);
  const historyEventRepository = new SQLiteHistoryEventRepository(coordinator);

  messageRepository.workspaceRepository = workspaceRepository;
  runRepository.workspaceRepository = workspaceRepository;

  return {
    driver: "sqlite",
    workspaceRepository,
    sessionRepository,
    messageRepository,
    runtimeMessageRepository,
    runRepository,
    runStepRepository,
    sessionEventStore,
    toolCallAuditRepository,
    hookRunAuditRepository,
    artifactRepository,
    historyEventRepository,
    listWorkspaceSnapshots(candidates) {
      return coordinator.listWorkspaceSnapshots(candidates);
    },
    listPersistedWorkspaces() {
      return coordinator.listPersistedWorkspaces();
    },
    close() {
      return coordinator.close();
    }
  };
}
