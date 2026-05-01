import { describe, expect, it } from "vitest";
import type { Run, Session } from "@oah/api-contracts";

import { formatSessionActivity, latestSessionRun } from "../apps/cli/src/tui/domain/utils.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    workspaceId: "ws_1",
    subjectRef: "workspace:ws_1",
    activeAgentName: "assistant",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function createRun(overrides: Partial<Run>): Run {
  return {
    id: "run_1",
    workspaceId: "ws_1",
    sessionId: "ses_1",
    triggerType: "message",
    effectiveAgentName: "assistant",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("TUI session resume helpers", () => {
  it("selects the most recently active run for a session", () => {
    const latest = createRun({
      id: "run_latest",
      status: "running",
      startedAt: "2026-01-01T00:05:00.000Z"
    });

    expect(
      latestSessionRun([
        createRun({
          id: "run_old",
          endedAt: "2026-01-01T00:01:00.000Z"
        }),
        latest
      ])
    ).toEqual(latest);
  });

  it("formats queued, running, and completed session activity labels", () => {
    const session = createSession();

    expect(formatSessionActivity(session, createRun({ status: "queued" })).label).toBe("queued");
    expect(formatSessionActivity(session, createRun({ status: "running" })).label).toBe("running");
    expect(formatSessionActivity(session, createRun({ status: "completed" })).label).toBe("completed");
  });

  it("falls back to the session lifecycle when no run has been recorded", () => {
    expect(formatSessionActivity(createSession({ status: "closed" }), undefined)).toMatchObject({
      label: "closed"
    });
  });
});
