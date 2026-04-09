import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { downloadJsonFile, formatTimestamp, prettyJson, type ConsoleFilter, type RuntimeConsoleEntry } from "../support";

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
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
    case "debug":
      return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
}

interface RuntimeConsolePanelProps {
  isOpen: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  filter: ConsoleFilter;
  onFilterChange: (filter: ConsoleFilter) => void;
  entries: RuntimeConsoleEntry[];
  onEntryInspect: (entry: RuntimeConsoleEntry) => void;
}

export function RuntimeConsolePanel(props: RuntimeConsolePanelProps) {
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
        props.filter === "all"
          ? true
          : props.filter === "errors"
            ? entry.level === "error" || entry.level === "warn"
            : props.filter === "runs"
              ? entry.category === "run" || entry.category === "agent"
              : props.filter === "tools"
                ? entry.category === "tool"
                : props.filter === "hooks"
                  ? entry.category === "hook"
                  : props.filter === "model"
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
  }, [props.entries, props.filter, search]);

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
      props.onHeightChange(Math.min(maxHeight, Math.max(minHeight, nextHeight)));
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
  }, [props]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <section className="border-t border-black/8 bg-[linear-gradient(180deg,rgba(252,252,250,0.96)_0%,rgba(241,241,238,0.98)_100%)] shadow-[0_-18px_44px_-38px_rgba(17,17,17,0.32)]" style={{ height: props.height }}>
      <div
        className={cn(
          "h-2 cursor-ns-resize border-b border-black/6 bg-black/[0.035] transition-colors hover:bg-black/[0.08]",
          dragging ? "bg-black/[0.1]" : undefined
        )}
        onPointerDown={(event) => {
          dragStateRef.current = { startY: event.clientY, startHeight: props.height };
          setDragging(true);
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
        }}
      />
      <div className="flex h-[calc(100%-8px)] min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-black/6 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/56">Console</span>
            <Badge variant="secondary">{visibleEntries.length}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {filters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => props.onFilterChange(filter.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition",
                  props.filter === filter.id
                    ? "border-black/10 bg-foreground text-background"
                    : "border-black/8 bg-white/76 text-foreground/62 hover:bg-white hover:text-foreground"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs" className="h-8 pl-8 text-xs" />
            </div>
            <div className="flex items-center gap-2 rounded-full border border-black/8 bg-white/74 px-2.5 py-1.5">
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
            <Button type="button" variant="ghost" size="icon" onClick={props.onClose} aria-label="Close console">
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
                      "rounded-2xl border px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.62)] transition",
                      entry.level === "error"
                        ? "border-rose-200/80 bg-rose-50/70 dark:border-rose-800/80 dark:bg-rose-950/25"
                        : "border-black/8 bg-white/66 hover:bg-white/84"
                    )}
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="pt-0.5 text-[11px] text-muted-foreground">{formatTimestamp(entry.timestamp)}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${levelBadgeClass(entry.level)}`}>
                        {entry.level}
                      </span>
                      <span className="rounded-full border border-black/8 bg-black/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-foreground/68">
                        {entry.category}
                      </span>
                      {entry.runId ? (
                        <button
                          type="button"
                          onClick={() => props.onEntryInspect(entry)}
                          className="rounded-full border border-black/8 bg-white/80 px-2 py-0.5 text-[10px] text-foreground/68 hover:text-foreground"
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
                      <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-black/8 bg-black/[0.03] p-3 text-[11px] leading-6 text-foreground/74">
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

        <div className="flex flex-wrap items-center gap-3 border-t border-black/6 px-3 py-2 text-[11px] text-muted-foreground">
          <span>{visibleEntries.length} visible entries</span>
          <span>{props.entries.filter((entry) => entry.level === "error").length} errors</span>
          <span>{props.entries.filter((entry) => entry.category === "tool").length} tool events</span>
        </div>
      </div>
    </section>
  );
}
