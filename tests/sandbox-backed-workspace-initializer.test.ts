import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLocalWorkspaceCommandExecutor, createLocalWorkspaceFileSystem, type WorkspaceRecord } from "@oah/engine-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxBackedWorkspaceInitializer } from "../apps/server/src/bootstrap/sandbox-backed-workspace-initializer.ts";
import type { SandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

describe("sandbox-backed workspace initializer", () => {
  it("uploads runtime files into self-hosted sandbox workspaces", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-self-hosted-workspace-init-"));
    tempDirs.push(tempDir);

    const runtimeDir = path.join(tempDir, "runtimes");
    const runtimeRoot = path.join(runtimeDir, "workspace");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const remoteWorkspaceRoot = path.join(tempDir, "remote-workspace");

    await Promise.all([
      mkdir(path.join(runtimeRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "nested"), { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(remoteWorkspaceRoot, { recursive: true })
    ]);

    await Promise.all([
      writeFile(path.join(runtimeRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8"),
      writeFile(path.join(runtimeRoot, "README.md"), "# Seeded from runtime\n", "utf8"),
      writeFile(path.join(runtimeRoot, "nested", "notes.txt"), "hello from runtime\n", "utf8")
    ]);

    const sandboxHost: SandboxHost = {
      providerKind: "self_hosted",
      workspaceCommandExecutor: createLocalWorkspaceCommandExecutor(),
      workspaceFileSystem: createLocalWorkspaceFileSystem(),
      workspaceExecutionProvider: {
        async acquire(input: { workspace: WorkspaceRecord }) {
          return {
            workspace: input.workspace,
            async release() {
              return undefined;
            }
          };
        }
      },
      workspaceFileAccessProvider: {
        async acquire(input: { workspace: WorkspaceRecord; access: "read" | "write"; path?: string | undefined }) {
          return {
            workspace: {
              ...input.workspace,
              rootPath: remoteWorkspaceRoot
            },
            async release() {
              return undefined;
            }
          };
        }
      },
      diagnostics() {
        return {
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox"
        };
      },
      async maintain() {
        return undefined;
      },
      async beginDrain() {
        return undefined;
      },
      async close() {
        return undefined;
      }
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "ws_remote_seed",
          workspaceId: "ws_remote_seed",
          provider: "self_hosted",
          executionModel: "sandbox_hosted",
          workerPlacement: "inside_sandbox",
          rootPath: "/workspace",
          name: "remote-seed",
          kind: "project",
          executionPolicy: "local",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const initializer = createSandboxBackedWorkspaceInitializer({
      runtimeDir,
      platformToolDir: toolsDir,
      platformSkillDir: skillsDir,
      toolDir: toolsDir,
      platformModels: {},
      platformAgents: {},
      sandboxHost,
      selfHosted: {
        baseUrl: "http://127.0.0.1:8787/internal/v1"
      }
    });

    const initialized = await initializer.initialize({
      name: "remote-seed",
      runtime: "workspace",
      executionPolicy: "local"
    });

    expect(initialized.rootPath).toBe("/workspace");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(remoteWorkspaceRoot, "README.md"), "utf8")).resolves.toBe("# Seeded from runtime\n");
    await expect(readFile(path.join(remoteWorkspaceRoot, "nested", "notes.txt"), "utf8")).resolves.toBe(
      "hello from runtime\n"
    );
    await expect(readFile(path.join(remoteWorkspaceRoot, ".openharness", "settings.yaml"), "utf8")).resolves.toBe(
      "default_agent: assistant\nruntime: workspace\n"
    );
  });
});
