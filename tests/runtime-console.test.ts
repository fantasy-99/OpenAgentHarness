import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { SessionEventContract } from "@oah/api-contracts";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import {
  DualWriteSessionEventStore,
  appendRuntimeLogEvent,
  buildRuntimeConsoleLogger
} from "../apps/server/src/runtime-console.ts";
import { buildRuntimeConsoleEntries } from "../apps/web/src/app/support";

describe("runtime console", () => {
  it("appends structured runtime.log events to the shared session event store", async () => {
    const persistence = createMemoryRuntimePersistence();
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_console",
      name: "console",
      rootPath: "/tmp/console",
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: { defaultAgent: "builder", skillDirs: [] },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_console",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });
    const session = await persistence.sessionRepository.create({
      id: "ses_console",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });

    await appendRuntimeLogEvent(persistence.sessionEventStore, {
      sessionId: session.id,
      runId: "run_console",
      level: "error",
      category: "tool",
      message: "Runtime tool call failed.",
      details: {
        sessionId: session.id,
        runId: "run_console",
        toolName: "Bash",
        token: "secret-token"
      },
      context: {
        sessionId: session.id,
        runId: "run_console",
        toolCallId: "call_1"
      },
      timestamp: "2026-04-09T00:00:01.000Z"
    });

    const events = await persistence.sessionEventStore.listSince(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "runtime.log",
      data: {
        level: "error",
        category: "tool",
        message: "Runtime tool call failed.",
        source: "server",
        context: {
          sessionId: session.id,
          runId: "run_console",
          toolCallId: "call_1"
        }
      }
    });
    expect((events[0]?.data as { details?: Record<string, unknown> }).details?.token).toBe("[redacted]");
  });

  it("writes project session events to local history.db and falls back to central-only events when local mirroring is unavailable", async () => {
    const persistence = createMemoryRuntimePersistence();
    const rootPath = await mkdtemp(path.join(tmpdir(), "oah-console-project-"));
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_project",
      name: "project",
      rootPath,
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      defaultAgent: "builder",
      settings: { defaultAgent: "builder", skillDirs: [] },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_project",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });
    const session = await persistence.sessionRepository.create({
      id: "ses_project",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });

    const store = new DualWriteSessionEventStore({
      primary: persistence.sessionEventStore,
      sessionRepository: persistence.sessionRepository,
      workspaceRepository: persistence.workspaceRepository
    });

    const event = await store.append({
      sessionId: session.id,
      runId: "run_project",
      event: "run.started",
      data: { status: "running" }
    });

    const db = new DatabaseSync(path.join(rootPath, ".openharness", "data", "history.db"));
    try {
      const row = db
        .prepare("select payload from session_events where id = ?")
        .get(event.id) as { payload: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
        id: event.id,
        cursor: event.cursor,
        event: "run.started"
      });
    } finally {
      db.close();
    }

    const failingRoot = await mkdtemp(path.join(tmpdir(), "oah-console-failure-"));
    const brokenRootPath = path.join(failingRoot, "workspace-file");
    await writeFile(brokenRootPath, "not a directory");
    const failingWorkspace = await persistence.workspaceRepository.upsert({
      ...workspace,
      id: "ws_broken",
      rootPath: brokenRootPath
    });
    const failingSession = await persistence.sessionRepository.create({
      ...session,
      id: "ses_broken",
      workspaceId: failingWorkspace.id
    });

    const brokenEvent = await store.append({
      sessionId: failingSession.id,
      runId: "run_broken",
      event: "run.failed",
      data: { errorMessage: "boom" }
    });

    await expect(persistence.sessionEventStore.listSince(failingSession.id)).resolves.toEqual([
      expect.objectContaining({
        id: brokenEvent.id,
        event: "run.failed"
      })
    ]);
  });

  it("bridges runtime logger entries into runtime.log session events", async () => {
    const persistence = createMemoryRuntimePersistence();
    const logger = buildRuntimeConsoleLogger({
      enabled: true,
      echoToStdout: false,
      sessionEventStore: persistence.sessionEventStore,
      now: () => "2026-04-09T00:00:01.000Z"
    });

    logger?.error?.("Runtime tool call failed.", {
      sessionId: "ses_logger",
      runId: "run_logger",
      toolName: "Read",
      errorCode: "tool_failed"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = await persistence.sessionEventStore.listSince("ses_logger");
    expect(events[0]).toMatchObject({
      event: "runtime.log",
      data: {
        level: "error",
        category: "tool",
        message: "Runtime tool call failed."
      }
    });
  });

  it("projects lifecycle events and runtime.log entries into console rows", () => {
    const entries = buildRuntimeConsoleEntries(
      [
        {
          id: "evt_runtime",
          cursor: "2",
          sessionId: "ses_console",
          runId: "run_console",
          event: "runtime.log",
          data: {
            level: "error",
            category: "tool",
            message: "Detailed tool failure",
            details: { errorCode: "tool_failed" },
            source: "server",
            timestamp: "2026-04-09T00:00:02.000Z"
          },
          createdAt: "2026-04-09T00:00:02.000Z"
        } satisfies SessionEventContract,
        {
          id: "evt_tool",
          cursor: "1",
          sessionId: "ses_console",
          runId: "run_console",
          event: "tool.failed",
          data: {
            toolName: "Bash",
            errorMessage: "Bash timed out."
          },
          createdAt: "2026-04-09T00:00:01.000Z"
        } satisfies SessionEventContract
      ],
      {
        message: "http: Request failed",
        code: "internal_error",
        timestamp: "2026-04-09T00:00:03.000Z"
      }
    );

    expect(entries.map((entry) => `${entry.category}:${entry.level}:${entry.message}`)).toEqual([
      "tool:error:Bash timed out.",
      "tool:error:Detailed tool failure",
      "http:error:http: Request failed"
    ]);
  });
});
