import { memo, useMemo, useRef, useState, type ReactNode } from "react";

import { formatSystemProfileDisplayName, type Run } from "@oah/api-contracts";
import {
  Bot,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FileUp,
  FolderPlus,
  Lock,
  Layers3,
  MessageSquareText,
  Network,
  Orbit,
  Palette,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Server,
  Settings2,
  Sparkles,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
  Workflow
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShallow } from "zustand/shallow";

import { useHealthStore } from "../stores/health-store";
import { useModelsStore } from "../stores/models-store";
import { useSettingsStore } from "../stores/settings-store";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { probeTone, streamTone, toneBadgeClass, type MainViewMode, type SavedSessionRecord, type StatusSemanticTone, type SurfaceMode } from "../support";
import { appThemeOptions, isAppThemeName, type AppThemeName } from "../theme";
import type { useAppController } from "../use-app-controller";
import { SessionNavItem, WorkspaceNavItem } from "./sidebar-items";

type SidebarProps = ReturnType<typeof useAppController>["sidebarSurfaceProps"] & {
  theme: AppThemeName;
  onThemeChange: (theme: AppThemeName) => void;
};

function tableLabel(name: string) {
  return name.replace(/_/g, " ");
}

function compactFilterCount(values: string[]) {
  return values.filter((value) => value.trim().length > 0).length;
}

function blurActiveDialogElement() {
  if (typeof document === "undefined") {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.closest('[data-slot="dialog-content"]')) {
    activeElement.blur();
  }
}

function deferDialogOpen(callback: () => void) {
  window.setTimeout(callback, 0);
}

function SidebarSection(props: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-black/8 pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.title}</p>
          {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function SidebarHero(props: {
  icon: ReactNode;
  eyebrow?: string;
  title?: string;
  description?: string;
  accentClassName?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`sidebar-hero border-b border-black/8 pb-4 ${props.accentClassName ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="sidebar-hero-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            {props.icon}
          </div>
          {props.eyebrow || props.title || props.description ? (
            <div className="min-w-0">
              {props.eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.eyebrow}</p> : null}
              {props.title ? <p className="mt-1 text-sm font-semibold tracking-tight text-foreground">{props.title}</p> : null}
              {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
            </div>
          ) : null}
        </div>
        {props.action}
      </div>
      {props.children ? <div className="mt-4 space-y-3">{props.children}</div> : null}
    </section>
  );
}

function SidebarMetric(props: {
  label: string;
  value: string;
  tone?: StatusSemanticTone;
  detail?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`border ${props.compact ? "rounded-xl px-3 py-2" : "rounded-[1.6rem] px-3.5 py-3"} ${toneBadgeClass(props.tone ?? "sky")} ${
        props.className ?? ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`uppercase ${props.compact ? "text-[9px] tracking-[0.18em]" : "text-[10px] tracking-[0.2em]"}`}>{props.label}</p>
      </div>
      <p className={`truncate font-semibold tracking-tight ${props.compact ? "mt-1.5 text-sm" : "mt-2 text-[0.95rem]"}`}>{props.value}</p>
      {props.detail ? <p className={`text-current/72 ${props.compact ? "mt-0.5 text-[10px]" : "mt-1 text-[11px]"}`}>{props.detail}</p> : null}
    </div>
  );
}

function StatusPill(props: { label: string; value: string; tone: StatusSemanticTone; icon: typeof Network }) {
  const Icon = props.icon;
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${toneBadgeClass(props.tone)}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="uppercase tracking-[0.14em] opacity-72">{props.label}</span>
      <span className="font-medium normal-case tracking-normal">{props.value}</span>
    </div>
  );
}

function SidebarFilterField(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{props.label}</span>
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none"
      />
    </label>
  );
}

