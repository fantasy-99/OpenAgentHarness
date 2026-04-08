import type { ReactNode } from "react";

export function StoragePanelToolbar(props: {
  leading: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="grid h-[5.25rem] shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[2.25rem_1.75rem] gap-x-3 gap-y-2 border-b border-border/70 pb-3">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">{props.leading}</div>
      <div className="flex min-w-[12rem] max-w-[48%] items-center justify-end gap-2 overflow-x-auto whitespace-nowrap">
        {props.actions ?? <div className="h-9 w-[12rem]" />}
      </div>
      <div className="col-span-2 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
        {props.meta ?? <div className="h-7" />}
      </div>
    </div>
  );
}
