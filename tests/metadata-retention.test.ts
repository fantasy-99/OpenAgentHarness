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

  it("uses a Postgres advisory lock to keep retention single-owner", async () => {
    const release = vi.fn();
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rowCount: 3, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const connect = vi.fn(async () => ({
      query: clientQuery,
      release
    }));
    const service = new PostgresMetadataRetentionService({
      pool: {
        connect
      } as unknown as import("pg").Pool,
      now: () => new Date("2026-04-30T00:00:00.000Z"),
      historyEventRetentionDays: 7
    });

    await expect(service.runOnce()).resolves.toEqual({
      historyEvents: 3,
      sessionEvents: 0,
      runs: 0
    });

    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(String(clientQuery.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
    expect(String(clientQuery.mock.calls[1]?.[0])).toContain("from history_events");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips retention when another owner holds the advisory lock", async () => {
    const release = vi.fn();
    const clientQuery = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: false }] });
    const service = new PostgresMetadataRetentionService({
      pool: {
        connect: vi.fn(async () => ({
          query: clientQuery,
          release
        }))
      } as unknown as import("pg").Pool,
      now: () => new Date("2026-04-30T00:00:00.000Z"),
      historyEventRetentionDays: 7,
      sessionEventRetentionDays: 14,
      runRetentionDays: 30
    });

    await expect(service.runOnce()).resolves.toEqual({
      historyEvents: 0,
      sessionEvents: 0,
      runs: 0
    });

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
