import { describe, expect, it, vi } from "vitest";

import { AppError, type WorkspaceRecord } from "@oah/runtime-core";

import { createMaterializationSandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";
import { WorkspaceMaterializationDrainingError } from "../apps/server/src/bootstrap/workspace-materialization.ts";

function buildWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws_test",
    kind: "project",
    name: "Test",
    rootPath: "/tmp/source",
    readOnly: false,
    agents: {},
    models: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    settings: undefined,
    executionPolicy: undefined,
    status: "ready",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    historyMirrorEnabled: false,
    ...overrides
  };
}

describe("materialization sandbox host", () => {
  it("maps execution leases onto the materialized local workspace path", async () => {
    const release = vi.fn(async () => undefined);
    const host = createMaterializationSandboxHost({
      materializationManager: {
        acquireWorkspace: vi.fn(async () => ({
          workspaceId: "ws_test",
          version: "live",
          ownerWorkerId: "worker_1",
          localPath: "/tmp/materialized/ws_test",
          sourceKind: "object_store",
          remotePrefix: "workspaces/ws_test",
          markDirty: vi.fn(),
          touch: vi.fn(),
          release
        })),
        diagnostics: vi.fn(() => ({
          draining: false,
          cachedCopies: 0,
          objectStoreCopies: 0,
          dirtyCopies: 0,
          busyCopies: 0,
          idleCopies: 0,
          failureCount: 0,
          blockerCount: 0,
          failures: []
        })),
        refreshLeases: vi.fn(async () => undefined),
        flushIdleCopies: vi.fn(async () => []),
        evictIdleCopies: vi.fn(async () => []),
        beginDrain: vi.fn(async () => ({
          drainStartedAt: "2026-04-15T00:00:00.000Z",
          flushed: [],
          evicted: []
        })),
        close: vi.fn(async () => undefined)
      } as never
    });

    const lease = await host.workspaceExecutionProvider.acquire({
      workspace: buildWorkspace(),
      run: {
        id: "run_1",
        sessionId: "ses_1",
        workspaceId: "ws_test",
        status: "queued",
        triggerType: "message",
        effectiveAgentName: "main",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z"
      }
    });

    expect(lease.workspace.rootPath).toBe("/tmp/materialized/ws_test");
    await lease.release({ dirty: true });
    expect(release).toHaveBeenCalledWith({ dirty: true });
  });

  it("converts draining materialization failures into AppError", async () => {
    const host = createMaterializationSandboxHost({
      materializationManager: {
        acquireWorkspace: vi.fn(async () => {
          throw new WorkspaceMaterializationDrainingError("draining");
        }),
        diagnostics: vi.fn(() => ({
          draining: true,
          cachedCopies: 0,
          objectStoreCopies: 0,
          dirtyCopies: 0,
          busyCopies: 0,
          idleCopies: 0,
          failureCount: 0,
          blockerCount: 0,
          failures: []
        })),
        refreshLeases: vi.fn(async () => undefined),
        flushIdleCopies: vi.fn(async () => []),
        evictIdleCopies: vi.fn(async () => []),
        beginDrain: vi.fn(async () => ({
          drainStartedAt: "2026-04-15T00:00:00.000Z",
          flushed: [],
          evicted: []
        })),
        close: vi.fn(async () => undefined)
      } as never
    });

    await expect(
      host.workspaceFileAccessProvider.acquire({
        workspace: buildWorkspace(),
        access: "write",
        path: "README.md"
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 503,
      code: "workspace_materialization_draining",
      message: "draining"
    });
  });
});
