import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import {
  CallsWorkbench,
  ContextWorkbench,
  InspectorOverviewCard,
  OverviewRecordsCard,
  RuntimeActivityCard,
  RuntimeWorkbench
} from "../inspector-panels";
import { EmptyState, EntityPreview, CatalogLine } from "../primitives";
import { formatTimestamp, statusTone } from "../support";
import type { useAppController } from "../use-app-controller";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

export function InspectorWorkspace(props: RuntimeProps) {
  return (
    <div className="workspace-pane flex min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs value={props.inspectorTab} onValueChange={(value) => props.setInspectorTab(value as RuntimeProps["inspectorTab"])} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/80 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <TabsList variant="line" className="gap-1 p-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="context">Context</TabsTrigger>
            <TabsTrigger value="calls">Calls</TabsTrigger>
            <TabsTrigger value="runtime">Runtime</TabsTrigger>
            <TabsTrigger value="catalog">Catalog</TabsTrigger>
            <TabsTrigger value="model">Model</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap gap-2">
              {props.session?.id ? <Badge variant="outline">{props.session.id}</Badge> : null}
              {props.selectedRunId || props.run?.id ? <Badge variant="outline">{props.selectedRunId || props.run?.id}</Badge> : null}
              {props.run?.status ? <Badge className={statusTone(props.run.status)}>{props.run.status}</Badge> : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="secondary">messages {props.messages.length}</Badge>
            <Badge variant="secondary">calls {props.modelCallTraces.length}</Badge>
            <Badge variant="secondary">steps {props.runSteps.length}</Badge>
            <Badge variant="secondary">events {props.deferredEvents.length}</Badge>
            <span className="self-center text-xs text-muted-foreground">{props.inspectorSubtitle}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <TabsContent value="overview">
              <div className="grid gap-3 2xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
                <div className="space-y-3">
                  <InspectorOverviewCard
                    session={props.session}
                    run={props.run}
                    workspace={props.workspace}
                    sessionName={props.currentSessionName}
                    workspaceName={props.currentWorkspaceName}
                    selectedRunId={props.selectedRunId}
                    onSelectedRunIdChange={props.setSelectedRunId}
                    onRefreshRun={props.refreshRun}
                    onRefreshRunSteps={props.refreshRunSteps}
                    onCancelRun={props.cancelCurrentRun}
                    modelCallCount={props.modelCallTraces.length}
                    stepCount={props.runSteps.length}
                    eventCount={props.deferredEvents.length}
                    messageCount={props.messages.length}
                    latestEvent={props.latestEvent}
                  />
                  <OverviewRecordsCard run={props.run} session={props.session} workspace={props.workspace} />
                </div>
                <div className="space-y-3">
                  <RuntimeActivityCard latestEvent={props.latestEvent} events={props.deferredEvents} runSteps={props.runSteps} messages={props.messages} latestTrace={props.latestModelCallTrace} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="context">
              <ContextWorkbench
                systemMessages={props.composedSystemMessages}
                firstTrace={props.firstModelCallTrace}
                messages={props.messages}
                selectedMessage={props.selectedSessionMessage}
                onSelectMessage={props.setSelectedMessageId}
              />
            </TabsContent>

            <TabsContent value="calls">
              <CallsWorkbench
                traces={props.modelCallTraces}
                selectedTrace={props.selectedModelCallTrace}
                onSelectTrace={props.setSelectedTraceId}
                latestTrace={props.latestModelCallTrace}
                latestModelMessageCounts={props.latestModelMessageCounts}
                resolvedModelNames={props.resolvedModelNames}
                resolvedModelRefs={props.resolvedModelRefs}
                runtimeTools={props.allRuntimeTools}
                runtimeToolNames={props.allRuntimeToolNames}
                activeToolNames={props.allAdvertisedToolNames}
                toolServers={props.allToolServers}
                onDownload={props.downloadSessionTrace}
              />
            </TabsContent>

            <TabsContent value="runtime">
              <RuntimeWorkbench
                mode={props.runtimeInspectorMode}
                onModeChange={props.setRuntimeInspectorMode}
                steps={props.runSteps}
                selectedStep={props.selectedRunStep}
                onSelectStep={props.setSelectedStepId}
                events={props.deferredEvents}
                selectedEvent={props.selectedSessionEvent}
                onSelectEvent={props.setSelectedEventId}
              />
            </TabsContent>

            <TabsContent value="catalog">
              {props.catalog ? (
                <div className="space-y-3">
                  {props.workspace ? (
                    <div className="ob-section p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Mirror Sync</p>
                          <p className="mt-1 text-xs leading-6 text-muted-foreground">
                            将中心历史异步同步到当前 workspace 的 <code>.openharness/data/history.db</code>。
                          </p>
                        </div>
                        <Badge className={props.workspace.historyMirrorEnabled ? "bg-emerald-600 text-white dark:bg-emerald-700 dark:text-white" : ""}>
                          {props.workspace.historyMirrorEnabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant={props.workspace.historyMirrorEnabled ? "secondary" : "default"} size="sm" disabled={props.mirrorToggleBusy || props.workspace.kind !== "project" || props.workspace.historyMirrorEnabled} onClick={() => props.updateWorkspaceHistoryMirrorEnabled(true)}>
                          Enable
                        </Button>
                        <Button variant={!props.workspace.historyMirrorEnabled ? "secondary" : "default"} size="sm" disabled={props.mirrorToggleBusy || props.workspace.kind !== "project" || !props.workspace.historyMirrorEnabled} onClick={() => props.updateWorkspaceHistoryMirrorEnabled(false)}>
                          Disable
                        </Button>
                        <Button variant="ghost" size="sm" disabled={props.mirrorToggleBusy || props.mirrorRebuildBusy} onClick={() => props.refreshWorkspace(props.workspace!.id)}>
                          Refresh
                        </Button>
                        <Button variant="secondary" size="sm" disabled={props.mirrorRebuildBusy || props.mirrorToggleBusy || props.workspace.kind !== "project" || !props.workspace.historyMirrorEnabled} onClick={props.rebuildWorkspaceHistoryMirror}>
                          Rebuild
                        </Button>
                      </div>
                      {props.mirrorStatus ? (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <CatalogLine label="mirrorState" value={props.mirrorStatus.state} />
                          <CatalogLine label="lastEventId" value={props.mirrorStatus.lastEventId ? String(props.mirrorStatus.lastEventId) : "n/a"} />
                          <CatalogLine label="lastSyncedAt" value={props.mirrorStatus.lastSyncedAt ? formatTimestamp(props.mirrorStatus.lastSyncedAt) : "n/a"} />
                          <CatalogLine label="dbPath" value={props.mirrorStatus.dbPath ?? "n/a"} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="grid gap-2">
                    <CatalogLine label="agents" value={props.catalog.agents.length} />
                    <CatalogLine label="models" value={props.catalog.models.length} />
                    <CatalogLine label="actions" value={props.catalog.actions.length} />
                    <CatalogLine label="skills" value={props.catalog.skills.length} />
                    <CatalogLine label="tools" value={props.catalog.tools?.length ?? 0} />
                    <CatalogLine label="hooks" value={props.catalog.hooks.length} />
                    <CatalogLine label="nativeTools" value={props.catalog.nativeTools.length} />
                  </div>
                  <EntityPreview title={props.catalog.workspaceId} data={props.catalog} />
                </div>
              ) : (
                <EmptyState title="No catalog" description="Load a workspace first." />
              )}
            </TabsContent>

            <TabsContent value="model">
              <div className="max-w-3xl space-y-3">
                <Input value={props.modelDraft.model} onChange={(event) => props.setModelDraft((current) => ({ ...current, model: event.target.value }))} placeholder="Model" />
                <Textarea value={props.modelDraft.prompt} onChange={(event) => props.setModelDraft((current) => ({ ...current, prompt: event.target.value }))} className="min-h-28" placeholder="Prompt" />
                <Button onClick={props.generateOnce} disabled={props.generateBusy}>
                  <Sparkles className="h-4 w-4" />
                  Generate
                </Button>
                {props.generateOutput ? <EntityPreview title={props.generateOutput.model} data={props.generateOutput} /> : <EmptyState title="No output" description="Generate output appears here." />}
              </div>
            </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
