import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@oah/runtime-core";

import { createApp } from "../apps/server/src/app.ts";
import type { AppDependencies } from "../apps/server/src/http/types.ts";

const activeApps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(
    activeApps.splice(0).map(async (app) => {
      await app.close();
    })
  );
});

async function readSseEvents(
  response: Response,
  stopWhen: (events: Array<{ event: string; data: Record<string, unknown>; cursor?: string; createdAt?: string }>) => boolean
): Promise<Array<{ event: string; data: Record<string, unknown>; cursor?: string; createdAt?: string }>> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected SSE response body.");
  }

  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown>; cursor?: string; createdAt?: string }> = [];
  const frame: { event?: string; data?: string; cursor?: string; createdAt?: string } = {};
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        if (frame.event) {
          events.push({
            event: frame.event,
            data: frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {},
            ...(frame.cursor ? { cursor: frame.cursor } : {}),
            ...(frame.createdAt ? { createdAt: frame.createdAt } : {})
          });
          frame.event = undefined;
          frame.data = undefined;
          frame.cursor = undefined;
          frame.createdAt = undefined;

          if (stopWhen(events)) {
            await reader.cancel();
            return events;
          }
        }
        continue;
      }

      if (line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event: ")) {
        frame.event = line.slice("event: ".length);
        continue;
      }

      if (line.startsWith("data: ")) {
        frame.data = line.slice("data: ".length);
        continue;
      }

      if (line.startsWith("id: ")) {
        frame.cursor = line.slice("id: ".length);
        continue;
      }

      if (line.startsWith("createdAt: ")) {
        frame.createdAt = line.slice("createdAt: ".length);
      }
    }
  }

  return events;
}

describe("session event SSE route", () => {
  it("does not lose events emitted between subscription setup and backlog delivery", async () => {
    let listener: ((event: SessionEvent) => void) | undefined;
    const backlogEvent: SessionEvent = {
      id: "evt_backlog",
      cursor: "1",
      sessionId: "ses_race",
      runId: "run_race",
      event: "run.queued",
      data: {
        runId: "run_race",
        status: "queued"
      },
      createdAt: "2026-04-10T00:00:00.000Z"
    };
    const liveEvent: SessionEvent = {
      id: "evt_live",
      cursor: "2",
      sessionId: "ses_race",
      runId: "run_race",
      event: "run.started",
      data: {
        runId: "run_race",
        status: "running"
      },
      createdAt: "2026-04-10T00:00:01.000Z"
    };

    const app = createApp({
      runtimeService: {
        async getSession(sessionId: string) {
          return {
            id: sessionId
          };
        },
        async listSessionEvents() {
          listener?.(liveEvent);
          return [backlogEvent];
        },
        subscribeSessionEvents(_sessionId: string, next: (event: SessionEvent) => void) {
          listener = next;
          return () => {
            listener = undefined;
          };
        }
      },
      modelGateway: {} as AppDependencies["modelGateway"],
      defaultModel: "test-model",
      logger: false
    } as unknown as AppDependencies);
    activeApps.push(app);

    await app.listen({
      host: "127.0.0.1",
      port: 0
    });
    const { port } = app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/ses_race/events`);
    const events = await readSseEvents(response, (items) => items.length === 2);

    expect(events.map((event) => event.event)).toEqual(["run.queued", "run.started"]);
    expect(events.map((event) => event.cursor)).toEqual(["1", "2"]);
    expect(events.map((event) => event.createdAt)).toEqual([backlogEvent.createdAt, liveEvent.createdAt]);
  });
});
