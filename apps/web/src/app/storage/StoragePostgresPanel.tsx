import type { StorageOverview, StoragePostgresTableName, StoragePostgresTablePage } from "@oah/api-contracts";
import { Download, RefreshCw } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../primitives";
import { StorageDataGrid } from "./StorageDataGrid";
import { StoragePanelToolbar } from "./StoragePanelToolbar";
import { StorageSurfaceLayout } from "./StorageSurfaceLayout";
import { getStoragePostgresDetailTitle, renderStorageEmptyDetail, renderStoragePostgresRowDetail } from "./storage-detail-renderers";
import { STORAGE_TABLE_META, StorageToolbarMeta } from "./storage-meta";

export function StoragePostgresPanel(props: {
  overview: StorageOverview | null;
  tablePage: StoragePostgresTablePage | null;
  selectedTable: StoragePostgresTableName;
  selectedRow: Record<string, unknown> | null;
  onSelectRow: (row: Record<string, unknown> | null) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onDownloadCsv: () => void;
  busy: boolean;
}) {
  const selectedMeta = STORAGE_TABLE_META[props.selectedTable];

  return (
    <section className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[5.25rem_minmax(0,1fr)] gap-4 overflow-hidden">
      {!props.overview?.postgres.available ? (
        <EmptyState title="Postgres unavailable" description="当前服务没有启用 Postgres，或者 Postgres 暂时不可达。" />
      ) : props.tablePage ? (
        <>
          <StoragePanelToolbar
            leading={
              <>
                <Badge variant="secondary">{selectedMeta.label}</Badge>
                {props.tablePage.appliedFilters ? <Badge variant="outline">filtered</Badge> : null}
                <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
              </>
            }
            meta={
              <>
                <StorageToolbarMeta label="total" value={props.tablePage.rowCount} />
                <StorageToolbarMeta label="order" value={props.tablePage.orderBy} />
                <StorageToolbarMeta label="offset" value={props.tablePage.offset} />
                <StorageToolbarMeta label="limit" value={props.tablePage.limit} />
              </>
            }
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={props.busy}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onDownloadCsv}>
                  <Download className="h-4 w-4" />
                  CSV
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onPreviousPage} disabled={props.busy || props.tablePage.offset === 0}>
                  Prev
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onNextPage} disabled={props.busy || props.tablePage.nextOffset === undefined}>
                  Next
                </Button>
              </>
            }
          />

          <StorageSurfaceLayout
            detailTitle={getStoragePostgresDetailTitle(props.tablePage.table)}
            detailAction={props.selectedRow ? <Badge variant="outline">selected</Badge> : null}
            detailBody={
              props.selectedRow
                ? renderStoragePostgresRowDetail(props.tablePage.table, props.selectedRow)
                : renderStorageEmptyDetail("No row selected", "Select a row from the preview grid to inspect the stored record.")
            }
            previewMeta={
              <>
                <Badge variant="outline">{props.tablePage.columns.length} cols</Badge>
                <Badge variant="outline">{props.tablePage.rows.length} rows</Badge>
              </>
            }
            previewContent={
              <StorageDataGrid
                tableName={props.tablePage.table}
                columns={props.tablePage.columns}
                rows={props.tablePage.rows}
                selectedRow={props.selectedRow}
                onSelectRow={props.onSelectRow as (row: Record<string, unknown>) => void}
              />
            }
          />
        </>
      ) : (
        <EmptyState title="No table selected" description="Select a Postgres table from the left rail to inspect recent rows." />
      )}
    </section>
  );
}
