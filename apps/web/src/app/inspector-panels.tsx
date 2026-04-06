import type { ReactNode } from "react";
import { CircleSlash2, Download } from "lucide-react";

import type { Message, Run, RunStep, Session, SessionEventContract, Workspace } from "@oah/api-contracts";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

import {
  contentToolRefs,
  contentText,
  countMessagesByRole,
  formatTimestamp,
  prettyJson,
  statusTone,
  toModelCallTrace,
  type ModelCallTrace,
  type ModelCallTraceMessage,
  type ModelCallTraceRuntimeTool,
  type ModelCallTraceToolServer
} from "./support";
import {
  CatalogLine,
  compactPreviewText,
  EmptyState,
  EntityPreview,
  InsightRow,
  InspectorTabButton,
  JsonBlock,
  PayloadValueView,
  modelMessageTone
} from "./primitives";

function InspectorPanelHeader(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[color:var(--foreground)]">{props.title}</p>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-[color:var(--muted-foreground)]">{props.description}</p>
      </div>
      {props.action ? <div className="shrink-0">{props.action}</div> : null}
    </div>
  );
}

function MessageToolRefChips(props: { content: Message["content"] }) {
  const refs = contentToolRefs(props.content);
  if (refs.length === 0) {
    return null;
  }

  return (
    <>
      {refs.map((ref, index) => (
        <Badge key={`${ref.type}:${ref.toolCallId}:${index}`}>{`${ref.type}:${ref.toolName}`}</Badge>
      ))}
    </>
  );
}

