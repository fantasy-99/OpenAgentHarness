import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceArchiveRecord, WorkspaceArchiveRepository } from "@oah/runtime-core";

import { WorkspaceArchiveExporter } from "../apps/server/src/workspace-archive-export.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

function createArchiveRecord(overrides: Partial<WorkspaceArchiveRecord> = {}): WorkspaceArchiveRecord {
  return {
    id: overrides.id ?? "warc_1",
    workspaceId: overrides.workspaceId ?? "ws_1",
    scopeType: overrides.scopeType ?? "workspace",
    scopeId: overrides.scopeId ?? "ws_1",
    archiveDate: overrides.archiveDate ?? "2026-04-08",
    archivedAt: overrides.archivedAt ?? "2026-04-08T12:00:00.000Z",
    deletedAt: overrides.deletedAt ?? "2026-04-08T12:00:00.000Z",
    timezone: overrides.timezone ?? "Asia/Shanghai",
    workspace: overrides.workspace ?? {
      id: "ws_1",
      name: "demo",
      rootPath: "/tmp/demo",
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      createdAt: "2026-04-08T11:00:00.000Z",
      updatedAt: "2026-04-08T12:00:00.000Z",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_1",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    },
    sessions: overrides.sessions ?? [
      {
        id: "ses_1",
        workspaceId: "ws_1",
        subjectRef: "dev:test",
        activeAgentName: "builder",
        status: "active",
        createdAt: "2026-04-08T11:00:00.000Z",
        updatedAt: "2026-04-08T12:00:00.000Z"
      }
    ],
    runs: overrides.runs ?? [
      {
        id: "run_1",
        workspaceId: "ws_1",
        sessionId: "ses_1",
        triggerType: "message",
        effectiveAgentName: "builder",
        status: "completed",
        createdAt: "2026-04-08T11:05:00.000Z"
      }
    ],
    messages: overrides.messages ?? [
      {
        id: "msg_1",
        sessionId: "ses_1",
        runId: "run_1",
        role: "assistant",
        content: "archived hello",
        createdAt: "2026-04-08T11:06:00.000Z"
      }
    ],
    runtimeMessages: overrides.runtimeMessages ?? [],
    runSteps: overrides.runSteps ?? [],
    toolCalls: overrides.toolCalls ?? [],
    hookRuns: overrides.hookRuns ?? [],
    artifacts: overrides.artifacts ?? []
  };
}

describe("workspace archive exporter", () => {
  it("exports pending pre-today archive buckets into a date-named sqlite database", async () => {
    const exportRoot = await mkdtemp(path.join(tmpdir(), "oah-archive-export-"));
    tempDirs.push(exportRoot);

    const archive = createArchiveRecord();
    const calls: {
      pendingBefore?: string;
      marked?: { ids: string[]; exportPath: string };
    } = {};

    const repository: WorkspaceArchiveRepository = {
      async archiveWorkspace() {
        return archive;
      },
      async archiveSessionTree() {
        return archive;
      },
      async listPendingArchiveDates(beforeArchiveDate) {
        calls.pendingBefore = beforeArchiveDate;
        return ["2026-04-08"];
      },
      async listByArchiveDate(archiveDate) {
        return archiveDate === "2026-04-08" ? [archive] : [];
      },
      async markExported(ids, input) {
        calls.marked = {
          ids,
          exportPath: input.exportPath
        };
      }
    };

    const exporter = new WorkspaceArchiveExporter({
      repository,
      exportRoot,
      timeZone: "Asia/Shanghai",
      pollIntervalMs: 60_000
    });

    await exporter.exportPending();
    await exporter.close();

    expect(calls.pendingBefore).toBe("2026-04-09");
    expect(calls.marked?.ids).toEqual(["warc_1"]);
    expect(calls.marked?.exportPath).toBe(path.join(exportRoot, "2026-04-08.sqlite"));

    const dbPath = path.join(exportRoot, "2026-04-08.sqlite");
    const db = new DatabaseSync(dbPath);
    const manifest = db
      .prepare("select archive_date as archiveDate, archive_count as archiveCount from archive_manifest where archive_date = ?")
      .get("2026-04-08") as { archiveDate: string; archiveCount: number } | undefined;
    const archivedWorkspace = db
      .prepare("select workspace_id as workspaceId, scope_type as scopeType, scope_id as scopeId from archives where archive_id = ?")
      .get("warc_1") as { workspaceId: string; scopeType: string; scopeId: string } | undefined;
    const archivedMessage = db
      .prepare("select role, content from messages where archive_id = ? and id = ?")
      .get("warc_1", "msg_1") as { role: string; content: string } | undefined;
    db.close();

    expect(manifest).toEqual({
      archiveDate: "2026-04-08",
      archiveCount: 1
    });
    expect(archivedWorkspace?.workspaceId).toBe("ws_1");
    expect(archivedWorkspace?.scopeType).toBe("workspace");
    expect(archivedWorkspace?.scopeId).toBe("ws_1");
    expect(archivedMessage?.role).toBe("assistant");
    expect(JSON.parse(archivedMessage?.content ?? "null")).toBe("archived hello");
  });
});
