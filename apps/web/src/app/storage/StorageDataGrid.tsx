import type { StoragePostgresTableName } from "@oah/api-contracts";

import { EmptyState } from "../primitives";
import { cn } from "../../lib/utils";
import { contentPreview, isRecord, normalizeMessageContent, prettyJson } from "../support";

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

export function StorageDataGrid(props: {
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
    <div className="data-grid-shell flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-foreground/80">
          <thead>
            <tr>
              {props.columns.map((column) => (
                <th key={column} className="px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">
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
                  "data-grid-row cursor-pointer align-top",
                  index % 2 === 0 ? "data-grid-row-even" : "data-grid-row-odd",
                  props.selectedRow === row ? "data-grid-row-selected" : ""
                )}
                onClick={() => props.onSelectRow(row)}
              >
                {props.columns.map((column) => (
                  <td key={`${index}:${column}`} className="max-w-[280px] px-3 py-2">
                    <div
                      className="line-clamp-4 break-words text-xs leading-6 text-foreground/80"
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
