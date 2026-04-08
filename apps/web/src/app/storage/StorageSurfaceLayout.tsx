import { GripHorizontal } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";

const STORAGE_SPLIT_RATIO_KEY = "oah.storage.surface.split-ratio";
const STORAGE_SPLIT_DEFAULT_RATIO = 0.34;
const STORAGE_SPLIT_MIN_RATIO = 0.24;
const STORAGE_SPLIT_MAX_RATIO = 0.58;
const STORAGE_SPLIT_HANDLE_HEIGHT = 12;

function clampStorageSplitRatio(value: number) {
  return Math.min(STORAGE_SPLIT_MAX_RATIO, Math.max(STORAGE_SPLIT_MIN_RATIO, value));
}

export function StorageSurfaceLayout(props: {
  detailTitle: string;
  detailSummary?: ReactNode;
  detailAction?: ReactNode;
  detailBody: ReactNode;
  previewTitle?: string;
  previewDescription?: string;
  previewMeta?: ReactNode;
  previewContent: ReactNode;
  previewFooter?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [detailRatio, setDetailRatio] = useState(STORAGE_SPLIT_DEFAULT_RATIO);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedValue = window.localStorage.getItem(STORAGE_SPLIT_RATIO_KEY);
    if (!storedValue) {
      return;
    }

    const parsed = Number(storedValue);
    if (Number.isFinite(parsed)) {
      setDetailRatio(clampStorageSplitRatio(parsed));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(STORAGE_SPLIT_RATIO_KEY, String(detailRatio));
  }, [detailRatio]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    function updateFromClientY(clientY: number) {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const usableHeight = rect.height - STORAGE_SPLIT_HANDLE_HEIGHT;

      if (usableHeight <= 0) {
        return;
      }

      const nextHeight = clientY - rect.top - STORAGE_SPLIT_HANDLE_HEIGHT / 2;
      const nextRatio = clampStorageSplitRatio(nextHeight / usableHeight);
      setDetailRatio(nextRatio);
    }

    function handlePointerMove(event: PointerEvent) {
      updateFromClientY(event.clientY);
    }

    function handlePointerUp() {
      setIsDragging(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDragging]);

  function startDragging() {
    setIsDragging(true);
  }

  function handleSplitterKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    event.preventDefault();

    if (event.key === "Home") {
      setDetailRatio(STORAGE_SPLIT_MIN_RATIO);
      return;
    }

    if (event.key === "End") {
      setDetailRatio(STORAGE_SPLIT_MAX_RATIO);
      return;
    }

    const delta = event.key === "ArrowUp" ? -0.03 : 0.03;
    setDetailRatio((current) => clampStorageSplitRatio(current + delta));
  }

  return (
    <div
      ref={containerRef}
      className="grid h-full min-h-0 min-w-0 overflow-hidden"
      style={{
        gridTemplateRows: `minmax(12rem, ${detailRatio}fr) ${STORAGE_SPLIT_HANDLE_HEIGHT}px minmax(18rem, ${1 - detailRatio}fr)`
      }}
    >
      <section className="grid min-h-0 min-w-0 grid-rows-[3rem_minmax(0,1fr)] overflow-hidden">
        <div className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] grid-rows-[1.25rem_1rem] gap-x-3 gap-y-0.5 overflow-hidden px-1">
          <p className="min-w-0 truncate self-end text-sm font-semibold text-foreground">{props.detailTitle}</p>
          <div className="row-span-2 min-w-0 self-center justify-self-end overflow-hidden">
            {props.detailAction ? <div className="flex justify-end overflow-x-auto whitespace-nowrap">{props.detailAction}</div> : <div className="h-8" />}
          </div>
          <div className="min-w-0 truncate text-xs leading-4 text-muted-foreground">
            {props.detailSummary ?? <span aria-hidden="true">&nbsp;</span>}
          </div>
        </div>
        <div className="min-h-0 min-w-0 overflow-auto px-1 py-2">{props.detailBody}</div>
      </section>

      <div className="flex min-h-0 items-center">
        <button
          type="button"
          aria-label="Resize storage detail and table sections"
          aria-valuemin={Math.round(STORAGE_SPLIT_MIN_RATIO * 100)}
          aria-valuemax={Math.round(STORAGE_SPLIT_MAX_RATIO * 100)}
          aria-valuenow={Math.round(detailRatio * 100)}
          aria-orientation="horizontal"
          className={cn(
            "group relative flex h-3 w-full cursor-row-resize items-center justify-center rounded-full text-muted-foreground/70 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging ? "text-foreground" : "hover:text-foreground"
          )}
          onPointerDown={startDragging}
          onKeyDown={handleSplitterKeyDown}
          role="separator"
        >
          <span
            className={cn(
              "pointer-events-none absolute left-0 right-0 h-px bg-border/80 transition",
              isDragging ? "bg-primary/60" : "group-hover:bg-border group-focus-visible:bg-border"
            )}
          />
          <span
            className={cn(
              "relative z-10 flex h-3 w-20 items-center justify-center rounded-full border border-border/70 bg-background/95 shadow-sm transition",
              isDragging
                ? "scale-105 border-primary/60 bg-primary/10 text-primary shadow-[0_0_0_4px_rgba(59,130,246,0.12)]"
                : "group-hover:border-border group-hover:bg-muted/70 group-hover:shadow group-focus-visible:border-border group-focus-visible:bg-muted/70"
            )}
          >
            <GripHorizontal className={cn("h-3.5 w-3.5 transition", isDragging ? "scale-110" : "")} />
          </span>
        </button>
      </div>

      <section
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{
          gridTemplateRows: props.previewFooter ? "minmax(0,1fr) 2.25rem" : "minmax(0,1fr)"
        }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">{props.previewContent}</div>
        {props.previewFooter ? <div className="flex h-9 items-center">{props.previewFooter}</div> : null}
      </section>
    </div>
  );
}
