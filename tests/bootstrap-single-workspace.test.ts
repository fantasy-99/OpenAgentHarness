import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceId } from "@oah/config";

import {
  bootstrapRuntime,
  findManagedWorkspaceIdsToDelete,
  reconcileDiscoveredWorkspaces
} from "../apps/server/src/bootstrap.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out while waiting for condition.");
}

function seedLegacyMirrorDatabase(dbPath: string, workspaceId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        workspace_id text not null,
        subject_ref text not null,
        agent_name text,
        active_agent_name text not null,
        title text,
        status text not null,
        last_run_at text,
        created_at text not null,
        updated_at text not null
      );
    `);
    db.prepare(
      `insert into sessions
       (id, workspace_id, subject_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "ses_bootstrap_legacy",
      workspaceId,
      "dev:test",
      "assistant",
      "assistant",
      "restored from copied workspace",
      "active",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
  } finally {
    db.close();
  }
}

describe("bootstrap single workspace mode", () => {
  it("reuses persisted workspace ids for rediscovered roots", async () => {
    const discovered = {
      id: buildWorkspaceId("project", "repo", "/tmp/repo"),
      name: "repo",
      rootPath: "/tmp/repo",
      executionPolicy: "local" as const,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "project" as const,
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "template",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    };

    const reconciled = reconcileDiscoveredWorkspaces([discovered], [
      {
        ...discovered,
        id: "ws_legacy_random",
        name: "Renamed Workspace",
        executionPolicy: "remote",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      }
    ]);

    expect(reconciled).toEqual([
      expect.objectContaining({
        id: "ws_legacy_random",
        name: "Renamed Workspace",
        rootPath: "/tmp/repo",
        executionPolicy: "remote",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      })
    ]);
  });

  it("deletes stale and duplicate managed workspaces during sync planning", async () => {
    const discovered = [
      {
        id: buildWorkspaceId("project", "repo", "/tmp/workspaces/repo"),
        name: "repo",
        rootPath: "/tmp/workspaces/repo",
        executionPolicy: "local" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "project" as const,
        readOnly: false,
        historyMirrorEnabled: false,
        settings: {
          defaultAgent: "assistant",
          skillDirs: []
        },
        workspaceModels: {},
        agents: {},
        actions: {},
        skills: {},
        toolServers: {},
        hooks: {},
        catalog: {
          workspaceId: "template",
          agents: [],
          models: [],
          actions: [],
          skills: [],
          tools: [],
          hooks: [],
          nativeTools: []
        }
      }
    ];

    const staleIds = findManagedWorkspaceIdsToDelete(
      discovered,
      [
        {
          ...discovered[0],
          id: "ws_latest_random",
          updatedAt: "2026-01-03T00:00:00.000Z"
        },
        {
          ...discovered[0],
          id: "ws_older_random",
          updatedAt: "2026-01-02T00:00:00.000Z"
        },
        {
          ...discovered[0],
          id: "ws_missing_workspace",
          rootPath: "/tmp/workspaces/removed",
          name: "removed"
        },
        {
          ...discovered[0],
          id: "ws_external_workspace",
          rootPath: "/tmp/external/repo",
          name: "external"
        }
      ],
      {
        workspace_dir: "/tmp/workspaces",
        chat_dir: "/tmp/chat"
      }
    );

    expect(staleIds).toEqual(["ws_older_random", "ws_missing_workspace"]);
  });

  it("boots a single workspace directly from CLI flags without a server config file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    const runtime = await bootstrapRuntime({
      argv: ["--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
      startWorker: false,
      processKind: "api"
    });

    try {
      const expectedWorkspaceId = buildWorkspaceId("project", "repo", workspaceRoot);
      expect(runtime.workspaceMode).toEqual({
        kind: "single",
        workspaceId: expectedWorkspaceId,
        workspaceKind: "project",
        rootPath: workspaceRoot
      });
      expect(runtime.listWorkspaceTemplates).toBeUndefined();
      expect(runtime.importWorkspace).toBeUndefined();

      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toHaveLength(1);
      expect(workspacePage.items[0]).toMatchObject({
        id: expectedWorkspaceId,
        rootPath: workspaceRoot,
        kind: "project"
      });
      expect(runtime.config.paths.model_dir).toBe(modelsDir);
      expect(runtime.config.llm.default_model).toBe("openai-default");
      await expect(runtime.healthReport()).resolves.toMatchObject({
        storage: {
          primary: "sqlite"
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails fast when configured postgres storage is unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-pg-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    const configPath = path.join(tempDir, "server.yaml");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(path.join(tempDir, "workspaces"), { recursive: true }),
      mkdir(path.join(tempDir, "chat"), { recursive: true }),
      mkdir(path.join(tempDir, "templates"), { recursive: true }),
      mkdir(path.join(tempDir, "tools"), { recursive: true }),
      mkdir(path.join(tempDir, "skills"), { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  postgres_url: postgres://127.0.0.1:9/oah_test
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    await expect(
      bootstrapRuntime({
        argv: ["--config", configPath, "--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
        startWorker: false,
        processKind: "api"
      })
    ).rejects.toThrow(/Configured PostgreSQL persistence is unavailable/);
  });

  it("recovers copied workspace history from a legacy history.db inside workspace_dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-legacy-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const chatDir = path.join(tempDir, "chat");
    const templatesDir = path.join(tempDir, "templates");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const workspaceRoot = path.join(workspaceDir, "copied-repo");
    const configPath = path.join(tempDir, "server.yaml");
    const historyDbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");

    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness", "data"), { recursive: true }),
      mkdir(chatDir, { recursive: true }),
      mkdir(templatesDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    seedLegacyMirrorDatabase(historyDbPath, buildWorkspaceId("project", "copied-repo", workspaceRoot));

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toHaveLength(1);
      const workspace = workspacePage.items[0]!;
      expect(workspace.id).toBe(buildWorkspaceId("project", "copied-repo", workspaceRoot));

      const sessions = await runtime.runtimeService.listWorkspaceSessions(workspace.id, 10);
      expect(sessions.items).toEqual([
        expect.objectContaining({
          id: "ses_bootstrap_legacy",
          title: "restored from copied workspace"
        })
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("hot-discovers copied workspaces in workspace_dir and restores legacy history", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-hot-import-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const chatDir = path.join(tempDir, "chat");
    const templatesDir = path.join(tempDir, "templates");
    const modelsDir = path.join(tempDir, "models");
    const toolsDir = path.join(tempDir, "tools");
    const skillsDir = path.join(tempDir, "skills");
    const stagingRoot = path.join(tempDir, "staging-repo");
    const finalWorkspaceRoot = path.join(workspaceDir, "copied-repo");
    const configPath = path.join(tempDir, "server.yaml");
    const expectedWorkspaceId = buildWorkspaceId("project", "copied-repo", finalWorkspaceRoot);

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(chatDir, { recursive: true }),
      mkdir(templatesDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolsDir, { recursive: true }),
      mkdir(skillsDir, { recursive: true }),
      mkdir(path.join(stagingRoot, ".openharness", "data"), { recursive: true })
    ]);

    await writeFile(path.join(stagingRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    seedLegacyMirrorDatabase(path.join(stagingRoot, ".openharness", "data", "history.db"), expectedWorkspaceId);

    const runtime = await bootstrapRuntime({
      argv: ["--config", configPath],
      startWorker: false,
      processKind: "api"
    });

    try {
      await expect(runtime.runtimeService.listWorkspaces(10)).resolves.toMatchObject({
        items: []
      });

      await rename(stagingRoot, finalWorkspaceRoot);
      await writeFile(path.join(workspaceDir, ".sync-trigger"), `${Date.now()}\n`, "utf8");

      await waitFor(async () => {
        const page = await runtime.runtimeService.listWorkspaces(10);
        return page.items.some((workspace) => workspace.id === expectedWorkspaceId);
      }, 8_000);

      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toEqual([
        expect.objectContaining({
          id: expectedWorkspaceId,
          rootPath: finalWorkspaceRoot
        })
      ]);

      const sessions = await runtime.runtimeService.listWorkspaceSessions(expectedWorkspaceId, 10);
      expect(sessions.items).toEqual([
        expect.objectContaining({
          id: "ses_bootstrap_legacy",
          title: "restored from copied workspace"
        })
      ]);

      await rm(finalWorkspaceRoot, { recursive: true, force: true });

      await waitFor(async () => {
        const page = await runtime.runtimeService.listWorkspaces(10);
        return page.items.length === 0;
      }, 8_000);

      await expect(runtime.runtimeService.getSession("ses_bootstrap_legacy")).rejects.toMatchObject({
        code: "session_not_found"
      });
    } finally {
      await runtime.close();
    }
  }, 15_000);
});
