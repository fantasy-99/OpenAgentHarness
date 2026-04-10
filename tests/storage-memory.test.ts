import { describe, expect, it } from "vitest";

import { createMemoryRuntimePersistence } from "@oah/storage-memory";

function createWorkspace(id: string) {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    executionPolicy: "local" as const,
    status: "active" as const,
    kind: "project" as const,
    readOnly: false,
    historyMirrorEnabled: false,
    defaultAgent: "default",
    settings: { defaultAgent: "default", skillDirs: [] },
    workspaceModels: {},
    agents: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    catalog: {
      workspaceId: id,
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z"
  };
}

describe("storage memory", () => {
  it("cascades session-scoped data when a session is deleted", async () => {
    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert(createWorkspace("ws_memory"));

    const session = {
      id: "ses_memory_target",
      workspaceId: "ws_memory",
      subjectRef: "dev:test",
      activeAgentName: "default",
      status: "active" as const,
      createdAt: "2026-04-10T00:00:01.000Z",
      updatedAt: "2026-04-10T00:00:01.000Z"
    };
    const siblingSession = {
      id: "ses_memory_sibling",
      workspaceId: "ws_memory",
      subjectRef: "dev:test",
      activeAgentName: "default",
      status: "active" as const,
      createdAt: "2026-04-10T00:00:02.000Z",
      updatedAt: "2026-04-10T00:00:02.000Z"
    };
    const run = {
      id: "run_memory_target",
      workspaceId: "ws_memory",
      sessionId: session.id,
      triggerType: "system" as const,
      effectiveAgentName: "default",
      status: "completed" as const,
      createdAt: "2026-04-10T00:00:03.000Z",
      startedAt: "2026-04-10T00:00:03.000Z",
      endedAt: "2026-04-10T00:00:04.000Z"
    };
    const siblingRun = {
      id: "run_memory_sibling",
      workspaceId: "ws_memory",
      sessionId: siblingSession.id,
      triggerType: "system" as const,
      effectiveAgentName: "default",
      status: "completed" as const,
      createdAt: "2026-04-10T00:00:05.000Z",
      startedAt: "2026-04-10T00:00:05.000Z",
      endedAt: "2026-04-10T00:00:06.000Z"
    };
    const step = {
      id: "step_memory_target",
      runId: run.id,
      seq: 1,
      stepType: "system" as const,
      status: "completed" as const,
      input: { prompt: "hello" },
      output: { ok: true },
      startedAt: "2026-04-10T00:00:03.500Z",
      endedAt: "2026-04-10T00:00:04.000Z"
    };
    const siblingStep = {
      id: "step_memory_sibling",
      runId: siblingRun.id,
      seq: 1,
      stepType: "system" as const,
      status: "completed" as const,
      input: { prompt: "hi" },
      output: { ok: true },
      startedAt: "2026-04-10T00:00:05.500Z",
      endedAt: "2026-04-10T00:00:06.000Z"
    };
    const message = {
      id: "msg_memory_target",
      sessionId: session.id,
      runId: run.id,
      role: "user" as const,
      content: "hello",
      createdAt: "2026-04-10T00:00:03.250Z"
    };
    const siblingMessage = {
      id: "msg_memory_sibling",
      sessionId: siblingSession.id,
      runId: siblingRun.id,
      role: "assistant" as const,
      content: "still here",
      createdAt: "2026-04-10T00:00:05.250Z"
    };
    const siblingRuntimeMessages = [
      {
        id: "rtm_memory_sibling",
        sessionId: siblingSession.id,
        runId: siblingRun.id,
        role: "assistant" as const,
        kind: "assistant_text" as const,
        content: "derived sibling row",
        createdAt: "2026-04-10T00:00:06.500Z"
      }
    ];

    await persistence.sessionRepository.create(session);
    await persistence.sessionRepository.create(siblingSession);
    await persistence.runRepository.create(run);
    await persistence.runRepository.create(siblingRun);
    await persistence.runStepRepository.create(step);
    await persistence.runStepRepository.create(siblingStep);
    await persistence.messageRepository.create(message);
    await persistence.messageRepository.create(siblingMessage);
    await persistence.runtimeMessageRepository.replaceBySessionId(session.id, [
      {
        id: "rtm_memory_target",
        sessionId: session.id,
        runId: run.id,
        role: "assistant",
        kind: "assistant_text",
        content: "derived target row",
        createdAt: "2026-04-10T00:00:04.500Z"
      }
    ]);
    await persistence.runtimeMessageRepository.replaceBySessionId(siblingSession.id, siblingRuntimeMessages);
    await persistence.sessionEventStore.append({
      sessionId: session.id,
      runId: run.id,
      event: "run.completed",
      data: { runId: run.id }
    });
    const siblingEvent = await persistence.sessionEventStore.append({
      sessionId: siblingSession.id,
      runId: siblingRun.id,
      event: "run.completed",
      data: { runId: siblingRun.id }
    });

    await persistence.sessionRepository.delete(session.id);

    await expect(persistence.sessionRepository.getById(session.id)).resolves.toBeNull();
    await expect(persistence.runRepository.getById(run.id)).resolves.toBeNull();
    await expect(persistence.runStepRepository.listByRunId(run.id)).resolves.toEqual([]);
    await expect(persistence.messageRepository.listBySessionId(session.id)).resolves.toEqual([]);
    await expect(persistence.runtimeMessageRepository.listBySessionId(session.id)).resolves.toEqual([]);
    await expect(persistence.sessionEventStore.listSince(session.id)).resolves.toEqual([]);

    await expect(persistence.sessionRepository.getById(siblingSession.id)).resolves.toEqual(siblingSession);
    await expect(persistence.runRepository.getById(siblingRun.id)).resolves.toEqual(siblingRun);
    await expect(persistence.runStepRepository.listByRunId(siblingRun.id)).resolves.toEqual([siblingStep]);
    await expect(persistence.messageRepository.listBySessionId(siblingSession.id)).resolves.toEqual([siblingMessage]);
    await expect(persistence.runtimeMessageRepository.listBySessionId(siblingSession.id)).resolves.toEqual(
      siblingRuntimeMessages
    );
    await expect(persistence.sessionEventStore.listSince(siblingSession.id)).resolves.toEqual([siblingEvent]);
  });

  it("keeps session event cursors monotonic after deleting an older event", async () => {
    const persistence = createMemoryRuntimePersistence();

    const first = await persistence.sessionEventStore.append({
      sessionId: "ses_cursor",
      runId: "run_cursor",
      event: "run.started",
      data: { step: 1 }
    });
    const second = await persistence.sessionEventStore.append({
      sessionId: "ses_cursor",
      runId: "run_cursor",
      event: "tool.started",
      data: { toolName: "bash" }
    });
    const third = await persistence.sessionEventStore.append({
      sessionId: "ses_cursor",
      runId: "run_cursor",
      event: "tool.completed",
      data: { toolName: "bash" }
    });

    await persistence.sessionEventStore.deleteById(second.id);

    const fourth = await persistence.sessionEventStore.append({
      sessionId: "ses_cursor",
      runId: "run_cursor",
      event: "run.completed",
      data: { step: 2 }
    });

    expect([first.cursor, second.cursor, third.cursor, fourth.cursor]).toEqual(["0", "1", "2", "3"]);
    await expect(persistence.sessionEventStore.listSince("ses_cursor", second.cursor)).resolves.toEqual([third, fourth]);
    await expect(persistence.sessionEventStore.listSince("ses_cursor", third.cursor)).resolves.toEqual([fourth]);
  });
});
