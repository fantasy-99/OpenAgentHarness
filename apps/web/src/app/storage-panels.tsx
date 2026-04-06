import { Download, RefreshCw } from "lucide-react";

import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisKeyDetail,
  StorageRedisKeyPage
} from "@oah/api-contracts";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

import {
  contentPreview,
  contentText,
  contentToolRefs,
  formatTimestamp,
  isRecord,
  normalizeMessageContent,
  prettyJson,
  statusTone,
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow,
  toModelCallTrace,
  type StorageBrowserTab
} from "./support";
import { CatalogLine, EmptyState, InsightRow, InspectorTabButton, JsonBlock, PayloadValueView, modelMessageTone } from "./primitives";
import { InspectorPanelHeader, MessageContentDetail, MessageToolRefChips, ModelCallTraceCard } from "./inspector-panels";

function StorageWorkbench(props: {
  browserTab: StorageBrowserTab;
  onBrowserTabChange: (tab: StorageBrowserTab) => void;
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  storageTableSearch: string;
  onStorageTableSearchChange: (value: string) => void;
  storageTableWorkspaceId: string;
  onStorageTableWorkspaceIdChange: (value: string) => void;
  storageTableSessionId: string;
  onStorageTableSessionIdChange: (value: string) => void;
  storageTableRunId: string;
  onStorageTableRunIdChange: (value: string) => void;
  onSelectTable: (table: StoragePostgresTableName) => void;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshOverview: () => void;
  onRefreshTable: () => void;
  onPreviousTablePage: () => void;
  onNextTablePage: () => void;
  onClearTableFilters: () => void;
  onDownloadTableCsv: () => void;
  onRefreshRedisKeys: () => void;
  onLoadMoreRedisKeys: () => void;
  onRefreshRedisKey: () => void;
  onDeleteRedisKey: () => void;
  onDeleteSelectedRedisKeys: () => void;
  onClearRedisSessionQueue: (key: string) => void;
  onReleaseRedisSessionLock: (key: string) => void;
  busy: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="ob-section p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="segmented-shell">
            <InspectorTabButton
              label={`Postgres${props.overview?.postgres.available ? ` · ${props.overview.postgres.tables.length}` : ""}`}
              active={props.browserTab === "postgres"}
              onClick={() => props.onBrowserTabChange("postgres")}
            />
            <InspectorTabButton
              label={`Redis${props.overview?.redis.available ? ` · ${props.overview.redis.dbSize ?? 0}` : ""}`}
              active={props.browserTab === "redis"}
              onClick={() => props.onBrowserTabChange("redis")}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={props.onRefreshOverview} disabled={props.busy}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          <StorageBackendSummaryCard
            title="Postgres"
            status={props.overview?.postgres.available ? "connected" : props.overview?.postgres.configured ? "degraded" : "not configured"}
            description={
              props.overview?.postgres.database
                ? `database ${props.overview.postgres.database}`
                : "当前服务没有启用 Postgres 持久化。"
            }
            details={[
              `configured: ${props.overview?.postgres.configured ? "yes" : "no"}`,
              `primary: ${props.overview?.postgres.primaryStorage ? "yes" : "no"}`,
              `tables: ${props.overview?.postgres.tables.length ?? 0}`
            ]}
          />
          <StorageBackendSummaryCard
            title="Redis"
            status={props.overview?.redis.available ? "connected" : props.overview?.redis.configured ? "degraded" : "not configured"}
            description={
              props.overview?.redis.available
                ? `prefix ${props.overview.redis.keyPrefix} · dbsize ${props.overview.redis.dbSize ?? 0}`
                : "当前服务没有启用 Redis 或 Redis 当前不可达。"
            }
            details={[
              `configured: ${props.overview?.redis.configured ? "yes" : "no"}`,
              `event bus: ${props.overview?.redis.eventBusEnabled ? "yes" : "no"}`,
              `run queue: ${props.overview?.redis.runQueueEnabled ? "yes" : "no"}`
            ]}
          />
        </div>
      </div>

      <div className="grid gap-3">
        {props.browserTab === "postgres" ? (
          <StoragePostgresPanel
            overview={props.overview}
            tablePage={props.tablePage}
            selectedTable={props.selectedTable}
            selectedRow={props.selectedRow}
            onSelectRow={props.onSelectRow}
            search={props.storageTableSearch}
            onSearchChange={props.onStorageTableSearchChange}
            workspaceId={props.storageTableWorkspaceId}
            onWorkspaceIdChange={props.onStorageTableWorkspaceIdChange}
            sessionId={props.storageTableSessionId}
            onSessionIdChange={props.onStorageTableSessionIdChange}
            runId={props.storageTableRunId}
            onRunIdChange={props.onStorageTableRunIdChange}
            onSelectTable={props.onSelectTable}
            onRefresh={props.onRefreshTable}
            onPreviousPage={props.onPreviousTablePage}
            onNextPage={props.onNextTablePage}
            onClearFilters={props.onClearTableFilters}
            onDownloadCsv={props.onDownloadTableCsv}
            busy={props.busy}
          />
        ) : null}
        {props.browserTab === "redis" ? (
          <StorageRedisPanel
            overview={props.overview}
            redisKeyPattern={props.redisKeyPattern}
            onRedisKeyPatternChange={props.onRedisKeyPatternChange}
            redisKeyPage={props.redisKeyPage}
            selectedRedisKey={props.selectedRedisKey}
            selectedRedisKeys={props.selectedRedisKeys}
            onSelectedRedisKeysChange={props.onSelectedRedisKeysChange}
            onSelectRedisKey={props.onSelectRedisKey}
            redisKeyDetail={props.redisKeyDetail}
            onRefreshKeys={props.onRefreshRedisKeys}
            onLoadMoreKeys={props.onLoadMoreRedisKeys}
            onRefreshKey={props.onRefreshRedisKey}
            onDeleteKey={props.onDeleteRedisKey}
            onDeleteSelectedKeys={props.onDeleteSelectedRedisKeys}
            onClearSessionQueue={props.onClearRedisSessionQueue}
            onReleaseSessionLock={props.onReleaseRedisSessionLock}
            busy={props.busy}
          />
        ) : null}
      </div>
    </section>
  );
}

