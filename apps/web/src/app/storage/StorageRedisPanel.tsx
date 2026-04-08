import type { StorageOverview, StorageRedisKeyDetail, StorageRedisKeyPage } from "@oah/api-contracts";
import { RefreshCw } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../primitives";
import { StoragePanelToolbar } from "./StoragePanelToolbar";
import { StorageRedisKeyGrid } from "./StorageRedisKeyGrid";
import { StorageSurfaceLayout } from "./StorageSurfaceLayout";
import { renderStorageEmptyDetail, renderStorageRedisDetail } from "./storage-detail-renderers";
import { StorageToolbarMeta } from "./storage-meta";

export function StorageRedisPanel(props: {
  overview: StorageOverview | null;
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
  const selectedCount = props.selectedRedisKeys.length;

  return (
    <section className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[5.25rem_minmax(0,1fr)] gap-4 overflow-hidden">
      {!props.overview?.redis.available ? (
        <EmptyState title="Redis unavailable" description="当前服务没有启用 Redis，或者 Redis 暂时不可达。" />
      ) : (
        <>
          <StoragePanelToolbar
            leading={
              <>
                <Badge variant="secondary">Redis Keys</Badge>
                <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
                {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
              </>
            }
            meta={
              <>
                <StorageToolbarMeta label="dbsize" value={props.overview.redis.dbSize ?? 0} />
                <StorageToolbarMeta label="ready" value={props.overview.redis.readyQueue?.length ?? 0} />
              </>
            }
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={props.onRefreshKeys} disabled={props.busy}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Button variant="destructive" onClick={props.onDeleteSelectedKeys} disabled={props.busy || selectedCount === 0}>
                  Delete Selected
                </Button>
              </>
            }
          />

          <StorageSurfaceLayout
            detailTitle="Key Detail"
            detailSummary={
              props.redisKeyDetail?.key ? (
                <span className="block break-all">{props.redisKeyDetail.key}</span>
              ) : (
                "Pick a key from the list or from the queue / lock snapshots."
              )
            }
            detailAction={
              <div className="flex flex-nowrap justify-end gap-2 whitespace-nowrap">
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
            }
            detailBody={
              props.redisKeyDetail
                ? renderStorageRedisDetail(props.redisKeyDetail)
                : renderStorageEmptyDetail("No key selected", "Choose a Redis key to inspect its current value and metadata.")
            }
            previewMeta={
              <>
                <Badge variant="outline">{props.redisKeyPage?.items.length ?? 0} loaded</Badge>
                {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
              </>
            }
            previewContent={
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
            }
            previewFooter={
              props.redisKeyPage?.nextCursor ? (
                <Button variant="ghost" size="sm" onClick={props.onLoadMoreKeys} disabled={props.busy}>
                  Load More
                </Button>
              ) : undefined
            }
          />
        </>
      )}
    </section>
  );
}