function MessageContentDetail(props: { content: Message["content"]; maxHeightClassName?: string }) {
  if (typeof props.content === "string") {
    return (
      <pre className={cn("overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
        {props.content}
      </pre>
    );
  }

  if (props.content.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">Empty message parts.</p>;
  }

  return (
    <div className="space-y-2">
      {props.content.map((part, index) => (
        <div key={`${part.type}:${index}`} className="ob-subsection p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <Badge>{part.type}</Badge>
            {"toolName" in part ? <Badge>{part.toolName}</Badge> : null}
            {"toolCallId" in part ? <Badge>{part.toolCallId}</Badge> : null}
          </div>
          {part.type === "text" ? (
            <pre className={cn("overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
              {part.text}
            </pre>
          ) : part.type === "reasoning" ? (
            <pre className={cn("overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
              {part.text}
            </pre>
          ) : part.type === "tool-call" ? (
            <PayloadValueView value={part.input ?? {}} maxHeightClassName={props.maxHeightClassName} mode="input" />
          ) : part.type === "tool-result" ? (
            <PayloadValueView value={part.output} maxHeightClassName={props.maxHeightClassName} mode="result" />
          ) : (
            <PayloadValueView value={part} maxHeightClassName={props.maxHeightClassName} />
          )}
        </div>
      ))}
    </div>
  );
}

function InspectorDisclosure(props: {
  title: string;
  description?: string;
  badge?: string | number;
  children: ReactNode;
}) {
  return (
    <details className="overflow-hidden rounded-xl border border-[color:var(--border)] bg-background">
      <summary className="list-none cursor-pointer px-4 py-3 transition hover:bg-muted/30">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[color:var(--foreground)]">{props.title}</p>
            {props.description ? <p className="mt-1 text-xs leading-6 text-[color:var(--muted-foreground)]">{props.description}</p> : null}
          </div>
          {props.badge !== undefined ? <Badge>{String(props.badge)}</Badge> : null}
        </div>
      </summary>
      <div className="border-t border-[color:var(--border)] p-3">{props.children}</div>
    </details>
  );
}

function ToolNameChips(props: { names: string[]; emptyLabel: string }) {
  if (props.names.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">{props.emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {props.names.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
    </div>
  );
}

function RuntimeToolList(props: { tools: ModelCallTraceRuntimeTool[] }) {
  if (props.tools.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No runtime tool definitions recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.tools.map((tool) => (
        <div key={tool.name} className="ob-subsection p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{tool.name}</Badge>
            {tool.retryPolicy ? <Badge>{tool.retryPolicy}</Badge> : null}
          </div>
          {tool.description ? <p className="mt-2 text-xs leading-6 text-foreground/80">{tool.description}</p> : null}
          {"inputSchema" in tool ? (
            <div className="mt-3">
              <JsonBlock title="Input Schema" value={tool.inputSchema} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ToolServerList(props: { servers: ModelCallTraceToolServer[] }) {
  if (props.servers.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No external tool server metadata recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.servers.map((server) => (
        <div key={server.name} className="ob-subsection px-3 py-2 text-xs leading-6 text-foreground/80">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{server.name}</Badge>
            {server.transportType ? <Badge>{server.transportType}</Badge> : null}
            {server.toolPrefix ? <Badge>{server.toolPrefix}</Badge> : null}
            {server.timeout !== undefined ? <Badge>{`${server.timeout}ms`}</Badge> : null}
          </div>
          {server.include && server.include.length > 0 ? <p className="mt-2">include: {server.include.join(", ")}</p> : null}
          {server.exclude && server.exclude.length > 0 ? <p className="mt-1">exclude: {server.exclude.join(", ")}</p> : null}
        </div>
      ))}
    </div>
  );
}

function ModelMessageList(props: { traceId: string; messages: ModelCallTraceMessage[] }) {
  if (props.messages.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">No recorded model-facing messages.</p>;
  }

  return (
    <div className="space-y-2">
      {props.messages.map((message, index) => (
        <div key={`${props.traceId}:message:${index}`} className="ob-subsection p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
              {message.role}
            </span>
            <MessageToolRefChips content={message.content} />
          </div>
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-72" />
        </div>
      ))}
    </div>
  );
}

function ContextWorkbench(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
  selectedMessage: Message | null;
  onSelectMessage: (messageId: string) => void;
}) {
  const combinedSystemPrompt = props.systemMessages.map((message) => contentText(message.content)).join("\n\n");

  return (
    <section className="space-y-3">
      <section className="ob-section space-y-3 rounded-[16px] p-4">
        <InspectorPanelHeader
          title="System Prompt"
          description="这里显示真正发给模型的合成后 system prompt。当前 runtime 会把多个 system message 用空行连接后发送。"
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <InsightRow label="Source Step" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
          <InsightRow label="Message Count" value={String(props.systemMessages.length)} />
          <InsightRow label="Characters" value={String(combinedSystemPrompt.length)} />
        </div>
        {combinedSystemPrompt.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect the composed system prompt." />
        ) : (
          <div className="ob-subsection rounded-[14px] p-4">
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{combinedSystemPrompt}</pre>
          </div>
        )}
      </section>

      <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Session Message Timeline"
            description="左侧先定位一条消息，再在右侧看完整内容、metadata 和关联 run/tool 信息。"
          />
          <div className="space-y-2">
            {props.messages.length === 0 ? (
              <EmptyState title="No messages" description="Open a session to inspect stored message records." />
            ) : (
              props.messages.map((message) => (
                <button
                  key={message.id}
                  className={cn(
                    "w-full rounded-[16px] border p-3 text-left transition",
                    props.selectedMessage?.id === message.id
                      ? "border-[rgba(19,35,63,0.12)] bg-white/88"
                      : "border-[color:var(--border)] bg-white/62 hover:bg-white/78"
                  )}
                  onClick={() => props.onSelectMessage(message.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{message.role}</Badge>
                    {message.runId ? <Badge>{message.runId}</Badge> : null}
                    <MessageToolRefChips content={message.content} />
                    <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                  </div>
                  <p className="text-sm leading-6 text-[color:var(--foreground)]">{compactPreviewText(message.content)}</p>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Message Detail"
            description="查看当前选中消息的完整正文、metadata，以及与 run / tool 的关联字段。"
          />
          {props.selectedMessage ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{props.selectedMessage.role}</Badge>
                {props.selectedMessage.runId ? <Badge>{props.selectedMessage.runId}</Badge> : null}
                <MessageToolRefChips content={props.selectedMessage.content} />
                <Badge>{formatTimestamp(props.selectedMessage.createdAt)}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <InsightRow label="Message ID" value={props.selectedMessage.id} />
                <InsightRow label="Session ID" value={props.selectedMessage.sessionId} />
              </div>
              <div className="ob-subsection rounded-[14px] p-4">
                <MessageContentDetail content={props.selectedMessage.content} maxHeightClassName="max-h-[28rem]" />
              </div>
              {props.selectedMessage.metadata ? <JsonBlock title="Metadata" value={props.selectedMessage.metadata} /> : null}
            </>
          ) : (
            <EmptyState title="No message selected" description="Choose a message from the left timeline to inspect its full detail." />
          )}
        </section>
      </div>
    </section>
  );
}

function CallsWorkbench(props: {
  traces: ModelCallTrace[];
  selectedTrace: ModelCallTrace | null;
  onSelectTrace: (traceId: string) => void;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
}) {
  return (
    <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
      <div className="space-y-3">
        <LlmSummaryCard
          modelCallCount={props.traces.length}
          latestTrace={props.latestTrace}
          latestModelMessageCounts={props.latestModelMessageCounts}
          resolvedModelNames={props.resolvedModelNames}
          resolvedModelRefs={props.resolvedModelRefs}
          runtimeTools={props.runtimeTools}
          runtimeToolNames={props.runtimeToolNames}
          activeToolNames={props.activeToolNames}
          toolServers={props.toolServers}
          onDownload={props.onDownload}
        />
        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Model Call List"
            description="左侧先定位一次调用，右侧再看这次调用的完整 message list、tool 调用和原始 payload。"
          />
          {props.traces.length === 0 ? (
            <EmptyState title="No model calls" description="Load run steps to inspect model-facing calls." />
          ) : (
            <div className="space-y-2">
              {props.traces.map((trace) => (
                <button
                  key={trace.id}
                  className={cn(
                    "w-full rounded-[16px] border p-3 text-left transition",
                    props.selectedTrace?.id === trace.id
                      ? "border-[rgba(19,35,63,0.12)] bg-white/88"
                      : "border-[color:var(--border)] bg-white/62 hover:bg-white/78"
                  )}
                  onClick={() => props.onSelectTrace(trace.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{`step ${trace.seq}`}</Badge>
                    <Badge>{trace.input.model ?? "n/a"}</Badge>
                    <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {trace.output.toolCalls.length} tool calls · {trace.output.toolResults.length} tool results
                    </p>
                    <p className="text-xs text-[color:var(--muted-foreground)]">{trace.output.finishReason ?? "finish n/a"}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="space-y-3">
        {props.selectedTrace ? (
          <ModelCallTraceCard trace={props.selectedTrace} />
        ) : (
          <EmptyState title="No model call selected" description="Choose a model call from the left list to inspect its full detail." />
        )}
      </div>
    </div>
  );
}

function RuntimeWorkbench(props: {
  mode: "steps" | "events";
  onModeChange: (mode: "steps" | "events") => void;
  steps: RunStep[];
  selectedStep: RunStep | null;
  onSelectStep: (stepId: string) => void;
  events: SessionEventContract[];
  selectedEvent: SessionEventContract | null;
  onSelectEvent: (eventId: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="ob-section rounded-[16px] p-4">
        <InspectorPanelHeader
          title="Runtime Inspector"
          description="把执行视角收在一个分栏里，切换查看 step timeline 或 SSE event feed。"
        />
        <div className="segmented-shell mt-4">
          <InspectorTabButton label="Steps" active={props.mode === "steps"} onClick={() => props.onModeChange("steps")} />
          <InspectorTabButton label="Events" active={props.mode === "events"} onClick={() => props.onModeChange("events")} />
        </div>
      </div>

      {props.mode === "steps" ? (
        <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.76fr)_minmax(0,1.24fr)]">
          <section className="ob-section space-y-3 rounded-[16px] p-4">
            <InspectorPanelHeader title="Step List" description="左侧按顺序浏览 step，右侧看选中 step 的完整 input / output。" />
            {props.steps.length === 0 ? (
              <EmptyState title="No steps" description="Run steps appear here after the selected run starts executing." />
            ) : (
              <div className="space-y-2">
                {props.steps.map((step) => (
                  <button
                    key={step.id}
                    className={cn(
                      "w-full rounded-[16px] border p-3 text-left transition",
                      props.selectedStep?.id === step.id
                        ? "border-[rgba(19,35,63,0.12)] bg-white/88"
                        : "border-[color:var(--border)] bg-white/62 hover:bg-white/78"
                    )}
                    onClick={() => props.onSelectStep(step.id)}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge>{`step ${step.seq}`}</Badge>
                      <Badge>{step.stepType}</Badge>
                      <Badge className={statusTone(step.status)}>{step.status}</Badge>
                    </div>
                    <p className="text-sm text-[color:var(--foreground)]">{step.name ?? step.stepType}</p>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="ob-section space-y-3 rounded-[16px] p-4">
            <InspectorPanelHeader title="Step Detail" description="查看当前选中 step 的完整输入输出。" />
            {props.selectedStep ? (
              props.selectedStep.stepType === "model_call" && toModelCallTrace(props.selectedStep) ? (
                <ModelCallTraceCard trace={toModelCallTrace(props.selectedStep)!} />
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{`step ${props.selectedStep.seq}`}</Badge>
                    <Badge>{props.selectedStep.stepType}</Badge>
                    <Badge className={statusTone(props.selectedStep.status)}>{props.selectedStep.status}</Badge>
                    {props.selectedStep.name ? <Badge>{props.selectedStep.name}</Badge> : null}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <JsonBlock title="Input" value={props.selectedStep.input ?? {}} />
                    <JsonBlock title="Output" value={props.selectedStep.output ?? {}} />
                  </div>
                </>
              )
            ) : (
              <EmptyState title="No step selected" description="Choose a step from the left list to inspect its full payload." />
            )}
          </section>
        </div>
      ) : (
        <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.76fr)_minmax(0,1.24fr)]">
          <section className="ob-section space-y-3 rounded-[16px] p-4">
            <InspectorPanelHeader title="Event List" description="左侧浏览 SSE 事件，右侧查看选中事件的完整 payload。" />
            {props.events.length === 0 ? (
              <EmptyState title="No events" description="SSE events appear here when the current session emits runtime updates." />
            ) : (
              <div className="space-y-2">
                {props.events.map((event) => (
                  <button
                    key={event.id}
                    className={cn(
                      "w-full rounded-[16px] border p-3 text-left transition",
                      props.selectedEvent?.id === event.id
                        ? "border-[rgba(19,35,63,0.12)] bg-white/88"
                        : "border-[color:var(--border)] bg-white/62 hover:bg-white/78"
                    )}
                    onClick={() => props.onSelectEvent(event.id)}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge>{event.event}</Badge>
                      {event.runId ? <Badge>{event.runId}</Badge> : null}
                    </div>
                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      {formatTimestamp(event.createdAt)} · cursor {event.cursor}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="ob-section space-y-3 rounded-[16px] p-4">
            <InspectorPanelHeader title="Event Detail" description="查看当前选中 SSE event 的完整 data payload。" />
            {props.selectedEvent ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge>{props.selectedEvent.event}</Badge>
                  {props.selectedEvent.runId ? <Badge>{props.selectedEvent.runId}</Badge> : null}
                  <Badge>{`cursor ${props.selectedEvent.cursor}`}</Badge>
                </div>
                <JsonBlock title={formatTimestamp(props.selectedEvent.createdAt)} value={props.selectedEvent.data} />
              </>
            ) : (
              <EmptyState title="No event selected" description="Choose an event from the left list to inspect its full payload." />
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function InspectorOverviewCard(props: {
  session: Session | null;
  run: Run | null;
  workspace: Workspace | null;
  sessionName: string;
  workspaceName: string;
  selectedRunId: string;
  onSelectedRunIdChange: (value: string) => void;
  onRefreshRun: () => void;
  onRefreshRunSteps: () => void;
  onCancelRun: () => void;
  modelCallCount: number;
  stepCount: number;
  eventCount: number;
  messageCount: number;
  latestEvent: SessionEventContract | undefined;
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Overview"
        description="Current session, run, and quick actions."
      />

      <div className="flex flex-wrap gap-2">
        <Badge>{props.workspaceName}</Badge>
        <Badge>{props.sessionName}</Badge>
        {props.run?.id ? <Badge>{props.run.id}</Badge> : null}
        <Badge className={statusTone(props.run?.status ?? "idle")}>{props.run?.status ?? "no-run"}</Badge>
        {props.latestEvent ? <Badge>{props.latestEvent.event}</Badge> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Workspace" value={props.workspace?.id ?? props.workspaceName} />
        <InsightRow label="Session" value={props.session?.id ?? props.sessionName} />
        <InsightRow label="Run" value={props.run?.id ?? "n/a"} />
        <InsightRow label="Agent" value={props.run?.effectiveAgentName ?? props.session?.activeAgentName ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Run Status" value={props.run?.status ?? "n/a"} />
        <InsightRow label="Workspace Mode" value={props.workspace?.kind ?? "n/a"} />
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Last Updated" value={formatTimestamp(props.run?.heartbeatAt ?? props.run?.endedAt ?? props.session?.updatedAt)} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="messages" value={props.messageCount} />
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="run steps" value={props.stepCount} />
        <CatalogLine label="events" value={props.eventCount} />
      </div>

      <div className="rounded-[18px] border border-[color:var(--border)] bg-white/62 p-3">
        <p className="text-sm font-medium text-[color:var(--foreground)]">Run</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <Input
            value={props.selectedRunId}
            onChange={(event) => props.onSelectedRunIdChange(event.target.value)}
            placeholder="Selected run"
          />
          <Button variant="secondary" onClick={props.onRefreshRun}>
            Load Run
          </Button>
          <Button variant="secondary" onClick={props.onRefreshRunSteps}>
            Load Steps
          </Button>
          <Button variant="destructive" onClick={props.onCancelRun}>
            <CircleSlash2 className="h-4 w-4" />
            Cancel
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-[color:var(--muted-foreground)]">Load, refresh, or cancel the active run.</p>
      </div>
    </section>
  );
}

function OverviewRecordsCard(props: {
  run: Run | null;
  session: Session | null;
  workspace: Workspace | null;
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Records"
        description="Raw workspace, session, and run objects."
      />

      <InspectorDisclosure title="Run Record" description="当前 run 的完整记录。" badge={props.run ? "ready" : "n/a"}>
        {props.run ? <EntityPreview title={props.run.id} data={props.run} /> : <EmptyState title="No run" description="Pick a run from the conversation or load one manually." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Session Record" description="当前 session 的基础字段与状态。" badge={props.session ? "ready" : "n/a"}>
        {props.session ? <EntityPreview title={props.session.id} data={props.session} /> : <EmptyState title="No session" description="Open a session to inspect its record." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Workspace Record" description="当前 workspace 的配置与运行状态。" badge={props.workspace ? "ready" : "n/a"}>
        {props.workspace ? <EntityPreview title={props.workspace.id} data={props.workspace} /> : <EmptyState title="No workspace" description="Select a workspace to inspect its record." />}
      </InspectorDisclosure>
    </section>
  );
}

function RuntimeActivityCard(props: {
  latestEvent: SessionEventContract | undefined;
  events: SessionEventContract[];
  runSteps: RunStep[];
  messages: Message[];
  latestTrace: ModelCallTrace | null;
}) {
  const recentEvents = props.events.slice(0, 5);

  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Activity"
        description="Latest message, step, event, and trace."
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Last Step" value={props.runSteps.at(-1)?.name ?? props.runSteps.at(-1)?.stepType ?? "n/a"} />
        <InsightRow label="Last Message" value={props.messages.at(-1)?.role ?? "n/a"} />
      </div>

      <InspectorDisclosure
        title="Recent Event Feed"
        description="这里只展示最近几条事件做快速浏览；完整事件流请切到 Runtime 分栏。"
        badge={recentEvents.length}
      >
        {recentEvents.length === 0 ? (
          <EmptyState title="No recent events" description="SSE events will appear here after the session starts producing updates." />
        ) : (
          <div className="space-y-2">
            {recentEvents.map((event) => (
              <div key={event.id} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{event.event}</Badge>
                  {event.runId ? <Badge>{event.runId}</Badge> : null}
                  <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(event.createdAt)}</span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{prettyJson(event.data)}</pre>
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function LlmSummaryCard(props: {
  modelCallCount: number;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="LLM Summary"
        description="这一栏只放模型侧真值：模型解析结果、消息统计、工具注入快照和导出入口。"
        action={
          <Button variant="secondary" size="sm" disabled={props.modelCallCount === 0} onClick={props.onDownload}>
            <Download className="h-4 w-4" />
            Download Session JSON
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={props.latestTrace?.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Provider" value={props.latestTrace?.input.provider ?? "n/a"} />
        <InsightRow label="Latest Finish" value={props.latestTrace?.output.finishReason ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="runtime tools" value={props.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={props.activeToolNames.length} />
        <CatalogLine label="tool servers" value={props.toolServers.length} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow
          label="Latest Call Messages"
          value={`S ${props.latestModelMessageCounts.system} · U ${props.latestModelMessageCounts.user} · A ${props.latestModelMessageCounts.assistant} · T ${props.latestModelMessageCounts.tool}`}
        />
        <InsightRow label="Latest Step" value={props.latestTrace ? `step ${props.latestTrace.seq}` : "n/a"} />
      </div>

      <InspectorDisclosure
        title="Resolved Models"
        description="汇总这次 run 里所有 model call 最终解析到的模型名与 canonical ref。"
        badge={props.resolvedModelNames.length + props.resolvedModelRefs.length}
      >
        <div className="space-y-3">
          <ToolNameChips names={props.resolvedModelNames} emptyLabel="No resolved model names recorded." />
          {props.resolvedModelRefs.length > 0 ? (
            <div className="space-y-2">
              {props.resolvedModelRefs.map((ref) => (
                <div key={ref} className="ob-subsection rounded-[14px] px-3 py-2 text-xs leading-6 text-slate-700">
                  {ref}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--muted-foreground)]">No canonical model refs recorded.</p>
          )}
        </div>
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Tool Snapshot"
        description="工具定义和外部 tool server 信息在这里统一展示，不再在每个 model call 卡片里重复展开。"
        badge={props.runtimeTools.length}
      >
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Names</p>
            <ToolNameChips names={props.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tool Names</p>
            <ToolNameChips names={props.activeToolNames} emptyLabel="No active tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Runtime Tool Definitions</p>
            <RuntimeToolList tools={props.runtimeTools} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">External Tool Servers</p>
            <ToolServerList servers={props.toolServers} />
          </div>
        </div>
      </InspectorDisclosure>
    </section>
  );
}

function SessionContextCard(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Session Context"
        description="把模型真正看到的 system prompt，以及 runtime 持久化下来的 session message timeline 放在一起看。"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="System Prompt Source" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
        <InsightRow label="Stored Messages" value={String(props.messages.length)} />
      </div>

      <InspectorDisclosure
        title="Composed System Prompt"
        description="首个 model call 中真正发给模型的 system message 内容。"
        badge={props.systemMessages.length}
      >
        {props.systemMessages.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect system messages." />
        ) : (
          <div className="space-y-2">
            {props.systemMessages.map((message, index) => (
              <div key={`system-prompt:${index}`} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{index + 1}</Badge>
                  <Badge>system</Badge>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-[28rem]" />
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Stored Session Messages"
        description="runtime 持久化后的 AI SDK 风格消息时间线，直接展示 role + content。"
        badge={props.messages.length}
      >
        {props.messages.length === 0 ? (
          <EmptyState title="No session messages" description="Open a session to inspect stored message records." />
        ) : (
          <div className="space-y-2">
            {props.messages.map((message) => (
              <article key={message.id} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{message.role}</Badge>
                  {message.runId ? <Badge>{message.runId}</Badge> : null}
                  <MessageToolRefChips content={message.content} />
                  <span className="text-xs text-[color:var(--muted-foreground)]">{formatTimestamp(message.createdAt)}</span>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-48" />
                {message.metadata ? (
                  <div className="mt-3">
                    <JsonBlock title="Metadata" value={message.metadata} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function ModelCallTimelineCard(props: { traces: ModelCallTrace[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Model Call Timeline"
        description="按 step 顺序查看真正送给模型的 message list，以及模型返回的 tool call / tool result / 原始 payload。"
      />
      {props.traces.length === 0 ? (
        <EmptyState title="No LLM trace" description="Load run steps to inspect the exact model-facing message list." />
      ) : (
        <div className="space-y-3">
          {props.traces.map((trace) => (
            <ModelCallTraceCard key={trace.id} trace={trace} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCallTraceCard(props: { trace: ModelCallTrace }) {
  const { trace } = props;

  return (
    <article className="ob-subsection rounded-[16px] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${trace.seq}`}</Badge>
        <Badge>{trace.name ?? trace.input.model ?? "model_call"}</Badge>
        <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
        {trace.agentName ? <Badge>{trace.agentName}</Badge> : null}
        {trace.input.provider ? <Badge>{trace.input.provider}</Badge> : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Model" value={trace.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={trace.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Messages" value={String(trace.input.messageCount ?? trace.input.messages.length)} />
        <InsightRow label="Finish" value={trace.output.finishReason ?? "n/a"} />
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="runtime tools" value={trace.input.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={trace.input.activeToolNames.length} />
        <CatalogLine label="tool calls" value={trace.output.toolCalls.length} />
        <CatalogLine label="tool results" value={trace.output.toolResults.length} />
      </div>

      {(trace.output.stepType || trace.output.usage) ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <InsightRow label="AI SDK Step" value={trace.output.stepType ?? "n/a"} />
          <InsightRow
            label="Input Tokens"
            value={typeof trace.output.usage?.inputTokens === "number" ? String(trace.output.usage.inputTokens) : "n/a"}
          />
          <InsightRow
            label="Output Tokens"
            value={typeof trace.output.usage?.outputTokens === "number" ? String(trace.output.usage.outputTokens) : "n/a"}
          />
          <InsightRow
            label="Total Tokens"
            value={typeof trace.output.usage?.totalTokens === "number" ? String(trace.output.usage.totalTokens) : "n/a"}
          />
        </div>
      ) : null}

      {trace.output.text ? (
        <div className="mt-3 rounded-[18px] border border-[color:var(--border)] bg-white/86 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Assistant Reply</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">{trace.output.text}</pre>
        </div>
      ) : null}

      {trace.input.activeToolNames.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Active Tools In This Call</p>
          <ToolNameChips names={trace.input.activeToolNames} emptyLabel="No active tool names recorded." />
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <InspectorDisclosure
          title="LLM Messages"
          description="这一段就是当前 step 真正送给模型的 message list。"
          badge={trace.input.messages.length}
        >
          <ModelMessageList traceId={trace.id} messages={trace.input.messages} />
        </InspectorDisclosure>

        {(trace.output.toolCalls.length > 0 || trace.output.toolResults.length > 0) ? (
          <InspectorDisclosure
            title="Tool Calls And Results"
            description="查看这次 model call 产生的 tool 调用参数，以及回填给模型的结果。"
            badge={trace.output.toolCalls.length + trace.output.toolResults.length}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Calls</p>
                {trace.output.toolCalls.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool calls recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolCalls.map((toolCall, index) => (
                      <div key={`${trace.id}:tool-call:${index}`} className="ob-subsection rounded-[14px] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolCall.toolName ?? "unknown"}</Badge>
                          {toolCall.toolCallId ? <Badge>{toolCall.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolCall.input ?? {}} maxHeightClassName="max-h-56" mode="input" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">Tool Results</p>
                {trace.output.toolResults.length === 0 ? (
                  <p className="text-sm text-[color:var(--muted-foreground)]">No tool results recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolResults.map((toolResult, index) => (
                      <div key={`${trace.id}:tool-result:${index}`} className="ob-subsection rounded-[14px] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolResult.toolName ?? "unknown"}</Badge>
                          {toolResult.toolCallId ? <Badge>{toolResult.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolResult.output} maxHeightClassName="max-h-56" mode="result" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </InspectorDisclosure>
        ) : null}

        <InspectorDisclosure
          title="Raw Step Payload"
          description="保留原始 step.input / step.output，便于核对 audit 记录。"
          badge="raw"
        >
          <div className="space-y-2">
            {trace.output.content && trace.output.content.length > 0 ? <JsonBlock title="AI SDK Content" value={trace.output.content} /> : null}
            {trace.output.reasoning && trace.output.reasoning.length > 0 ? <JsonBlock title="AI SDK Reasoning" value={trace.output.reasoning} /> : null}
            {trace.output.request ? <JsonBlock title="AI SDK Request" value={trace.output.request} /> : null}
            {trace.output.response ? <JsonBlock title="AI SDK Response" value={trace.output.response} /> : null}
            {trace.output.providerMetadata ? <JsonBlock title="Provider Metadata" value={trace.output.providerMetadata} /> : null}
            {trace.output.warnings && trace.output.warnings.length > 0 ? <JsonBlock title="Warnings" value={trace.output.warnings} /> : null}
            <JsonBlock title="Raw Input" value={trace.rawInput ?? {}} />
            <JsonBlock title="Raw Output" value={trace.rawOutput ?? {}} />
          </div>
        </InspectorDisclosure>
      </div>
    </article>
  );
}

function RunStepsCard(props: { steps: RunStep[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Run Steps"
        description="这里看 runtime 级别的 step timeline，包括 step 类型、状态以及原始 input / output。"
      />
      {props.steps.length === 0 ? (
        <EmptyState title="No steps" description="Run steps appear here after the selected run starts executing." />
      ) : (
        <div className="space-y-3">
          {props.steps.map((step) => (
            <article key={step.id} className="ob-subsection rounded-[14px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{`step ${step.seq}`}</Badge>
                <Badge>{step.stepType}</Badge>
                <Badge className={statusTone(step.status)}>{step.status}</Badge>
                {step.name ? <Badge>{step.name}</Badge> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <JsonBlock title="Input" value={step.input ?? {}} />
                <JsonBlock title="Output" value={step.output ?? {}} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SessionEventsCard(props: { events: SessionEventContract[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Session Events"
        description="这里看 SSE event feed，适合核对前端实时流、cursor 以及 event payload。"
      />
      {props.events.length === 0 ? (
        <EmptyState title="No events" description="SSE events appear here when the current session emits runtime updates." />
      ) : (
        <div className="space-y-3">
          {props.events.map((event) => (
            <article key={event.id} className="ob-subsection rounded-[14px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{event.event}</Badge>
                {event.runId ? <Badge>{event.runId}</Badge> : null}
                <span className="text-xs text-[color:var(--muted-foreground)]">cursor {event.cursor}</span>
              </div>
              <JsonBlock title={formatTimestamp(event.createdAt)} value={event.data} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export {
  InspectorPanelHeader,
  MessageToolRefChips,
  MessageContentDetail,
  ContextWorkbench,
  CallsWorkbench,
  RuntimeWorkbench,
  InspectorOverviewCard,
  OverviewRecordsCard,
  RuntimeActivityCard,
  LlmSummaryCard,
  SessionContextCard,
  ModelCallTimelineCard,
  ModelCallTraceCard,
  RunStepsCard,
  SessionEventsCard
};
