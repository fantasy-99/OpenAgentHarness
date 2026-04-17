import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Download, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { useUiStore } from "../stores/ui-store";
import { downloadJsonFile, formatTimestamp, prettyJson, toneBadgeClass, type ConsoleFilter, type RuntimeConsoleEntry } from "../support";

const filters: Array<{ id: ConsoleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "errors", label: "Errors" },
  { id: "runs", label: "Runs" },
  { id: "tools", label: "Tools" },
  { id: "hooks", label: "Hooks" },
  { id: "model", label: "Model" },
  { id: "system", label: "System" }
];

function levelBadgeClass(level: RuntimeConsoleEntry["level"]) {
  switch (level) {
    case "error":
      return toneBadgeClass("rose");
    case "warn":
      return toneBadgeClass("amber");
    case "debug":
      return toneBadgeClass("sky");
    default:
      return toneBadgeClass("emerald");
  }
}

interface RuntimeConsolePanelProps {
  isOpen: boolean;
  entries: RuntimeConsoleEntry[];
  onEntryInspect: (entry: RuntimeConsoleEntry) => void;
}

function RuntimeConsolePanelImpl(props: RuntimeConsolePanelProps) {
  const height = useUiStore((state) => state.consoleHeight);
  const onHeightChange = useUiStore((state) => state.setConsoleHeight);
  const filter = useUiStore((state) => state.consoleFilter);
  const onFilterChange = useUiStore((state) => state.setConsoleFilter);
  const setConsoleOpen = useUiStore((state) => state.setConsoleOpen);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const visibleEntries = useMemo(() => {
    const searchQuery = search.trim().toLowerCase();
    return props.entries.filter((entry) => {
      const filterMatches =
        filter === "all"
          ? true
          : filter === "errors"
            ? entry.level === "error" || entry.level === "warn"
            : filter === "runs"
              ? entry.category === "run" || entry.category === "agent"
              : filter === "tools"
                ? entry.category === "tool"
                : filter === "hooks"
                  ? entry.category === "hook"
                  : filter === "model"
                    ? entry.category === "model"
                    : entry.category === "system" || entry.category === "http";

      if (!filterMatches) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const searchable = `${entry.message}\n${entry.details ? prettyJson(entry.details) : ""}`.toLowerCase();
      return searchable.includes(searchQuery);
    });
  }, [props.entries, filter, search]);

  useEffect(() => {
    if (autoScroll && props.isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [autoScroll, props.isOpen, visibleEntries]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const minHeight = 170;
      const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.72));
      const nextHeight = dragState.startHeight + (dragState.startY - event.clientY);
      onHeightChange(Math.min(maxHeight, Math.max(minHeight, nextHeight)));
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onHeightChange]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <section className="console-surface" style={{ height }}>
      <div
        className={cn(
          "console-resizer h-2 cursor-ns-resize transition-colors",
          dragging ? "console-resizer-active" : undefined
        )}
        onPointerDown={(event) => {
          dragStateRef.current = { startY: event.clientY, startHeight: height };
          setDragging(true);
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
        }}
      />
      <div className="flex h-[calc(100%-8px)] min-h-0 flex-col">
        <div className="console-divider flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/56">Console</span>
            <Badge variant="secondary">{visibleEntries.length}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onFilterChange(option.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition",
                  filter === option.id
                    ? "console-filter-chip-active"
                    : "console-filter-chip"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs" className="h-8 pl-8 text-xs" />
            </div>
            <div className="console-chip flex items-center gap-2 rounded-full px-2.5 py-1.5">
              <Switch checked={autoScroll} onCheckedChange={setAutoScroll} size="sm" />
              <span className="text-[11px] text-muted-foreground">Auto-scroll</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => downloadJsonFile(`runtime-console-${new Date().toISOString()}.json`, visibleEntries)}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => setConsoleOpen(false)} aria-label="Close console">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportProps={{ className: "px-2 py-2" }}>
          {visibleEntries.length === 0 ? (
            <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">No console entries yet.</div>
          ) : (
            <div className="space-y-2 pb-2 font-mono text-xs">
              {visibleEntries.map((entry) => {
                const isExpanded = expandedIds.has(entry.id);
                return (
                  <article
                    key={entry.id}
                    className={cn(
                      "rounded-2xl border px-3 py-2 transition",
                      entry.level === "error"
                        ? toneBadgeClass("rose")
                        : "console-entry"
                    )}
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="pt-0.5 text-[11px] text-muted-foreground">{formatTimestamp(entry.timestamp)}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${levelBadgeClass(entry.level)}`}>
                        {entry.level}
                      </span>
                      <span className="console-chip rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-foreground/68">
                        {entry.category}
                      </span>
                      {entry.runId ? (
                        <button
                          type="button"
                          onClick={() => props.onEntryInspect(entry)}
                          className="console-chip rounded-full px-2 py-0.5 text-[10px] text-foreground/68 hover:text-foreground"
                        >
                          {entry.runId}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left text-foreground/84"
                        onClick={() => {
                          if (entry.details !== undefined) {
                            setExpandedIds((current) => {
                              const next = new Set(current);
                              if (next.has(entry.id)) {
                                next.delete(entry.id);
                              } else {
                                next.add(entry.id);
                              }
                              return next;
                            });
                            return;
                          }

                          if (entry.eventId || entry.runId || entry.stepId) {
                            props.onEntryInspect(entry);
                          }
                        }}
                      >
                        <span className="whitespace-pre-wrap break-words leading-6">{entry.message}</span>
                      </button>
                    </div>
                    {entry.details !== undefined && isExpanded ? (
                      <pre className="console-detail mt-2 max-h-56 overflow-auto rounded-xl p-3 text-[11px] leading-6">
                        {prettyJson(entry.details)}
                      </pre>
                    ) : null}
                  </article>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        <div className="console-divider flex flex-wrap items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>{visibleEntries.length} visible entries</span>
          <span>{props.entries.filter((entry) => entry.level === "error").length} errors</span>
          <span>{props.entries.filter((entry) => entry.category === "tool").length} tool events</span>
        </div>
      </div>
    </section>
  );
}

export const RuntimeConsolePanel = memo(RuntimeConsolePanelImpl);
