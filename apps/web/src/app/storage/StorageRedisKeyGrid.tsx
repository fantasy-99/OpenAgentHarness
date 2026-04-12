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
          <thead>
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={props.items.length > 0 && props.items.every((item) => props.selectedKeys.includes(item.key))}
                  onChange={() => props.onToggleSelectAll(props.items.map((item) => item.key))}
                />
              </th>
              <th className="px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">key</th>
              <th className="px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">type</th>
              <th className="px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">size</th>
              <th className="px-3 py-2 font-medium uppercase tracking-[0.14em] text-muted-foreground">ttl</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item, index) => (
              <tr
                key={item.key}
                className={cn(
                  "data-grid-row cursor-pointer align-top",
                  index % 2 === 0 ? "data-grid-row-even" : "data-grid-row-odd",
                  props.selectedKey === item.key ? "data-grid-row-selected" : ""
                )}
                onClick={() => props.onSelect(item.key)}
              >
                <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={props.selectedKeys.includes(item.key)} onChange={() => props.onToggleSelected(item.key)} />
                </td>
                <td className="max-w-[520px] px-3 py-2">
                  <div className="break-all text-xs leading-6 text-foreground/80">{item.key}</div>
                </td>
                <td className="px-3 py-2">{item.type}</td>
                <td className="px-3 py-2">{item.size ?? "n/a"}</td>
                <td className="px-3 py-2">{item.ttlMs !== undefined ? `${item.ttlMs}ms` : "persistent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