function StorageBackendSummaryCard(props: {
  title: string;
  status: string;
  description: string;
  details: string[];
}) {
  return (
    <div className="ob-subsection p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <Badge className={statusTone(props.status === "connected" ? "completed" : props.status === "degraded" ? "failed" : "queued")}>
          {props.status}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-6 text-[color:var(--foreground)]">{props.description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.details.map((detail) => (
          <Badge key={detail}>{detail}</Badge>
        ))}
      </div>
    </div>
  );
}

function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  workspaceId: string;
  onWorkspaceIdChange: (value: string) => void;
  sessionId: string;
  onSessionIdChange: (value: string) => void;
  runId: string;
  onRunIdChange: (value: string) => void;
  onSelectTable: (table: StoragePostgresTableName) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onClearFilters: () => void;
  onDownloadCsv: () => void;
  busy: boolean;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
        <InspectorPanelHeader
        title="Postgres"
        description="Select a table, filter rows, and inspect details."
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={props.busy || !props.overview?.postgres.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Table
          </Button>
        }
      />

      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {props.overview.postgres.tables.map((table) => (
              <button
                key={table.name}
                className={cn(
                  "rounded-[16px] border p-3 text-left transition",
                  props.selectedTable === table.name
                    ? "border-[rgba(19,35,63,0.12)] bg-white/88"
                    : "border-[color:var(--border)] bg-white/62 hover:bg-white/78"
                )}
                onClick={() => props.onSelectTable(table.name)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[color:var(--foreground)]">{table.name}</p>
                  <Badge>{table.rowCount}</Badge>
                </div>
                <p className="mt-2 text-xs leading-6 text-[color:var(--muted-foreground)]">{table.description}</p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">{table.orderBy}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-2 xl:grid-cols-[minmax(220px,1.4fr)_minmax(160px,0.8fr)_minmax(160px,0.8fr)_minmax(160px,0.8fr)_auto_auto]">
            <Input value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Search row JSON" />
            <Input value={props.workspaceId} onChange={(event) => props.onWorkspaceIdChange(event.target.value)} placeholder="workspaceId" />
            <Input value={props.sessionId} onChange={(event) => props.onSessionIdChange(event.target.value)} placeholder="sessionId" />
            <Input value={props.runId} onChange={(event) => props.onRunIdChange(event.target.value)} placeholder="runId" />
            <Button variant="secondary" onClick={props.onRefresh} disabled={props.busy}>
              Apply
            </Button>
            <Button variant="ghost" onClick={props.onClearFilters} disabled={props.busy}>
              Clear
            </Button>
          </div>

          {props.tablePage ? (
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
              <div className="subtle-panel space-y-3 rounded-[20px] border border-[color:var(--border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.tablePage.table}</p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {props.tablePage.rowCount} rows · ordered by {props.tablePage.orderBy}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {props.tablePage.appliedFilters ? <Badge>filtered</Badge> : null}
                    <Badge>{props.tablePage.rows.length} preview rows</Badge>
                    <Button variant="ghost" size="sm" onClick={props.onDownloadCsv}>
                      <Download className="h-4 w-4" />
                      CSV
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-[color:var(--muted-foreground)]">
                    offset {props.tablePage.offset} · limit {props.tablePage.limit}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={props.onPreviousPage} disabled={props.busy || props.tablePage.offset === 0}>
                      Prev
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={props.onNextPage}
                      disabled={props.busy || props.tablePage.nextOffset === undefined}
                    >
                      Next
                    </Button>
                  </div>
                </div>
                <StorageDataGrid
                  tableName={props.tablePage.table}
                  columns={props.tablePage.columns}
                  rows={props.tablePage.rows}
                  selectedRow={props.selectedRow}
                  onSelectRow={props.onSelectRow}
                />
              </div>
              <div className="subtle-panel space-y-3 rounded-[20px] border border-[color:var(--border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--foreground)]">
                      {props.tablePage.table === "messages"
                        ? "Message Detail"
                        : props.tablePage.table === "run_steps"
                          ? "Run Step Detail"
                          : props.tablePage.table === "tool_calls"
                            ? "Tool Call Detail"
                            : props.tablePage.table === "session_events"
                              ? "Session Event Detail"
                          : "Row Detail"}
                    </p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {props.tablePage.table === "messages"
                        ? "messages 表会按 AI SDK 风格拆开 content，直接查看 role、parts 和 tool trace。"
                        : props.tablePage.table === "run_steps"
                          ? "run_steps 表会优先给出结构化 step 视图，model_call 会直接还原成 LLM trace。"
                          : props.tablePage.table === "tool_calls"
                            ? "tool_calls 表会拆出工具审计的 request / response，方便直接核对实际调度参数。"
                            : props.tablePage.table === "session_events"
                              ? "session_events 表会优先解释常见事件 payload，message 内容会直接按 AI SDK 风格显示。"
                          : "点选表格行后，在这里查看完整字段和值。"}
                    </p>
                  </div>
                  {props.selectedRow ? <Badge>selected</Badge> : null}
                </div>
                {props.selectedRow ? (
                  props.tablePage.table === "messages" ? (
                    <StorageMessageRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "run_steps" ? (
                    <StorageRunStepRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "tool_calls" ? (
                    <StorageToolCallRowDetail row={props.selectedRow} />
                  ) : props.tablePage.table === "session_events" ? (
                    <StorageSessionEventRowDetail row={props.selectedRow} />
                  ) : (
                    <JsonBlock title="Row" value={props.selectedRow} />
                  )
                ) : (
                  <EmptyState title="No row selected" description="Select a row from the table to inspect the full record." />
                )}
              </div>
            </div>
          ) : (
            <EmptyState title="No table selected" description="Select a Postgres table to inspect recent rows." />
          )}
        </>
      )}
    </section>
  );
}

function StorageRedisPanel(props: {
  overview: StorageOverview | null;
  redisKeyPattern: string;
  onRedisKeyPatternChange: (value: string) => void;
  redisKeyPage: StorageRedisKeyPage | null;
  selectedRedisKey: string;
  selectedRedisKeys: string[];
  onSelectedRedisKeysChange: (keys: string[]) => void;
  onSelectRedisKey: (key: string) => void;
  redisKeyDetail: StorageRedisKeyDetail | null;
  onRefreshKeys: () => void;
  onLoadMoreKeys: () => void;
  onRefreshKey: () => void;
  onDeleteKey: () => void;
  onDeleteSelectedKeys: () => void;
  onClearSessionQueue: (key: string) => void;
  onReleaseSessionLock: (key: string) => void;
  busy: boolean;
}) {
  return (
    <section className="panel-card space-y-3 rounded-[24px] border p-4">
        <InspectorPanelHeader
        title="Redis"
        description="Inspect queues, locks, buffers, and key values."
        action={
          <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy || !props.overview?.redis.available}>
            <RefreshCw className="h-4 w-4" />
            Refresh Keys
          </Button>
        }
      />

      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <CatalogLine label="dbsize" value={props.overview.redis.dbSize ?? 0} />
            <CatalogLine label="ready queue" value={props.overview.redis.readyQueue?.length ?? 0} />
            <CatalogLine label="session queues" value={props.overview.redis.sessionQueues.length} />
            <CatalogLine label="session locks" value={props.overview.redis.sessionLocks.length} />
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
            <div className="space-y-3">
              <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-3">
                <p className="mb-3 text-xs font-medium text-[color:var(--muted-foreground)]">Queues And Locks</p>
                <div className="space-y-4">
                  <StorageKeySummaryList
                    title="Session Queues"
                    items={props.overview.redis.sessionQueues.map((item) => ({
                      label: item.sessionId,
                      value: `${item.length} items`,
                      keyName: item.key
                    }))}
                    emptyLabel="No queued sessions."
                    onSelect={props.onSelectRedisKey}
                    actionLabel="Clear"
                    onAction={props.onClearSessionQueue}
                  />
                  <StorageKeySummaryList
                    title="Session Locks"
                    items={props.overview.redis.sessionLocks.map((item) => ({
                      label: item.sessionId,
                      value: item.ttlMs !== undefined ? `${item.ttlMs}ms` : "ttl n/a",
                      keyName: item.key
                    }))}
                    emptyLabel="No active session locks."
                    onSelect={props.onSelectRedisKey}
                    actionLabel="Release"
                    onAction={props.onReleaseSessionLock}
                  />
                  <StorageKeySummaryList
                    title="Event Buffers"
                    items={props.overview.redis.eventBuffers.map((item) => ({
                      label: item.sessionId,
                      value: `${item.length} events`,
                      keyName: item.key
                    }))}
                    emptyLabel="No session event buffers."
                    onSelect={props.onSelectRedisKey}
                  />
                </div>
              </div>
              <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-3">
                <div className="flex gap-2">
                  <Input value={props.redisKeyPattern} onChange={(event) => props.onRedisKeyPatternChange(event.target.value)} placeholder="oah:*" />
                  <Button variant="secondary" onClick={props.onRefreshKeys} disabled={props.busy}>
                    Load
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={props.onDeleteSelectedKeys}
                    disabled={props.busy || props.selectedRedisKeys.length === 0}
                  >
                    Delete Selected
                  </Button>
                </div>
                <div className="mt-3">
                  <StorageRedisKeyGrid
                    items={props.redisKeyPage?.items ?? []}
                    selectedKey={props.selectedRedisKey}
                    selectedKeys={props.selectedRedisKeys}
                    onToggleSelected={(key) =>
                      props.onSelectedRedisKeysChange(
                        props.selectedRedisKeys.includes(key)
                          ? props.selectedRedisKeys.filter((entry) => entry !== key)
                          : [...props.selectedRedisKeys, key]
                      )
                    }
                    onToggleSelectAll={(keys) =>
                      props.onSelectedRedisKeysChange(
                        keys.every((key) => props.selectedRedisKeys.includes(key))
                          ? props.selectedRedisKeys.filter((entry) => !keys.includes(entry))
                          : [...new Set([...props.selectedRedisKeys, ...keys])]
                      )
                    }
                    onSelect={props.onSelectRedisKey}
                  />
                  {props.redisKeyPage?.nextCursor ? (
                    <div className="mt-3">
                      <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                        Load More
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="subtle-panel rounded-[18px] border border-[color:var(--border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--foreground)]">Selected Redis Key</p>
                  <p className="text-xs text-[color:var(--muted-foreground)]">{props.redisKeyDetail?.key ?? "Pick a key from the list or snapshot above."}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={props.onRefreshKey} disabled={props.busy || !props.selectedRedisKey}>
                    Refresh
                  </Button>
                  {props.selectedRedisKey.endsWith(":queue") ? (
                    <Button variant="secondary" size="sm" onClick={() => props.onClearSessionQueue(props.selectedRedisKey)} disabled={props.busy}>
                      Clear Queue
                    </Button>
                  ) : null}
                  {props.selectedRedisKey.endsWith(":lock") ? (
                    <Button variant="secondary" size="sm" onClick={() => props.onReleaseSessionLock(props.selectedRedisKey)} disabled={props.busy}>
                      Release Lock
                    </Button>
                  ) : null}
                  <Button variant="destructive" size="sm" onClick={props.onDeleteKey} disabled={props.busy || !props.selectedRedisKey}>
                    Delete Key
                  </Button>
                </div>
              </div>
              {props.redisKeyDetail ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge>{props.redisKeyDetail.type}</Badge>
                    {props.redisKeyDetail.size !== undefined ? <Badge>{`size ${props.redisKeyDetail.size}`}</Badge> : null}
                    {props.redisKeyDetail.ttlMs !== undefined ? <Badge>{`ttl ${props.redisKeyDetail.ttlMs}ms`}</Badge> : null}
                  </div>
                  <JsonBlock title="Value" value={props.redisKeyDetail.value ?? {}} />
                </div>
              ) : (
                <EmptyState title="No key selected" description="Choose a Redis key to inspect its current value and metadata." />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function StorageKeySummaryList(props: {
  title: string;
  items: Array<{ label: string; value: string; keyName: string }>;
  emptyLabel: string;
  onSelect: (key: string) => void;
  actionLabel?: string;
  onAction?: (key: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-[color:var(--muted-foreground)]">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {props.items.map((item) => (
            <div key={item.keyName} className="rounded-[14px] border border-[color:var(--border)] bg-white/78 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => props.onSelect(item.keyName)}>
                  <span className="truncate text-sm font-medium text-[color:var(--foreground)]">{item.label}</span>
                </button>
                <div className="flex items-center gap-2">
                  <Badge>{item.value}</Badge>
                  {props.actionLabel && props.onAction ? (
                    <Button variant="ghost" size="sm" onClick={() => props.onAction?.(item.keyName)}>
                      {props.actionLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
              <button className="mt-1 w-full text-left" onClick={() => props.onSelect(item.keyName)}>
                <p className="break-all text-xs leading-6 text-[color:var(--muted-foreground)]">{item.keyName}</p>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatStorageCellPreview(
  value: unknown,
  options?: {
    tableName?: StoragePostgresTableName;
    columnName?: string;
  }
) {
  if (options?.tableName === "messages" && options.columnName === "content") {
    const normalized = normalizeMessageContent(value);
    if (normalized !== null) {
      return contentPreview(normalized, 180);
    }
  }

  if (options?.tableName === "run_steps" && (options.columnName === "input" || options.columnName === "output") && isRecord(value)) {
    if (options.columnName === "input") {
      const request = isRecord(value.request) ? value.request : {};
      const runtime = isRecord(value.runtime) ? value.runtime : {};

      if (typeof request.model === "string") {
        const messageCount = typeof runtime.messageCount === "number" ? ` · ${runtime.messageCount} msgs` : "";
        return `${request.model}${messageCount}`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} input`;
      }
    }

    if (options.columnName === "output") {
      const response = isRecord(value.response) ? value.response : {};

      if (typeof response.finishReason === "string") {
        const calls = Array.isArray(response.toolCalls) ? response.toolCalls.length : 0;
        const results = Array.isArray(response.toolResults) ? response.toolResults.length : 0;
        return `${response.finishReason} · ${calls} calls · ${results} results`;
      }

      if (typeof value.sourceType === "string") {
        return `${value.sourceType} output`;
      }
    }
  }

  if (options?.tableName === "tool_calls") {
    if (options.columnName === "request" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const actionName = typeof value.actionName === "string" ? value.actionName : undefined;
      if (actionName) {
        return `${actionName}${sourceType ? ` · ${sourceType}` : ""}`;
      }
      return sourceType ? `${sourceType} request` : "request";
    }

    if (options.columnName === "response" && isRecord(value)) {
      const sourceType = typeof value.sourceType === "string" ? value.sourceType : undefined;
      const duration = typeof value.durationMs === "number" ? ` · ${value.durationMs}ms` : "";
      return `${sourceType ?? "response"}${duration}`;
    }
  }

  if (options?.tableName === "session_events" && options.columnName === "data" && isRecord(value)) {
    const normalizedContent = normalizeMessageContent(value.content);
    if (normalizedContent !== null) {
      return contentPreview(normalizedContent, 180);
    }

    if (typeof value.toolName === "string") {
      return `${value.toolName}${typeof value.toolCallId === "string" ? ` · ${value.toolCallId}` : ""}`;
    }

    if (typeof value.status === "string") {
      return value.status;
    }
  }

  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact || " ";
  }

  return `${compact.slice(0, 180)}...`;
}

function StorageDataGrid(props: {
  tableName: StoragePostgresTableName;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown>) => void;
}) {
  if (props.rows.length === 0) {
    return <EmptyState title="No rows" description="This table is currently empty." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-[color:var(--border)] bg-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-slate-700">
          <thead className="bg-[rgba(245,248,252,0.96)]">
            <tr>
              {props.columns.map((column) => (
                <th key={column} className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <tr
                key={`row:${index}`}
                className={cn(
                  "cursor-pointer align-top odd:bg-white even:bg-[rgba(247,250,253,0.78)] hover:bg-[rgba(241,246,252,0.96)]",
                  props.selectedRow === row ? "bg-[rgba(232,239,249,0.96)] even:bg-[rgba(232,239,249,0.96)]" : ""
                )}
                onClick={() => props.onSelectRow(row)}
              >
                {props.columns.map((column) => (
                  <td key={`${index}:${column}`} className="max-w-[280px] border-b border-[color:var(--border)] px-3 py-2">
                    <div
                      className="line-clamp-4 break-words text-xs leading-6 text-slate-700"
                      title={typeof row[column] === "string" ? row[column] : prettyJson(row[column])}
                    >
                      {formatStorageCellPreview(row[column], {
                        tableName: props.tableName,
                        columnName: column
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StorageMessageRowDetail(props: { row: Record<string, unknown> }) {
  const message = storageMessageFromRow(props.row);

  if (!message) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const text = contentText(message.content);
  const refs = contentToolRefs(message.content);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
            {message.role}
          </span>
          {message.runId ? <Badge>{message.runId}</Badge> : null}
          <MessageToolRefChips content={message.content} />
          <Badge>{formatTimestamp(message.createdAt)}</Badge>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Message ID" value={message.id} />
          <InsightRow label="Session ID" value={message.sessionId} />
          <InsightRow label="Parts" value={String(Array.isArray(message.content) ? message.content.length : 1)} />
          <InsightRow label="Text Size" value={String(text.length)} />
        </div>
      </div>

      <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Message Content</p>
        <div className="mt-3">
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-[26rem]" />
        </div>
      </div>

      {refs.length > 0 ? (
        <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Trace</p>
          <div className="mt-3 space-y-2">
            {refs.map((ref, index) => (
              <div key={`${ref.type}:${ref.toolCallId}:${index}`} className="subtle-panel rounded-[16px] border border-[color:var(--border)] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{ref.type}</Badge>
                  <Badge>{ref.toolName}</Badge>
                  <Badge>{ref.toolCallId}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {message.metadata ? <JsonBlock title="Metadata" value={message.metadata} /> : null}
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRunStepRowDetail(props: { row: Record<string, unknown> }) {
  const step = storageRunStepFromRow(props.row);

  if (!step) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const modelTrace = toModelCallTrace(step);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{`step ${step.seq}`}</Badge>
          <Badge>{step.stepType}</Badge>
          <Badge className={statusTone(step.status)}>{step.status}</Badge>
          {step.name ? <Badge>{step.name}</Badge> : null}
          {step.agentName ? <Badge>{step.agentName}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Step ID" value={step.id} />
          <InsightRow label="Run ID" value={step.runId} />
          <InsightRow label="Started" value={formatTimestamp(step.startedAt)} />
          <InsightRow label="Ended" value={formatTimestamp(step.endedAt)} />
        </div>
      </div>

      {modelTrace ? (
        <div className="space-y-3">
          <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
            <InspectorPanelHeader
              title="Model Call Trace"
              description="Storage 里的 run_step 已直接还原成 model call 视图，方便在数据库维度核对一次模型请求与返回。"
            />
          </div>
          <ModelCallTraceCard trace={modelTrace} />
        </div>
      ) : (
        <>
          <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Structured Step Payload</p>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <JsonBlock title="Input" value={step.input ?? {}} />
              <JsonBlock title="Output" value={step.output ?? {}} />
            </div>
          </div>
        </>
      )}

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageToolCallRowDetail(props: { row: Record<string, unknown> }) {
  const record = storageToolCallFromRow(props.row);

  if (!record) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{record.toolName}</Badge>
          <Badge>{record.sourceType}</Badge>
          <Badge className={statusTone(record.status)}>{record.status}</Badge>
          {record.stepId ? <Badge>{record.stepId}</Badge> : null}
          {record.durationMs !== undefined ? <Badge>{`${record.durationMs}ms`}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Tool Call ID" value={record.id} />
          <InsightRow label="Run ID" value={record.runId} />
          <InsightRow label="Started" value={formatTimestamp(record.startedAt)} />
          <InsightRow label="Ended" value={formatTimestamp(record.endedAt)} />
        </div>
      </div>

      <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Audit Payload</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="panel-card overflow-hidden rounded-[22px] border">
            <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
              Request
            </div>
            <div className="p-3">
              <PayloadValueView value={record.request ?? {}} maxHeightClassName="max-h-72" mode="input" />
            </div>
          </div>
          <div className="panel-card overflow-hidden rounded-[22px] border">
            <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
              Response
            </div>
            <div className="p-3">
              <PayloadValueView value={record.response ?? {}} maxHeightClassName="max-h-72" mode="result" />
            </div>
          </div>
        </div>
      </div>

      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageSessionEventRowDetail(props: { row: Record<string, unknown> }) {
  const event = storageSessionEventFromRow(props.row);

  if (!event) {
    return <JsonBlock title="Row" value={props.row} />;
  }

  const eventContent = normalizeMessageContent(event.data.content);

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[color:var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,248,252,0.94))] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{event.event}</Badge>
          {event.runId ? <Badge>{event.runId}</Badge> : null}
          <Badge>{`cursor ${event.cursor}`}</Badge>
          {typeof event.data.toolName === "string" ? <Badge>{String(event.data.toolName)}</Badge> : null}
          {typeof event.data.toolCallId === "string" ? <Badge>{String(event.data.toolCallId)}</Badge> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InsightRow label="Event ID" value={event.id} />
          <InsightRow label="Session ID" value={event.sessionId} />
          <InsightRow label="Created" value={formatTimestamp(event.createdAt)} />
          <InsightRow label="Payload Keys" value={String(Object.keys(event.data).length)} />
        </div>
      </div>

      {eventContent !== null ? (
        <div className="rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Message Payload</p>
          <div className="mt-3">
            <MessageContentDetail content={eventContent} maxHeightClassName="max-h-[24rem]" />
          </div>
        </div>
      ) : null}

      <JsonBlock title="Event Data" value={event.data} />
      <JsonBlock title="Raw Row" value={props.row} />
    </div>
  );
}

function StorageRedisKeyGrid(props: {
  items: StorageRedisKeyPage["items"];
  selectedKey: string;
  selectedKeys: string[];
  onToggleSelected: (key: string) => void;
  onToggleSelectAll: (keys: string[]) => void;
  onSelect: (key: string) => void;
}) {
  if (props.items.length === 0) {
    return <EmptyState title="No keys loaded" description="Load Redis keys by pattern to inspect current keyspace." />;
  }

  return (
    <div className="data-grid-shell overflow-hidden rounded-[18px] border border-[color:var(--border)] bg-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-slate-700">
          <thead className="bg-[rgba(245,248,252,0.96)]">
            <tr>
              <th className="w-10 border-b border-[color:var(--border)] px-3 py-2">
                <input
                  type="checkbox"
                  checked={props.items.length > 0 && props.items.every((item) => props.selectedKeys.includes(item.key))}
                  onChange={() => props.onToggleSelectAll(props.items.map((item) => item.key))}
                />
              </th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">key</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">type</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">size</th>
              <th className="border-b border-[color:var(--border)] px-3 py-2 font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">ttl</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr
                key={item.key}
                className={cn(
                  "cursor-pointer align-top transition odd:bg-white even:bg-[rgba(247,250,253,0.78)] hover:bg-[rgba(241,246,252,0.96)]",
                  props.selectedKey === item.key ? "bg-[rgba(232,239,249,0.96)] even:bg-[rgba(232,239,249,0.96)]" : ""
                )}
                onClick={() => props.onSelect(item.key)}
              >
                <td className="border-b border-[color:var(--border)] px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={props.selectedKeys.includes(item.key)} onChange={() => props.onToggleSelected(item.key)} />
                </td>
                <td className="max-w-[520px] border-b border-[color:var(--border)] px-3 py-2">
                  <div className="break-all text-xs leading-6 text-slate-700">{item.key}</div>
                </td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.type}</td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.size ?? "n/a"}</td>
                <td className="border-b border-[color:var(--border)] px-3 py-2">{item.ttlMs !== undefined ? `${item.ttlMs}ms` : "persistent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { StorageWorkbench };
