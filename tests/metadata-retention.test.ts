import { describe, expect, it, vi } from "vitest";

import { PostgresMetadataRetentionService } from "../apps/server/src/metadata-retention.ts";

describe("PostgresMetadataRetentionService", () => {
  it("prunes configured metadata tables in bounded batches", async () => {
    const query = vi.fn(async () => ({ rowCount: 2, rows: [] }));
    const service = new PostgresMetadataRetentionService({
      pool: {
        query
      } as unknown as import("pg").Pool,
      now: () => new Date("2026-04-30T00:00:00.000Z"),
      historyEventRetentionDays: 7,
      sessionEventRetentionDays: 14,
      runRetentionDays: 30,
      batchLimit: 50
    });

    await expect(service.runOnce()).resolves.toEqual({
      historyEvents: 2,
      sessionEvents: 2,
      runs: 2
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0]?.[0])).toContain("from history_events");
    expect(query.mock.calls[0]?.[1]).toEqual(["2026-04-23T00:00:00.000Z", 50]);
    expect(String(query.mock.calls[1]?.[0])).toContain("from session_events");
    expect(query.mock.calls[1]?.[1]).toEqual(["2026-04-16T00:00:00.000Z", 50]);
    expect(String(query.mock.calls[2]?.[0])).toContain("from runs");
    expect(query.mock.calls[2]?.[1]).toEqual([
      "2026-03-31T00:00:00.000Z",
      50,
      ["completed", "failed", "cancelled", "canceled"]
    ]);
  });

  it("skips tables with disabled retention windows", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const service = new PostgresMetadataRetentionService({
      pool: {
        query
      } as unknown as import("pg").Pool,
      now: () => new Date("2026-04-30T00:00:00.000Z"),
      historyEventRetentionDays: 0,
      sessionEventRetentionDays: 14,
      runRetentionDays: 0
    });

    await expect(service.runOnce()).resolves.toEqual({
      historyEvents: 0,
      sessionEvents: 1,
      runs: 0
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("from session_events");
  });
});
