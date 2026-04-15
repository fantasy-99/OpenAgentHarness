import { AppError } from "@oah/runtime-core";
import type {
  WorkspaceCommandExecutor,
  WorkspaceExecutionLease,
  WorkspaceExecutionProvider,
  WorkspaceFileAccessLease,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "@oah/runtime-core";
import { createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem } from "@oah/runtime-core";

import type {
  WorkspaceMaterializationDiagnostics,
  WorkspaceMaterializationLease,
  WorkspaceMaterializationManager
} from "./workspace-materialization.js";
import { WorkspaceMaterializationDrainingError } from "./workspace-materialization.js";

export interface SandboxHostDiagnostics {
  materialization?: WorkspaceMaterializationDiagnostics | undefined;
}

export interface SandboxHost {
  workspaceCommandExecutor: WorkspaceCommandExecutor;
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceExecutionProvider: WorkspaceExecutionProvider;
  workspaceFileAccessProvider: WorkspaceFileAccessProvider;
  diagnostics(): SandboxHostDiagnostics;
  maintain(options: { idleBefore: string }): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

function leaseToExecutionWorkspace(workspace: WorkspaceRecord, lease: WorkspaceMaterializationLease): WorkspaceRecord {
  return {
    ...workspace,
    rootPath: lease.localPath
  };
}

async function acquireMaterializedLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceMaterializationLease> {
  try {
    return await manager.acquireWorkspace({
      workspace
    });
  } catch (error) {
    if (error instanceof WorkspaceMaterializationDrainingError) {
      throw new AppError(503, "workspace_materialization_draining", error.message);
    }

    throw error;
  }
}

async function materializedExecutionLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceExecutionLease> {
  const lease = await acquireMaterializedLease(manager, workspace);
  return {
    workspace: leaseToExecutionWorkspace(workspace, lease),
    async release(options?: { dirty?: boolean | undefined }) {
      await lease.release(options);
    }
  };
}

async function materializedFileAccessLease(
  manager: WorkspaceMaterializationManager,
  workspace: WorkspaceRecord
): Promise<WorkspaceFileAccessLease> {
  const lease = await acquireMaterializedLease(manager, workspace);
  return {
    workspace: leaseToExecutionWorkspace(workspace, lease),
    async release(options?: { dirty?: boolean | undefined }) {
      await lease.release(options);
    }
  };
}

export function createMaterializationSandboxHost(options: {
  materializationManager: WorkspaceMaterializationManager;
}): SandboxHost {
  const manager = options.materializationManager;
  return {
    workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
    workspaceFileSystem: createLocalWorkspaceFileSystem(),
    workspaceExecutionProvider: {
      async acquire({ workspace }) {
        return materializedExecutionLease(manager, workspace);
      }
    },
    workspaceFileAccessProvider: {
      async acquire({ workspace }) {
        return materializedFileAccessLease(manager, workspace);
      }
    },
    diagnostics() {
      return {
        materialization: manager.diagnostics()
      };
    },
    async maintain({ idleBefore }) {
      await manager.refreshLeases();
      await manager.flushIdleCopies({ idleBefore });
      await manager.evictIdleCopies({ idleBefore });
    },
    async beginDrain() {
      await manager.beginDrain();
    },
    async close() {
      await manager.close();
    }
  };
}