function SidebarModeToggle(props: {
  items: Array<{ key: string; label: string; icon: ReactNode }>;
  activeKey: string;
  onChange: (key: string) => void;
  iconOnly?: boolean;
}) {
  return (
    <div
      className={`sidebar-mode-toggle info-panel grid gap-1 rounded-[1.35rem] p-1 ${props.iconOnly ? "shrink-0" : ""}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }}
    >
      {props.items.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          className={`${props.iconOnly ? "h-8 w-8 px-0" : "h-10 min-w-0 px-2"} justify-center rounded-[0.9rem] text-sm transition-all ${
            props.activeKey === item.key
              ? "border border-black/10 bg-white text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_8px_18px_-16px_rgba(17,17,17,0.38)]"
              : "text-muted-foreground hover:bg-white/55 hover:text-foreground"
          }`}
          onClick={() => props.onChange(item.key)}
          title={item.label}
          aria-label={item.label}
        >
          <span className="shrink-0 opacity-80">{item.icon}</span>
          {props.iconOnly ? null : <span className="min-w-0 truncate">{item.label}</span>}
        </Button>
      ))}
    </div>
  );
}

function SidebarActionItem(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={`h-auto w-full justify-start rounded-2xl px-3 py-3 text-left transition-all ${
        props.active
          ? "info-panel ob-list-item-active"
          : "info-panel info-panel-hoverable"
      }`}
      onClick={props.onClick}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {props.icon ? (
          <div
            className={`ob-list-item-icon mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
              props.active ? "ob-list-item-icon-active" : ""
            }`}
          >
            {props.icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
            {props.badge ? <Badge variant="outline">{props.badge}</Badge> : null}
          </div>
          {props.subtitle ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{props.subtitle}</p> : null}
        </div>
      </div>
    </Button>
  );
}

type RuntimeUploadMode = "create" | "update";

interface RuntimeUploadDraft {
  mode: RuntimeUploadMode;
  file: File | null;
  name: string;
  overwrite: boolean;
  selectAfterUpload: boolean;
  returnToManager: boolean;
}

function deriveRuntimeNameFromFile(file: File): string {
  const normalized = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "runtime";
}

function RuntimeSidebar(props: SidebarProps & { onOpenRuntimeManager?: () => void }) {
  const [runtimeWorkspaceDeleteBusy, setRuntimeWorkspaceDeleteBusy] = useState(false);
  const { mainViewMode, setMainViewMode } = useUiStore(
    useShallow((state) => ({
      mainViewMode: state.mainViewMode,
      setMainViewMode: state.setMainViewMode
    }))
  );
  const { workspaceRuntimeFilter, setWorkspaceRuntimeFilter, serviceScope } = useSettingsStore(
    useShallow((state) => ({
      workspaceRuntimeFilter: state.workspaceRuntimeFilter,
      setWorkspaceRuntimeFilter: state.setWorkspaceRuntimeFilter,
      serviceScope: state.serviceScope
    }))
  );
  const expandedWorkspaceIdSet = useMemo(() => new Set(props.expandedWorkspaceIds), [props.expandedWorkspaceIds]);
  const expandedSessionIdSet = useMemo(() => new Set(props.expandedSessionIds), [props.expandedSessionIds]);
  const engineViewLabel = mainViewMode === "inspector" ? "Inspector" : "Conversation";
  const selectedRuntimeWorkspaceIds = useMemo(
    () => (workspaceRuntimeFilter.trim() ? props.filteredSavedWorkspaces.map((entry) => entry.id) : []),
    [props.filteredSavedWorkspaces, workspaceRuntimeFilter]
  );
  const canDeleteRuntimeWorkspaces =
    props.workspaceManagementEnabled &&
    workspaceRuntimeFilter.trim().length > 0 &&
    selectedRuntimeWorkspaceIds.length > 0 &&
    !runtimeWorkspaceDeleteBusy;
  const workspaceSessionGroups = useMemo(
    () =>
      props.filteredSavedWorkspaces.map((entry) => {
        const workspaceSessions = props.sessionsByWorkspaceId.get(entry.id) ?? [];
        const childSessionsByParentId = new Map<string, SavedSessionRecord[]>();
        for (const sessionEntry of workspaceSessions) {
          if (!sessionEntry.parentSessionId) {
            continue;
          }
          const children = childSessionsByParentId.get(sessionEntry.parentSessionId) ?? [];
          children.push(sessionEntry);
          childSessionsByParentId.set(sessionEntry.parentSessionId, children);
        }

        const topLevelSessions = workspaceSessions.filter((sessionEntry) => !sessionEntry.parentSessionId);
        const lastEditedAt = workspaceSessions.reduce<string | undefined>((latest, sessionEntry) => {
          if (!sessionEntry.lastRunAt) {
            return latest;
          }
          if (!latest) {
            return sessionEntry.lastRunAt;
          }

          return Date.parse(sessionEntry.lastRunAt) > Date.parse(latest) ? sessionEntry.lastRunAt : latest;
        }, undefined);

        return {
          entry,
          workspaceSessions,
          childSessionsByParentId,
          topLevelSessions,
          lastEditedAt
        };
      }),
    [props.filteredSavedWorkspaces, props.sessionsByWorkspaceId]
  );
  const sessionRunStatusById = useMemo(() => {
    const statusRank: Record<Run["status"], number> = {
      running: 0,
      waiting_tool: 1,
      queued: 2,
      failed: 3,
      timed_out: 4,
      cancelled: 5,
      completed: 6
    };
    const next = new Map<string, Run["status"]>();
    for (const sessionRun of props.sessionRuns) {
      const sessionIdValue = sessionRun.sessionId?.trim();
      if (!sessionIdValue) {
        continue;
      }
      const current = next.get(sessionIdValue);
      if (!current || statusRank[sessionRun.status] < statusRank[current]) {
        next.set(sessionIdValue, sessionRun.status);
      }
    }
    return next;
  }, [props.sessionRuns]);

  function hasActiveDescendant(
    sessionId: string,
    childSessionsByParentId: Map<string, SavedSessionRecord[]>,
    activeSessionId: string
  ): boolean {
    const childSessions = childSessionsByParentId.get(sessionId) ?? [];
    for (const childSession of childSessions) {
      if (childSession.id === activeSessionId || hasActiveDescendant(childSession.id, childSessionsByParentId, activeSessionId)) {
        return true;
      }
    }
    return false;
  }

  function renderSessionTree(
    entries: SavedSessionRecord[],
    options?: {
      depth?: number;
      childSessionsByParentId?: Map<string, SavedSessionRecord[]>;
      workspaceId?: string;
    }
  ): ReactNode {
    const depth = options?.depth ?? 0;
    const childSessionsByParentId = options?.childSessionsByParentId;
    const workspaceId = options?.workspaceId ?? "";

    return entries.map((sessionEntry) => {
      const childSessions = childSessionsByParentId?.get(sessionEntry.id) ?? [];
      const shouldExpand =
        childSessions.length > 0 &&
        (expandedSessionIdSet.has(sessionEntry.id) ||
          (props.sessionId === sessionEntry.id
            ? true
            : childSessionsByParentId
              ? hasActiveDescendant(sessionEntry.id, childSessionsByParentId, props.sessionId)
              : false));
      return (
        <div key={sessionEntry.id} className={depth === 0 ? "space-y-1" : "space-y-0.5"}>
          <SessionNavItem
            entry={sessionEntry}
            depth={depth}
            active={sessionEntry.id === props.sessionId}
            {...(sessionRunStatusById.has(sessionEntry.id)
              ? { runStatus: sessionRunStatusById.get(sessionEntry.id) as Run["status"] }
              : {})}
            expanded={shouldExpand}
            hasChildren={childSessions.length > 0}
            onSelect={() => {
              if (workspaceId.trim()) {
                props.expandWorkspaceInSidebar(workspaceId);
              }
              props.refreshSessionById(sessionEntry.id);
            }}
            onToggleExpanded={() => props.toggleSessionExpansion(sessionEntry.id)}
            onRename={(title) => props.renameSession(sessionEntry.id, title)}
            onRemove={() => props.removeSavedSession(sessionEntry.id)}
          />
          {childSessions.length > 0 && shouldExpand ? (
            <div className="mt-1 space-y-0.5">
              {renderSessionTree(childSessions, {
                depth: depth + 1,
                ...(childSessionsByParentId ? { childSessionsByParentId } : {}),
                workspaceId
              })}
            </div>
          ) : null}
        </div>
      );
    });
  }

  async function handleDeleteCurrentRuntimeWorkspaces() {
    if (!canDeleteRuntimeWorkspaces) {
      return;
    }
    setRuntimeWorkspaceDeleteBusy(true);
    try {
      await props.deleteWorkspacesForRuntime(workspaceRuntimeFilter, selectedRuntimeWorkspaceIds);
    } finally {
      setRuntimeWorkspaceDeleteBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-2.5">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <SidebarModeToggle
                activeKey={mainViewMode}
                onChange={(key) => setMainViewMode(key as MainViewMode)}
                iconOnly
                items={[
                  { key: "conversation", label: "Conversation", icon: <MessageSquareText className="h-4 w-4" /> },
                  { key: "inspector", label: "Inspector", icon: <Sparkles className="h-4 w-4" /> }
                ]}
              />
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    void props.refreshWorkspaceIndex();
                  }}
                  title="Refresh workspace list"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                {props.workspaceManagementEnabled ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => props.onOpenRuntimeManager?.()}
                      title="Runtime Manager"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        props.setWorkspaceDraft((current) => ({ ...current, runtime: "" }));
                        props.setShowWorkspaceCreator(true);
                      }}
                      title="New Workspace"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={!props.activeWorkspaceId.trim()}
                  title="New Session"
                  onClick={() => {
                    if (!props.activeWorkspaceId.trim()) {
                      return;
                    }
                    props.expandWorkspaceInSidebar(props.activeWorkspaceId);
                    props.createSession();
                  }}
                >
                  <Bot className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="truncate px-1 text-[12px] font-medium leading-4 text-muted-foreground">
              Engine View <span className="text-muted-foreground/50">·</span> <span className="text-foreground">{engineViewLabel}</span>
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium leading-4 text-muted-foreground">Runtime</span>
            </div>
            <div className="flex items-center gap-1">
              <Select
                value={workspaceRuntimeFilter || "__all_runtimes__"}
                onValueChange={(value) => setWorkspaceRuntimeFilter(value === "__all_runtimes__" ? "" : value)}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1 rounded-lg border-black/10 bg-white/58 text-xs shadow-none" aria-label="Workspace runtime filter">
                  <SelectValue placeholder="All runtimes" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="__all_runtimes__">All runtimes</SelectItem>
                  {props.workspaceRuntimeFilterOptions.map((runtime) => (
                    <SelectItem key={runtime} value={runtime}>
                      {runtime}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {props.workspaceManagementEnabled ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={!canDeleteRuntimeWorkspaces}
                  onClick={() => {
                    void handleDeleteCurrentRuntimeWorkspaces();
                  }}
                  title={
                    workspaceRuntimeFilter.trim()
                      ? `Delete ${selectedRuntimeWorkspaceIds.length} workspace${selectedRuntimeWorkspaceIds.length === 1 ? "" : "s"} for this runtime`
                      : "Select a runtime to delete its workspaces"
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
          {props.filteredSavedWorkspaces.length === 0 ? (
            <div className="sidebar-empty-state rounded-xl border border-dashed border-black/12 bg-white/32 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">
                {workspaceRuntimeFilter ? "No matching workspaces" : "No workspaces"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {workspaceRuntimeFilter
                  ? "Try another runtime or service filter."
                  : serviceScope !== "__all__"
                    ? "Switch service scope or create a workspace in this service."
                    : "Create or load one."}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {workspaceSessionGroups.map(({ entry, workspaceSessions, childSessionsByParentId, topLevelSessions, lastEditedAt }) => {
                const isExpanded = expandedWorkspaceIdSet.has(entry.id);
                return (
                  <div key={entry.id} className="runtime-workspace-group space-y-1">
                    <WorkspaceNavItem
                      entry={entry}
                      active={entry.id === props.activeWorkspaceId}
                      expanded={isExpanded}
                      sessionCount={workspaceSessions.length}
                      {...(lastEditedAt ? { lastEditedAt } : {})}
                      canRemove={props.workspaceManagementEnabled}
                      onSelect={() => props.openWorkspace(entry.id)}
                      onToggleExpanded={() => props.toggleWorkspaceExpansion(entry.id)}
                      onRemove={() => props.deleteWorkspace(entry.id)}
                    />
                    {isExpanded ? (
                      <div className="runtime-session-tree space-y-1.5">
                        {topLevelSessions.length === 0 ? (
                          <div className="rounded-lg px-3 py-2.5 text-xs text-muted-foreground">No sessions yet.</div>
                        ) : (
                          renderSessionTree(topLevelSessions, {
                            childSessionsByParentId,
                            workspaceId: entry.id
                          })
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StorageSidebar(props: SidebarProps) {
  const { healthReport } = useHealthStore(
    useShallow((state) => ({
      healthReport: state.healthReport
    }))
  );
  const { serviceScope } = useSettingsStore(
    useShallow((state) => ({
      serviceScope: state.serviceScope
    }))
  );
  const postgresAvailable = props.storageOverview?.postgres.available ?? false;
  const redisAvailable = props.storageOverview?.redis.available ?? false;
  const postgresTableCount = props.storageOverview?.postgres.tables.length ?? 0;
  const redisLoadedCount = props.redisKeyPage?.items.length ?? 0;
  const runsTableSelected = props.selectedStorageTable === "runs";
  const postgresFilterCount = compactFilterCount([
    props.storageTableSearch ?? "",
    props.storageTableWorkspaceId ?? "",
    props.storageTableSessionId ?? "",
    props.storageTableRunId ?? "",
    ...(runsTableSelected
      ? [props.storageTableStatus ?? "", props.storageTableErrorCode ?? "", props.storageTableRecoveryState ?? ""]
      : [])
  ]);
  const redisHotCount =
    (props.storageOverview?.redis.sessionQueues.length ?? 0) +
    (props.storageOverview?.redis.sessionLocks.length ?? 0) +
    (props.storageOverview?.redis.eventBuffers.length ?? 0);
  const activeWorkerCount = healthReport?.worker.summary.active ?? healthReport?.worker.activeWorkers.length ?? 0;
  const targetWorkerCount = healthReport?.worker.pool?.desiredWorkers ?? activeWorkerCount;
  const lateWorkerCount =
    healthReport?.worker.summary.late ??
    healthReport?.worker.activeWorkers.filter((entry) => entry.health === "late").length ??
    0;
  const storageModeItems = props.storageRedisEnabled
    ? [
        { key: "postgres", label: "Postgres", icon: <Database className="h-4 w-4" /> },
        { key: "redis", label: "Redis", icon: <Workflow className="h-4 w-4" /> }
      ]
    : [{ key: "postgres", label: "Postgres", icon: <Database className="h-4 w-4" /> }];

  return (
    <div className="space-y-5 px-3 py-4">
      <div className="space-y-3 pb-1">
        <SidebarModeToggle activeKey={props.storageBrowserTab} onChange={(key) => props.onStorageBrowserTabChange(key as "postgres" | "redis")} items={storageModeItems} />
        <div className="grid grid-cols-3 gap-2">
          <SidebarMetric
            label="Postgres"
            value={postgresAvailable ? "online" : "offline"}
            detail={`${postgresTableCount} tables`}
            tone={postgresAvailable ? "emerald" : "rose"}
            compact
          />
          <SidebarMetric
            label="Scope"
            value={props.selectedServiceScopeLabel}
            detail={serviceScope === "__all__" ? "cross-service" : "active scope"}
            tone={serviceScope === "__all__" ? "sky" : "emerald"}
            compact
          />
          <SidebarMetric
            label="Redis"
            value={redisAvailable ? "online" : "offline"}
            detail={`${props.storageOverview?.redis.dbSize ?? 0} keys`}
            tone={redisAvailable ? "emerald" : "rose"}
            compact
          />
        </div>
      </div>

      {props.storageBrowserTab === "postgres" ? (
        <>
          <SidebarSection
            title="Filters"
            {...(postgresFilterCount > 0 ? { description: `${postgresFilterCount} active` } : {})}
            {...(postgresFilterCount > 0
              ? { action: <Badge variant="outline">{postgresFilterCount} active</Badge> }
              : {})}
          >
          {!postgresAvailable ? (
            <p className="text-sm text-muted-foreground">Postgres 当前不可用。</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2">
                <SidebarFilterField
                  label="Search"
                  value={props.storageTableSearch ?? ""}
                  onChange={props.onStorageTableSearchChange}
                  placeholder="Search row JSON"
                />
                <div className="grid grid-cols-2 gap-2">
                  <SidebarFilterField
                    label="Workspace"
                    value={props.storageTableWorkspaceId ?? ""}
                    onChange={props.onStorageTableWorkspaceIdChange}
                    placeholder="workspaceId"
                  />
                  <SidebarFilterField
                    label="Session"
                    value={props.storageTableSessionId ?? ""}
                    onChange={props.onStorageTableSessionIdChange}
                    placeholder="sessionId"
                  />
                </div>
                <SidebarFilterField
                  label="Run"
                  value={props.storageTableRunId ?? ""}
                  onChange={props.onStorageTableRunIdChange}
                  placeholder="runId"
                />
                {runsTableSelected ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status</span>
                        <Select
                          value={props.storageTableStatus || "__all_run_statuses__"}
                          onValueChange={(value) => props.onStorageTableStatusChange(value === "__all_run_statuses__" ? "" : value)}
                        >
                          <SelectTrigger className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Run status filter">
                            <SelectValue placeholder="All statuses" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value="__all_run_statuses__">All statuses</SelectItem>
                            <SelectItem value="failed">failed</SelectItem>
                            <SelectItem value="timed_out">timed_out</SelectItem>
                            <SelectItem value="queued">queued</SelectItem>
                            <SelectItem value="running">running</SelectItem>
                            <SelectItem value="waiting_tool">waiting_tool</SelectItem>
                            <SelectItem value="completed">completed</SelectItem>
                            <SelectItem value="cancelled">cancelled</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recovery</span>
                        <Select
                          value={props.storageTableRecoveryState || "__all_recovery_states__"}
                          onValueChange={(value) =>
                            props.onStorageTableRecoveryStateChange(value === "__all_recovery_states__" ? "" : value)
                          }
                        >
                          <SelectTrigger className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Run recovery state filter">
                            <SelectValue placeholder="All recovery states" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value="__all_recovery_states__">All recovery states</SelectItem>
                            <SelectItem value="quarantined">quarantined</SelectItem>
                            <SelectItem value="failed">failed</SelectItem>
                            <SelectItem value="requeued">requeued</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                    </div>
                    <SidebarFilterField
                      label="Error Code"
                      value={props.storageTableErrorCode ?? ""}
                      onChange={props.onStorageTableErrorCodeChange}
                      placeholder="worker_recovery_failed"
                    />
                  </>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" className="h-9 rounded-xl" onClick={props.onRefreshStorageTable} disabled={props.storageBusy}>
                  <Search className="h-4 w-4" />
                  Apply
                </Button>
                <Button variant="outline" className="h-9 rounded-xl" onClick={props.onClearStorageTableFilters} disabled={props.storageBusy}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          </SidebarSection>

          {!postgresAvailable ? (
            <div className="border-t border-black/8 pt-4">
              <p className="text-sm text-muted-foreground">Postgres 当前不可用。</p>
            </div>
          ) : (
            <div className="space-y-1.5 border-t border-black/8 pt-4">
              {props.storageOverview?.postgres.tables.map((table) => (
                <SidebarActionItem
                  key={table.name}
                  title={tableLabel(table.name)}
                  subtitle={`${table.description} · order by ${table.orderBy}`}
                  badge={String(table.rowCount)}
                  icon={<Database className="h-4 w-4" />}
                  active={props.selectedStorageTable === table.name}
                  onClick={() => {
                    props.onStorageBrowserTabChange("postgres");
                    props.onSelectStorageTable(table.name);
                  }}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <SidebarSection title="Pattern">
            <div className="flex gap-2">
              <Input
                value={props.redisKeyPattern}
                onChange={(event) => props.onRedisKeyPatternChange(event.target.value)}
                placeholder="oah:*"
                className="h-9 rounded-xl border-black/10 bg-white/68 text-xs shadow-none"
              />
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 rounded-xl"
                onClick={() => {
                  props.onStorageBrowserTabChange("redis");
                  props.onRefreshRedisKeys();
                }}
                disabled={props.storageBusy}
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Pattern" value={props.redisKeyPage?.pattern ?? (props.redisKeyPattern || "oah:*")} tone="sky" />
              <SidebarMetric label="Loaded" value={`${redisLoadedCount} keys`} tone="sky" />
            </div>
          </SidebarSection>

          <SidebarSection
            title="Hot Paths"
            {...(redisHotCount > 0 ? { description: `${redisHotCount} entries` } : {})}
          >
            <div className="grid grid-cols-3 gap-2">
              <SidebarMetric label="Queues" value={String(props.storageOverview?.redis.sessionQueues.length ?? 0)} tone="amber" />
              <SidebarMetric label="Locks" value={String(props.storageOverview?.redis.sessionLocks.length ?? 0)} tone="rose" />
              <SidebarMetric label="Buffers" value={String(props.storageOverview?.redis.eventBuffers.length ?? 0)} tone="sky" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <SidebarMetric label="Workers" value={String(activeWorkerCount)} tone={activeWorkerCount > 0 ? "emerald" : "sky"} />
              <SidebarMetric label="Target" value={String(targetWorkerCount)} tone="sky" />
              <SidebarMetric label="Late" value={String(lateWorkerCount)} tone={lateWorkerCount > 0 ? "amber" : "emerald"} />
            </div>
            <div className="space-y-1.5">
              {props.storageOverview?.redis.sessionQueues.slice(0, 4).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={`${item.length}`}
                  icon={<Workflow className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {props.storageOverview?.redis.sessionLocks.slice(0, 3).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={item.ttlMs !== undefined ? `${item.ttlMs}ms` : "lock"}
                  icon={<Lock className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {props.storageOverview?.redis.eventBuffers.slice(0, 3).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.sessionId}
                  subtitle={item.key}
                  badge={`${item.length}`}
                  icon={<Rows3 className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {(props.storageOverview?.redis.sessionQueues.length ?? 0) === 0 &&
              (props.storageOverview?.redis.sessionLocks.length ?? 0) === 0 &&
              (props.storageOverview?.redis.eventBuffers.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">当前没有活跃的 queue、lock 或 event buffer。</p>
              ) : null}
            </div>
          </SidebarSection>

          <SidebarSection title="Loaded Keys" description="从当前 pattern 的结果里快速切换到具体 key。">
            <div className="space-y-1.5">
              {props.redisKeyPage?.items.slice(0, 10).map((item) => (
                <SidebarActionItem
                  key={item.key}
                  title={item.key}
                  subtitle={item.type}
                  {...(item.size !== undefined ? { badge: `${item.size}` } : {})}
                  icon={<Rows3 className="h-4 w-4" />}
                  active={props.selectedRedisKey === item.key}
                  onClick={() => {
                    props.onStorageBrowserTabChange("redis");
                    props.onSelectRedisKey(item.key);
                  }}
                />
              ))}
              {redisLoadedCount === 0 ? <p className="text-sm text-muted-foreground">还没有加载到 Redis key。</p> : null}
            </div>
          </SidebarSection>
        </>
      )}
    </div>
  );
}

function ProviderSidebar(props: SidebarProps) {
  const { connection, modelDraft, setModelDraft } = useSettingsStore(
    useShallow((state) => ({
      connection: state.connection,
      modelDraft: state.modelDraft,
      setModelDraft: state.setModelDraft
    }))
  );
  const { healthStatus, readinessReport } = useHealthStore(
    useShallow((state) => ({
      healthStatus: state.healthStatus,
      readinessReport: state.readinessReport
    }))
  );
  const { modelProviders, platformModels } = useModelsStore(
    useShallow((state) => ({
      modelProviders: state.modelProviders,
      platformModels: state.platformModels
    }))
  );
  const { streamState } = useStreamStore(
    useShallow((state) => ({
      streamState: state.streamState
    }))
  );
  const { setStreamRevision } = useUiStore(
    useShallow((state) => ({
      setStreamRevision: state.setStreamRevision
    }))
  );
  const defaultModel = platformModels.find((model) => model.isDefault);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        <div className="space-y-5">
          <div className="space-y-3 border-b border-black/8 pb-4">
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Health" value={healthStatus} tone={probeTone(healthStatus)} />
              <SidebarMetric label="Stream" value={streamState} tone={streamTone(streamState)} />
              <SidebarMetric label="Models" value={String(platformModels.length)} tone="emerald" />
              <SidebarMetric label="Providers" value={String(modelProviders.length)} tone="sky" />
            </div>
            <div className="space-y-2 border-l border-black/8 pl-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Base URL</p>
              <p className="truncate text-xs text-foreground">{connection.baseUrl || "not configured"}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className={toneBadgeClass(probeTone(readinessReport?.status ?? "unknown"))}>
                  {`ready ${readinessReport?.status ?? "unknown"}`}
                </Badge>
                {defaultModel ? <Badge variant="outline">default {defaultModel.id}</Badge> : null}
              </div>
            </div>
          </div>

          <SidebarSection title="Quick Actions">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-10 justify-start rounded-2xl" onClick={props.pingHealth}>
                <Network className="h-4 w-4" />
                Health
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={() => setStreamRevision((current) => current + 1)}>
                <Orbit className="h-4 w-4" />
                SSE
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshModelProviders}>
                <RefreshCw className="h-4 w-4" />
                Providers
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshPlatformModels}>
                <Workflow className="h-4 w-4" />
                Models
              </Button>
            </div>
          </SidebarSection>

          <SidebarSection title="Models" description="点击切换当前 Playground 模型。">
            <div className="space-y-1.5">
              {platformModels.length === 0 ? (
                <p className="text-sm text-muted-foreground">当前还没有加载到平台模型。</p>
              ) : (
                platformModels.map((model) => (
                  <SidebarActionItem
                    key={model.id}
                    icon={<Workflow className="h-4 w-4" />}
                    title={model.id}
                    subtitle={[
                      model.modelName,
                      model.provider,
                      model.hasKey ? "key ready" : "no key"
                    ].join(" · ")}
                    badge={model.isDefault ? "default" : model.provider}
                    active={modelDraft.model === model.id}
                    onClick={() => setModelDraft((current) => ({ ...current, model: model.id }))}
                  />
                ))
              )}
            </div>
          </SidebarSection>
        </div>
      </div>
    </div>
  );
}

function AppSidebarImpl(props: SidebarProps) {
  const healthStatus = useHealthStore((state) => state.healthStatus);
  const streamState = useStreamStore((state) => state.streamState);
  const { surfaceMode, setSurfaceMode } = useUiStore(
    useShallow((state) => ({
      surfaceMode: state.surfaceMode,
      setSurfaceMode: state.setSurfaceMode
    }))
  );
  const { consoleOpen, setConsoleOpen } = useUiStore(
    useShallow((state) => ({
      consoleOpen: state.consoleOpen,
      setConsoleOpen: state.setConsoleOpen
    }))
  );
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore(
    useShallow((state) => ({
      sidebarCollapsed: state.sidebarCollapsed,
      setSidebarCollapsed: state.setSidebarCollapsed
    }))
  );
  const { serviceScope, setServiceScope } = useSettingsStore(
    useShallow((state) => ({
      serviceScope: state.serviceScope,
      setServiceScope: state.setServiceScope
    }))
  );
  const uploadTemplateInputRef = useRef<HTMLInputElement>(null);
  const updateTemplateInputRef = useRef<HTMLInputElement>(null);
  const [runtimeUploadDraft, setRuntimeUploadDraft] = useState<RuntimeUploadDraft>({
    mode: "create",
    file: null,
    name: "",
    overwrite: false,
    selectAfterUpload: false,
    returnToManager: false
  });
  const [showRuntimeUploadDialog, setShowRuntimeUploadDialog] = useState(false);
  const [showRuntimeManagerDialog, setShowRuntimeManagerDialog] = useState(false);
  const [runtimeMutationBusy, setRuntimeMutationBusy] = useState(false);
  const [runtimePendingDelete, setRuntimePendingDelete] = useState("");
  const [runtimeManagerSearch, setRuntimeManagerSearch] = useState("");

  const icon = surfaceIcon(surfaceMode);
  const title = surfaceTitle(surfaceMode);
  const subtitle =
    surfaceMode === "storage"
      ? "Inspect Postgres tables and Redis keyspace."
      : surfaceMode === "provider"
        ? "Connection, health, and provider registry."
        : "Navigate workspaces and sessions.";
  const currentThemeLabel = appThemeOptions.find((option) => option.value === props.theme)?.label ?? props.theme;
  const serviceScopeOptions = props.serviceScopeOptions ?? [];
  const serverLabel = props.systemProfile ? formatSystemProfileDisplayName(props.systemProfile) : "unknown";
  const serverTone: StatusSemanticTone = props.systemProfile?.deploymentKind === "oap" ? "emerald" : props.systemProfile ? "sky" : "amber";
  const selectedRuntimeName = props.workspaceDraft.runtime?.trim() ?? "";
  const runtimeUploadTitle = runtimeUploadDraft.mode === "update" ? "Update Runtime" : "Upload Runtime";
  const runtimeUploadDescription =
    runtimeUploadDraft.mode === "update"
      ? `Replace runtime "${runtimeUploadDraft.name}" with the selected .zip package.`
      : "Upload a .zip file containing the runtime folder structure.";
  const runtimeUploadSubmitLabel = runtimeUploadDraft.mode === "update" ? "Update" : "Upload";
  const filteredRuntimeNames = useMemo(() => {
    const query = runtimeManagerSearch.trim().toLowerCase();
    if (!query) {
      return props.workspaceRuntimes;
    }
    return props.workspaceRuntimes.filter((runtime) => runtime.toLowerCase().includes(query));
  }, [props.workspaceRuntimes, runtimeManagerSearch]);
  const collapseButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-white/55 hover:text-foreground"
      onClick={() => setSidebarCollapsed((current) => !current)}
      title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
    </Button>
  );

  function openRuntimeUploadDialog(
    file: File,
    options?: { mode?: RuntimeUploadMode; name?: string; selectAfterUpload?: boolean; returnToManager?: boolean }
  ) {
    blurActiveDialogElement();
    setRuntimeUploadDraft({
      mode: options?.mode ?? "create",
      file,
      name: options?.name ?? deriveRuntimeNameFromFile(file),
      overwrite: options?.mode === "update",
      selectAfterUpload: options?.selectAfterUpload ?? false,
      returnToManager: options?.returnToManager ?? true
    });
    setShowRuntimeManagerDialog(false);
    props.setShowWorkspaceCreator(false);
    deferDialogOpen(() => setShowRuntimeUploadDialog(true));
  }

  function openRuntimeUpdatePicker(runtimeName: string) {
    setRuntimeUploadDraft((current) => ({
      ...current,
      mode: "update",
      name: runtimeName,
      file: null,
      overwrite: true,
      selectAfterUpload: false,
      returnToManager: true
    }));
    deferDialogOpen(() => updateTemplateInputRef.current?.click());
  }

  function openRuntimeManagerDialog() {
    blurActiveDialogElement();
    props.setShowWorkspaceCreator(false);
    setShowRuntimeUploadDialog(false);
    deferDialogOpen(() => {
      setShowRuntimeManagerDialog(true);
      void props.refreshWorkspaceRuntimes(true);
    });
  }

  function setWorkspaceCreatorOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
    }
    props.setShowWorkspaceCreator(open);
  }

  function setRuntimeManagerOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
      setRuntimePendingDelete("");
    }
    setShowRuntimeManagerDialog(open);
  }

  function setRuntimeUploadOpen(open: boolean) {
    if (open) {
      setShowRuntimeUploadDialog(true);
      return;
    }

    closeRuntimeUploadDialog({ returnToManager: runtimeUploadDraft.returnToManager });
  }

  function closeRuntimeUploadDialog(options?: { returnToManager?: boolean }) {
    blurActiveDialogElement();
    setShowRuntimeUploadDialog(false);
    const shouldReturnToManager = options?.returnToManager ?? false;
    if (shouldReturnToManager) {
      deferDialogOpen(() => {
        setShowRuntimeManagerDialog(true);
        void props.refreshWorkspaceRuntimes(true);
      });
    }
  }

  async function submitRuntimeUpload() {
    if (!runtimeUploadDraft.file || !runtimeUploadDraft.name.trim()) {
      return;
    }

    setRuntimeMutationBusy(true);
    try {
      const runtimeName = runtimeUploadDraft.name.trim();
      const ok =
        runtimeUploadDraft.mode === "update"
          ? await props.updateWorkspaceRuntime(runtimeName, runtimeUploadDraft.file)
          : await props.uploadWorkspaceRuntime(runtimeUploadDraft.file, runtimeName, runtimeUploadDraft.overwrite);
      if (ok) {
        const shouldReturnToManager = runtimeUploadDraft.returnToManager;
        setRuntimeManagerSearch(runtimeName);
        closeRuntimeUploadDialog({ returnToManager: shouldReturnToManager });
        setRuntimeUploadDraft({
          mode: "create",
          file: null,
          name: "",
          overwrite: false,
          selectAfterUpload: false,
          returnToManager: false
        });
        if (runtimeUploadDraft.selectAfterUpload) {
          props.setWorkspaceDraft((current) => ({
            ...current,
            runtime: runtimeName
          }));
        }
      }
    } finally {
      setRuntimeMutationBusy(false);
    }
  }

  async function deleteRuntime(runtimeName: string) {
    if (!runtimeName.trim()) {
      return;
    }

    setRuntimeMutationBusy(true);
    try {
      const ok = await props.deleteWorkspaceRuntime(runtimeName);
      if (ok) {
        if (selectedRuntimeName === runtimeName) {
          props.setWorkspaceDraft((current) => ({
            ...current,
            runtime: ""
          }));
        }
        setRuntimePendingDelete("");
      }
    } finally {
      setRuntimeMutationBusy(false);
    }
  }

  return (
    <>
      <div
        className={`relative min-h-0 shrink-0 overflow-visible transition-[width] duration-300 ease-out ${
          sidebarCollapsed ? "w-0" : "w-[288px]"
        }`}
      >
        <div
          className={`absolute left-3 top-3 z-40 transition-all duration-300 ease-out ${
            sidebarCollapsed
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none -translate-x-2 opacity-0"
          }`}
        >
          <div className="rounded-2xl border border-border/70 bg-background/86 p-1 shadow-[0_10px_24px_-20px_rgba(17,17,17,0.38)] backdrop-blur-md">
            {collapseButton}
          </div>
        </div>
        <aside
          className={`app-sidebar-surface absolute inset-y-0 left-0 flex min-h-0 w-[288px] shrink-0 flex-col border-r border-black/10 transition-[transform,opacity] duration-300 ease-out ${
            sidebarCollapsed ? "pointer-events-none -translate-x-full opacity-0" : "translate-x-0 opacity-100"
          }`}
        >
          <>
            <div className="sidebar-surface-hero border-b border-black/8 px-4 py-3">
              <div className="flex items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="sidebar-surface-brand-logo flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-white/50 p-1.5">
                      <img src="/oah-logo.png" alt="Open Agent Harness logo" className="h-full w-full object-contain dark:hidden" />
                      <img src="/oah-logo-dark.png" alt="" aria-hidden="true" className="hidden h-full w-full object-contain dark:block" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={10} align="start" className="max-w-none items-start rounded-2xl bg-popover p-3 text-popover-foreground shadow-[0_24px_48px_-32px_rgba(17,17,17,0.45)] ring-1 ring-foreground/10">
                    <div className="space-y-2">
                      <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Server Status</p>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusPill icon={Network} label="Health" value={healthStatus} tone={probeTone(healthStatus)} />
                        <StatusPill icon={Orbit} label="Stream" value={streamState} tone={streamTone(streamState)} />
                        <StatusPill icon={Server} label="Server" value={serverLabel} tone={serverTone} />
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold leading-5 tracking-tight text-foreground">Open Agent Harness</p>
                  <div className="mt-0.5 flex min-w-0 items-center gap-2">
                    <p className="truncate text-xs leading-4 text-muted-foreground">WebUI</p>
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9px] font-medium uppercase tracking-[0.14em] text-foreground/52">
                      Beta
                    </Badge>
                  </div>
                </div>
                {collapseButton}
              </div>

              <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sidebar-surface-switch group mt-3 flex h-10 w-full items-center gap-2 rounded-xl border border-black/8 bg-white/34 px-2.5 text-left transition hover:bg-white/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10"
                aria-label="Surface"
              >
                <span className="sidebar-surface-hero-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground">
                  {icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-5 tracking-tight text-foreground">{title}</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-data-[state=open]:rotate-180" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px] rounded-2xl p-1.5">
              <DropdownMenuLabel className="px-2 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Surface
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={surfaceMode} onValueChange={(value) => setSurfaceMode(value as SurfaceMode)}>
                <DropdownMenuRadioItem value="engine" className="mx-1 rounded-xl px-2 py-2">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  Engine
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="storage" disabled={!props.storageInspectionEnabled} className="mx-1 rounded-xl px-2 py-2">
                  <Table2 className="h-4 w-4 text-muted-foreground" />
                  Storage
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="provider" className="mx-1 rounded-xl px-2 py-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  Provider
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {surfaceMode === "storage" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <StorageSidebar {...props} />
            </div>
          ) : surfaceMode === "provider" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <ProviderSidebar {...props} />
            </div>
          ) : (
            <RuntimeSidebar {...props} onOpenRuntimeManager={openRuntimeManagerDialog} />
          )}
        </div>

        <div className="shrink-0 border-t border-black/8 px-3 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="info-panel info-panel-hoverable h-auto w-full justify-between rounded-2xl px-3 py-3 text-left">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="ob-list-item-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
                    <Settings2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">Settings</span>
                    <span className="block truncate text-xs leading-5 text-muted-foreground">Theme: {currentThemeLabel}</span>
                  </span>
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-[260px] min-w-[260px] rounded-2xl p-2">
              <DropdownMenuLabel className="px-2 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Interface Settings
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <Layers3 className="h-3.5 w-3.5" />
                  Service
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Choose which service namespace the sidebar and storage views use.</p>
                <Select value={serviceScope} onValueChange={setServiceScope}>
                  <SelectTrigger className="mt-2 h-9 w-full rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Service scope">
                    <SelectValue placeholder="Service" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {serviceScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      <SquareTerminal className="h-3.5 w-3.5" />
                      Console
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">Show the runtime event console below the engine view.</p>
                  </div>
                  <Switch checked={consoleOpen} onCheckedChange={setConsoleOpen} aria-label="Toggle console" />
                </div>
              </div>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <Palette className="h-3.5 w-3.5" />
                  Theme
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Choose the visual theme for the web app.</p>
              </div>
              <DropdownMenuRadioGroup
                value={props.theme}
                onValueChange={(value) => {
                  if (isAppThemeName(value)) {
                    props.onThemeChange(value);
                  }
                }}
              >
                {appThemeOptions.map((theme) => (
                  <DropdownMenuRadioItem key={theme.value} value={theme.value} className="mx-1 rounded-xl px-2 py-2">
                    {theme.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </>
        </aside>
      </div>

      <input
        ref={uploadTemplateInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          openRuntimeUploadDialog(file, { selectAfterUpload: props.showWorkspaceCreator, returnToManager: true });
          event.target.value = "";
        }}
      />
      <input
        ref={updateTemplateInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          openRuntimeUploadDialog(file, {
            mode: "update",
            name: runtimeUploadDraft.name || selectedRuntimeName,
            returnToManager: true
          });
          event.target.value = "";
        }}
      />

      <Dialog open={props.showWorkspaceCreator} onOpenChange={setWorkspaceCreatorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
            <DialogDescription>
              Leave Root path empty to create a managed workspace folder named with a generated workspace id.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={props.workspaceDraft.name ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Workspace name"
            />
            <div className="space-y-1">
              <Select
                value={props.workspaceDraft.runtime?.trim() ?? ""}
                onValueChange={(value) => props.setWorkspaceDraft((current) => ({ ...current, runtime: value }))}
              >
                <SelectTrigger className="h-10 flex-1 rounded-xl border-black/10 bg-white/68 text-sm shadow-none" aria-label="Workspace runtime">
                  <SelectValue placeholder={props.workspaceRuntimes.length > 0 ? "Select runtime" : "No runtimes available"} />
                </SelectTrigger>
                <SelectContent align="start">
                  {props.workspaceRuntimes.length > 0 ? (
                    props.workspaceRuntimes.map((runtime) => (
                      <SelectItem key={runtime} value={runtime}>
                        {runtime}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no_templates__" disabled>
                      No runtimes available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <p className="px-1 text-xs leading-5 text-muted-foreground">
                {props.workspaceRuntimes.length > 0
                  ? "Choose a runtime, or manage packages from Runtime Manager."
                  : "Runtime list is empty. Open Runtime Manager to upload a .zip package."}
              </p>
            </div>
            <Input
              value={props.workspaceDraft.rootPath ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))}
              placeholder="Root path"
            />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.ownerId ?? ""}
                  onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, ownerId: event.target.value }))}
                  placeholder="Owner ID (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Only set this when the workspace should stay bound to one owner.
                </p>
              </div>
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.serviceName ?? ""}
                  onChange={(event) =>
                    props.setWorkspaceDraft((current) => ({ ...current, serviceName: event.target.value }))
                  }
                  placeholder="Service name (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Leave empty to use the default OAH service namespace.
                </p>
              </div>
            </div>
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Managed mode: auto-create under workspace_dir/workspace_id. Custom mode: use the path you enter here.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                openRuntimeManagerDialog();
              }}
            >
              <Settings2 className="h-4 w-4" />
              Manage
            </Button>
            <Button variant="outline" onClick={() => props.refreshWorkspaceRuntimes()}>
              <RefreshCw className="h-4 w-4" />
              Runtimes
            </Button>
            <Button
              onClick={() => {
                props.createWorkspace();
                props.setShowWorkspaceCreator(false);
              }}
            >
              <FolderPlus className="h-4 w-4" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRuntimeManagerDialog} onOpenChange={setRuntimeManagerOpen}>
        <DialogContent className="max-h-[86vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>Runtime Manager</DialogTitle>
            <DialogDescription>Upload, replace, and remove workspace runtime packages.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-hidden">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={runtimeManagerSearch}
                  onChange={(event) => setRuntimeManagerSearch(event.target.value)}
                  placeholder="Search runtimes"
                  className="h-10 rounded-xl border-black/10 bg-white/68 pl-9 text-sm shadow-none"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => uploadTemplateInputRef.current?.click()}
                  disabled={!props.workspaceManagementEnabled || runtimeMutationBusy}
                >
                  <Upload className="h-4 w-4" />
                  Upload
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => props.refreshWorkspaceRuntimes()}
                  disabled={!props.workspaceManagementEnabled || runtimeMutationBusy}
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Badge variant="outline">
                  {filteredRuntimeNames.length === props.workspaceRuntimes.length
                    ? `${props.workspaceRuntimes.length} runtimes`
                    : `${filteredRuntimeNames.length}/${props.workspaceRuntimes.length}`}
                </Badge>
              </div>
            </div>
            {props.workspaceManagementEnabled ? (
              props.workspaceRuntimes.length > 0 ? (
                <ScrollArea className="h-[min(52vh,420px)] rounded-2xl border border-black/8">
                  <div className="divide-y divide-black/8">
                    {filteredRuntimeNames.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm font-medium text-foreground">No matching runtimes</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">Try a shorter search term.</p>
                      </div>
                    ) : null}
                    {filteredRuntimeNames.map((runtime) => {
                      const isDeleting = runtimePendingDelete === runtime;
                      return (
                        <div key={runtime} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{runtime}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {isDeleting
                                ? "Confirm deletion, or cancel to keep this runtime."
                                : selectedRuntimeName === runtime
                                  ? "Selected for the next workspace."
                                  : "Available for new workspaces."}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-xl"
                              onClick={() => openRuntimeUpdatePicker(runtime)}
                              disabled={runtimeMutationBusy}
                            >
                              <FileUp className="h-3.5 w-3.5" />
                              Update
                            </Button>
                            {isDeleting ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-xl"
                                onClick={() => setRuntimePendingDelete("")}
                                disabled={runtimeMutationBusy}
                              >
                                Cancel
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant={isDeleting ? "destructive" : "outline"}
                              size="sm"
                              className="h-8 rounded-xl"
                              onClick={() => {
                                if (isDeleting) {
                                  void deleteRuntime(runtime);
                                  return;
                                }
                                setRuntimePendingDelete(runtime);
                              }}
                              disabled={runtimeMutationBusy}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {isDeleting ? "Confirm" : "Delete"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">No runtimes yet</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Upload a .zip package to make it available for new workspaces.</p>
                </div>
              )
            ) : (
              <div className="rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">Runtime management is unavailable</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">This server is running without multi-workspace runtime management.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                blurActiveDialogElement();
                setShowRuntimeManagerDialog(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRuntimeUploadDialog} onOpenChange={setRuntimeUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{runtimeUploadTitle}</DialogTitle>
            <DialogDescription>{runtimeUploadDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={runtimeUploadDraft.name}
              onChange={(event) =>
                setRuntimeUploadDraft((current) => ({
                  ...current,
                  name: event.target.value.replace(/[^a-zA-Z0-9_-]/g, "_")
                }))
              }
              placeholder="Runtime name"
              disabled={runtimeUploadDraft.mode === "update"}
            />
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Only alphanumeric characters, hyphens, and underscores are allowed.
            </p>
            {runtimeUploadDraft.mode === "create" ? (
              <div className="flex items-center gap-2">
                <Switch
                  checked={runtimeUploadDraft.overwrite}
                  onCheckedChange={(checked) =>
                    setRuntimeUploadDraft((current) => ({
                      ...current,
                      overwrite: checked
                    }))
                  }
                  id="overwrite-runtime"
                />
                <label htmlFor="overwrite-runtime" className="text-sm text-muted-foreground">
                  Overwrite if exists
                </label>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                closeRuntimeUploadDialog({ returnToManager: runtimeUploadDraft.returnToManager });
              }}
              disabled={runtimeMutationBusy}
            >
              Cancel
            </Button>
            <Button
              disabled={!runtimeUploadDraft.name.trim() || !runtimeUploadDraft.file || runtimeMutationBusy}
              onClick={() => {
                void submitRuntimeUpload();
              }}
            >
              {runtimeUploadDraft.mode === "update" ? <FileUp className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {runtimeUploadSubmitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function surfaceIcon(surfaceMode: SurfaceMode) {
  if (surfaceMode === "storage") {
    return <Table2 className="h-4 w-4" />;
  }
  if (surfaceMode === "provider") {
    return <Network className="h-4 w-4" />;
  }
  return <Bot className="h-4 w-4" />;
}

function surfaceTitle(surfaceMode: SurfaceMode) {
  if (surfaceMode === "storage") {
    return "Storage";
  }
  if (surfaceMode === "provider") {
    return "Provider";
  }
  return "Engine";
}

export const AppSidebar = memo(AppSidebarImpl);
