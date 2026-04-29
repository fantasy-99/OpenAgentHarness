import { describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "@oah/config";
import type { RunRepository, SessionRepository, WorkspaceRecord, WorkspaceRepository } from "@oah/engine-core";
import { prepareControlPlaneRuntime } from "../apps/server/src/bootstrap/control-plane-runtime.ts";

function createWorkspaceRepository(): WorkspaceRepository {
  return {
    create: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    upsert: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => undefined)
  };
}

describe("prepareControlPlaneRuntime", () => {
  it("does not read all persisted workspaces for unscoped api-only control planes", async () => {
    const workspaceRepository = createWorkspaceRepository();
    const sessionRepository = {} as SessionRepository;
    const runRepository = {} as RunRepository;
    const listPersistedWorkspaces = vi.fn(async () => []);
    const listWorkspaceSnapshots = vi.fn(async () => []);
    const listRepositoryWorkspaces = vi.fn(async () => []);

    const runtime = await prepareControlPlaneRuntime({
      config: {
        paths: {
          workspace_dir: "/tmp/oah-workspaces"
        }
      } as ServerConfig,
      persistence: {
        workspaceRepository,
        sessionRepository,
        runRepository,
        listPersistedWorkspaces,
        listWorkspaceSnapshots
      },
      discoveredWorkspaces: [],
      managesWorkspaceRegistry: false,
      enableControlPlaneFacade: true,
      remoteSandboxProvider: true,
      singleWorkspaceDefined: false,
      models: {},
      toolDir: "/tmp/oah-tools",
      sqliteShadowRoot: "/tmp/oah-sqlite",
      pollingConfig: { enabled: false, intervalMs: 1_000 },
      workspaceModelMetadataDiscovery: "manual",
      getPlatformAgents: vi.fn(async () => ({})),
      logWorkspaceDiscoveryError: vi.fn(),
      discoverWorkspaceWithEnrichedModels: vi.fn(),
      applyManagedWorkspaceExternalRef: (workspace) => workspace,
      withWorkspaceDefinitionTimestamp: vi.fn(async (workspace) => workspace),
      listRepositoryWorkspaces
    });

    await runtime.initialize();
    await runtime.close();

    expect(listPersistedWorkspaces).not.toHaveBeenCalled();
    expect(listWorkspaceSnapshots).not.toHaveBeenCalled();
    expect(listRepositoryWorkspaces).not.toHaveBeenCalled();
    expect(workspaceRepository.list).not.toHaveBeenCalled();
    expect(workspaceRepository.upsert).not.toHaveBeenCalled();
    expect(runtime.workspaceRepository).toBe(workspaceRepository);
    expect(runtime.sessionRepository).toBe(sessionRepository);
    expect(runtime.runRepository).toBe(runRepository);
  });
});
