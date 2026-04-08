import type { StorageRedisKeyPage } from "@oah/api-contracts";

import { EmptyState } from "../primitives";
import { cn } from "../../lib/utils";

export function StorageRedisKeyGrid(props: {
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
    <div className="data-grid-shell flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-foreground/80">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-border px-3 py-2">
                <input
                  type="checkbox"
                  checked={props.items.length > 0 && props.items.every((item) => props.selectedKeys.includes(item.key))}
                  onChange={() => props.onToggleSelectAll(props.items.map((item) => item.key))}
                />
              </th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">key</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">type</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">size</th>
              <th className="border-b border-border px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">ttl</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr
                key={item.key}
                className={cn(
                  "cursor-pointer align-top transition odd:bg-background even:bg-muted/20 hover:bg-muted/40",
                  props.selectedKey === item.key ? "bg-primary/5 even:bg-primary/5" : ""
                )}
                onClick={() => props.onSelect(item.key)}
              >
                <td className="border-b border-border px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={props.selectedKeys.includes(item.key)} onChange={() => props.onToggleSelected(item.key)} />
                </td>
                <td className="max-w-[520px] border-b border-border px-3 py-2">
                  <div className="break-all text-xs leading-6 text-foreground/80">{item.key}</div>
                </td>
                <td className="border-b border-border px-3 py-2">{item.type}</td>
                <td className="border-b border-border px-3 py-2">{item.size ?? "n/a"}</td>
                <td className="border-b border-border px-3 py-2">{item.ttlMs !== undefined ? `${item.ttlMs}ms` : "persistent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
