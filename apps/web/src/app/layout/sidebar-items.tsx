import { Bot, ChevronDown, ChevronRight, Folder, MoreHorizontal, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

import { formatTimestamp, type SavedSessionRecord, type SavedWorkspaceRecord } from "../support";

function itemClass(active: boolean) {
  return active
    ? "bg-foreground/[0.045] border border-foreground/10 shadow-[0_1px_0_rgba(255,255,255,0.72)]"
    : "border border-transparent hover:bg-background/60";
}

export function WorkspaceNavItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  expanded: boolean;
  sessionCount: number;
  canRemove: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
}) {
  const ExpandIcon = props.expanded ? ChevronDown : ChevronRight;
  const subtitle = [props.entry.template, `${props.sessionCount} sessions`, props.entry.lastOpenedAt ? formatTimestamp(props.entry.lastOpenedAt) : undefined]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${itemClass(props.active)}`}>
      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground" onClick={props.onToggleExpanded}>
        <ExpandIcon className="h-3.5 w-3.5" />
      </Button>
      <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={props.onSelect}>
        <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${props.active ? "text-foreground" : "text-muted-foreground"}`}>
          <Folder className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.name}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </button>
      {props.sessionCount > 0 ? <Badge variant="secondary" className="rounded-sm px-1.5 py-0 text-[10px]">{props.sessionCount}</Badge> : null}
      {props.canRemove ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/60 opacity-70 transition hover:opacity-100 hover:text-foreground">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={props.onRemove}>
              <Trash2 className="h-4 w-4" />
              Delete Workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function SessionNavItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const subtitle = [props.entry.agentName, formatTimestamp(props.entry.lastOpenedAt || props.entry.createdAt)].filter(Boolean).join(" · ");

  return (
    <div className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${itemClass(props.active)}`}>
      <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={props.onSelect}>
        <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${props.active ? "text-foreground" : "text-muted-foreground"}`}>
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/60 opacity-70 transition hover:opacity-100 hover:text-foreground">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={props.onRemove}>
            <Trash2 className="h-4 w-4" />
            Remove Session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
