import { describe, expect, it } from "vitest";

import { consumeSse } from "../apps/web/src/app/support";

describe("consumeSse", () => {
  it("preserves server-created timestamps from SSE frames", async () => {
    const payload =
      "id: 42\n" +
      "event: message.completed\n" +
      "createdAt: 2026-04-19T13:56:51.084Z\n" +
      'data: {"messageId":"msg_1","runId":"run_1"}\n\n';
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        }
      })
    );

    const frames: Array<{
      cursor?: string;
      createdAt?: string;
      event: string;
      data: Record<string, unknown>;
    }> = [];

    await consumeSse(
      response,
      (frame) => {
        frames.push(frame);
      },
      new AbortController().signal
    );

    expect(frames).toEqual([
      {
        cursor: "42",
        createdAt: "2026-04-19T13:56:51.084Z",
        event: "message.completed",
        data: {
          messageId: "msg_1",
          runId: "run_1"
        }
      }
    ]);
  });
});
