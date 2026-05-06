import type { Pool, PoolClient } from "pg";

export interface MetadataRetentionLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
}

export interface PostgresMetadataRetentionOptions {
  pool: Pool;
  intervalMs?: number | undefined;
  batchLimit?: number | undefined;
  historyEventRetentionDays?: number | undefined;
  sessionEventRetentionDays?: number | undefined;
  runRetentionDays?: number | undefined;
  logger?: MetadataRetentionLogger | undefined;
  now?: (() => Date) | undefined;
}

export interface MetadataRetentionRunSummary {
  historyEvents: number;
  sessionEvents: number;
  runs: number;
}

const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH_LIMIT = 1_000;
const MIN_RETENTION_INTERVAL_MS = 60_000;
const MAX_RETENTION_BATCH_LIMIT = 10_000;
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "canceled"] as const;
const RETENTION_ADVISORY_LOCK_KEY = 73_655_206;

interface RetentionQueryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

function normalizeOptionalDays(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function deleteHistoryEvents(queryable: RetentionQueryable, cutoff: string, limit: number): Promise<number> {
  const result = await queryable.query(
    `with victims as (
       select id
       from history_events
       where occurred_at < $1
       order by occurred_at asc, id asc
       limit $2
     )
     delete from history_events
     where id in (select id from victims)`,
    [cutoff, limit]
  );
  return result.rowCount ?? 0;
}

async function deleteSessionEvents(queryable: RetentionQueryable, cutoff: string, limit: number): Promise<number> {
  const result = await queryable.query(
    `with victims as (
       select id
       from session_events
       where created_at < $1
       order by created_at asc, id asc
       limit $2
     )
     delete from session_events
     where id in (select id from victims)`,
    [cutoff, limit]
  );
  return result.rowCount ?? 0;
}

async function deleteTerminalRuns(queryable: RetentionQueryable, cutoff: string, limit: number): Promise<number> {
  const result = await queryable.query(
    `with victims as (
       select id
       from runs
       where ended_at is not null
         and ended_at < $1
         and status = any($3::text[])
       order by ended_at asc, id asc
       limit $2
     )
     delete from runs
     where id in (select id from victims)`,
    [cutoff, limit, TERMINAL_RUN_STATUSES]
  );
  return result.rowCount ?? 0;
}

export class PostgresMetadataRetentionService {
  readonly #pool: Pool;
  readonly #intervalMs: number;
  readonly #batchLimit: number;
  readonly #historyEventRetentionDays: number | undefined;
  readonly #sessionEventRetentionDays: number | undefined;
  readonly #runRetentionDays: number | undefined;
  readonly #logger: MetadataRetentionLogger;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #activeRun: Promise<void> | undefined;

  constructor(options: PostgresMetadataRetentionOptions) {
    this.#pool = options.pool;
    this.#intervalMs = Math.max(MIN_RETENTION_INTERVAL_MS, options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
    this.#batchLimit = Math.max(1, Math.min(Math.floor(options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT), MAX_RETENTION_BATCH_LIMIT));
    this.#historyEventRetentionDays = normalizeOptionalDays(options.historyEventRetentionDays);
    this.#sessionEventRetentionDays = normalizeOptionalDays(options.sessionEventRetentionDays);
    this.#runRetentionDays = normalizeOptionalDays(options.runRetentionDays);
    this.#logger = options.logger ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#logger.warn?.("Postgres metadata retention failed.", error);
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
    void this.runOnce().catch((error: unknown) => {
      this.#logger.warn?.("Postgres metadata retention failed.", error);
    });
  }

  async close(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    if (this.#activeRun) {
      await this.#activeRun.catch(() => undefined);
    }
  }

  async runOnce(): Promise<MetadataRetentionRunSummary> {
    if (this.#activeRun) {
      await this.#activeRun;
      return {
        historyEvents: 0,
        sessionEvents: 0,
        runs: 0
      };
    }

    const summary: MetadataRetentionRunSummary = {
      historyEvents: 0,
      sessionEvents: 0,
      runs: 0
    };

    const task = (async () => {
      await this.#withDistributedLock(async (queryable) => {
        await this.#runRetention(queryable, summary);
      });
    })();

    this.#activeRun = task;
    try {
      await task;
      return summary;
    } finally {
      if (this.#activeRun === task) {
        this.#activeRun = undefined;
      }
    }
  }

  async #withDistributedLock(task: (queryable: RetentionQueryable) => Promise<void>): Promise<void> {
    if (typeof this.#pool.connect !== "function") {
      await task(this.#pool as RetentionQueryable);
      return;
    }

    const client = await this.#pool.connect();
    let locked = false;
    try {
      const lockResult = await client.query("select pg_try_advisory_lock($1) as acquired", [RETENTION_ADVISORY_LOCK_KEY]);
      locked = lockResult.rows[0]?.acquired === true;
      if (!locked) {
        return;
      }

      await task(client as PoolClient & RetentionQueryable);
    } finally {
      try {
        if (locked) {
          await client.query("select pg_advisory_unlock($1)", [RETENTION_ADVISORY_LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    }
  }

  async #runRetention(queryable: RetentionQueryable, summary: MetadataRetentionRunSummary): Promise<void> {
      const now = this.#now();

      if (this.#historyEventRetentionDays !== undefined) {
        summary.historyEvents = await deleteHistoryEvents(
          queryable,
          daysBefore(now, this.#historyEventRetentionDays),
          this.#batchLimit
        );
      }

      if (this.#sessionEventRetentionDays !== undefined) {
        summary.sessionEvents = await deleteSessionEvents(
          queryable,
          daysBefore(now, this.#sessionEventRetentionDays),
          this.#batchLimit
        );
      }

      if (this.#runRetentionDays !== undefined) {
        summary.runs = await deleteTerminalRuns(queryable, daysBefore(now, this.#runRetentionDays), this.#batchLimit);
      }

      if (summary.historyEvents > 0 || summary.sessionEvents > 0 || summary.runs > 0) {
        this.#logger.info?.(
          `Pruned Postgres metadata rows: history_events=${summary.historyEvents}, session_events=${summary.sessionEvents}, runs=${summary.runs}.`
        );
      }
  }
}
