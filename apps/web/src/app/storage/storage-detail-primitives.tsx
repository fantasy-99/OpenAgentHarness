import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function StoragePlainRowDetail(props: { row: Record<string, unknown>; prettyJson: (value: unknown) => string }) {
  return (
    <div className="code-panel min-w-0 rounded-xl p-3">
      <pre className="overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">
        {props.prettyJson(props.row)}
      </pre>
    </div>
  );
}

export function StorageDetailFacts(props: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {props.items.map((item) => (
        <div key={item.label} className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{item.label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export function StorageDetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{props.title}</p>
      {props.children}
    </section>
  );
}

export function StorageDetailPre(props: { value: string; maxHeightClassName?: string | undefined }) {
  return (
    <pre
      className={cn(
        "code-panel min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-xl p-3 text-xs leading-6 text-foreground/80",
        props.maxHeightClassName
      )}
    >
      {props.value}
    </pre>
  );
}

export function StorageDetailJson(props: {
  value: unknown;
  prettyJson: (value: unknown) => string;
  maxHeightClassName?: string | undefined;
}) {
  return <StorageDetailPre value={props.prettyJson(props.value)} maxHeightClassName={props.maxHeightClassName} />;
}

export function storageString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "n/a";
}

export function storageOptionalString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function storageCollectionSize(value: unknown) {
  if (Array.isArray(value)) {
    return String(value.length);
  }

  if (value && typeof value === "object") {
    return String(Object.keys(value).length);
  }

  return "0";
}
