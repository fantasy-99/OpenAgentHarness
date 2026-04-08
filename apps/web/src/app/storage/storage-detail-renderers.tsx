import type { StoragePostgresTableName } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { EmptyState, modelMessageTone } from "../primitives";
import {
  contentText,
  contentToolRefs,
  formatTimestamp,
  prettyJson,
  statusTone,
  storageMessageFromRow,
  storageRunStepFromRow,
  storageSessionEventFromRow,
  storageToolCallFromRow,
  toModelCallTrace
} from "../support";
import { MessageToolRefChips } from "../inspector-panels";
import {
  StorageDetailFacts,
  StorageDetailJson,
  StorageDetailPre,
  StorageDetailSection,
  StoragePlainRowDetail,
  storageCollectionSize,
  storageOptionalString,
  storageString
} from "./storage-detail-primitives";

function StorageMessageRowDetail(props: { row: Record<string, unknown> }) {
  const message = storageMessageFromRow(props.row);

  if (!message) {
    return <StoragePlainRowDetail row={props.row} prettyJson={prettyJson} />;
  }

  const text = contentText(message.content);
  const refs = contentToolRefs(message.content);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
          {message.role}
        </span>
        {message.runId ? <Badge>{message.runId}</Badge> : null}
        <MessageToolRefChips content={message.content} />
        <Badge>{formatTimestamp(message.createdAt)}</Badge>
      </div>
      <StorageDetailFacts
        items={[
          { label: "Message ID", value: message.id },
          { label: "Session ID", value: message.sessionId },
          { label: "Parts", value: String(Array.isArray(message.content) ? message.content.length : 1) },
          { label: "Text Size", value: String(text.length) }
        ]}
      />

      <StorageDetailSection title="Message Content">
        <StorageDetailPre value={text || prettyJson(message.content)} maxHeightClassName="max-h-[18rem]" />
      </StorageDetailSection>

      {refs.length > 0 ? (
        <StorageDetailSection title="Tool Trace">
          <div className="flex flex-wrap gap-2">
            {refs.map((ref, index) => (
              <Badge key={`${ref.type}:${ref.toolCallId}:${index}`}>{`${ref.type} · ${ref.toolName} · ${ref.toolCallId}`}</Badge>
            ))}
          </div>
        </StorageDetailSection>
      ) : null}

      {message.metadata ? (
        <StorageDetailSection title="Metadata">
          <StorageDetailJson value={message.metadata} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
        </StorageDetailSection>
      ) : null}
      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageRunStepRowDetail(props: { row: Record<string, unknown> }) {
  const step = storageRunStepFromRow(props.row);

  if (!step) {
    return <StoragePlainRowDetail row={props.row} prettyJson={prettyJson} />;
  }

  const modelTrace = toModelCallTrace(step);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${step.seq}`}</Badge>
        <Badge>{step.stepType}</Badge>
        <Badge className={statusTone(step.status)}>{step.status}</Badge>
        {step.name ? <Badge>{step.name}</Badge> : null}
        {step.agentName ? <Badge>{step.agentName}</Badge> : null}
      </div>
      <StorageDetailFacts
        items={[
          { label: "Step ID", value: step.id },
          { label: "Run ID", value: step.runId },
          { label: "Started", value: formatTimestamp(step.startedAt) },
          { label: "Ended", value: formatTimestamp(step.endedAt) }
        ]}
      />

      {modelTrace ? (
        <StorageDetailSection title="Model Call Trace">
          <StorageDetailJson value={modelTrace} prettyJson={prettyJson} maxHeightClassName="max-h-[18rem]" />
        </StorageDetailSection>
      ) : (
        <>
          <StorageDetailSection title="Input">
            <StorageDetailJson value={step.input ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
          </StorageDetailSection>
          <StorageDetailSection title="Output">
            <StorageDetailJson value={step.output ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
          </StorageDetailSection>
        </>
      )}

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageToolCallRowDetail(props: { row: Record<string, unknown> }) {
  const record = storageToolCallFromRow(props.row);

  if (!record) {
    return <StoragePlainRowDetail row={props.row} prettyJson={prettyJson} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{record.toolName}</Badge>
        <Badge>{record.sourceType}</Badge>
        <Badge className={statusTone(record.status)}>{record.status}</Badge>
        {record.stepId ? <Badge>{record.stepId}</Badge> : null}
        {record.durationMs !== undefined ? <Badge>{`${record.durationMs}ms`}</Badge> : null}
      </div>
      <StorageDetailFacts
        items={[
          { label: "Tool Call ID", value: record.id },
          { label: "Run ID", value: record.runId },
          { label: "Started", value: formatTimestamp(record.startedAt) },
          { label: "Ended", value: formatTimestamp(record.endedAt) }
        ]}
      />

      <StorageDetailSection title="Request">
        <StorageDetailJson value={record.request ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
      </StorageDetailSection>
      <StorageDetailSection title="Response">
        <StorageDetailJson value={record.response ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
      </StorageDetailSection>

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageSessionEventRowDetail(props: { row: Record<string, unknown> }) {
  const event = storageSessionEventFromRow(props.row);

  if (!event) {
    return <StoragePlainRowDetail row={props.row} prettyJson={prettyJson} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{event.event}</Badge>
        {event.runId ? <Badge>{event.runId}</Badge> : null}
        <Badge>{`cursor ${event.cursor}`}</Badge>
        {typeof event.data.toolName === "string" ? <Badge>{String(event.data.toolName)}</Badge> : null}
        {typeof event.data.toolCallId === "string" ? <Badge>{String(event.data.toolCallId)}</Badge> : null}
      </div>
      <StorageDetailFacts
        items={[
          { label: "Event ID", value: event.id },
          { label: "Session ID", value: event.sessionId },
          { label: "Created", value: formatTimestamp(event.createdAt) },
          { label: "Payload Keys", value: String(Object.keys(event.data).length) }
        ]}
      />

      <StorageDetailSection title="Event Data">
        <StorageDetailJson value={event.data} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
      </StorageDetailSection>
      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageWorkspaceRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{storageString(props.row, "kind")}</Badge>
        <Badge className={statusTone(storageOptionalString(props.row, "status") ?? "completed")}>{storageString(props.row, "status")}</Badge>
        <Badge>{storageString(props.row, "execution_policy")}</Badge>
        {typeof props.row.read_only === "boolean" ? <Badge>{props.row.read_only ? "read-only" : "writable"}</Badge> : null}
      </div>

      <StorageDetailFacts
        items={[
          { label: "Workspace ID", value: storageString(props.row, "id") },
          { label: "Name", value: storageString(props.row, "name") },
          { label: "Root Path", value: storageString(props.row, "root_path") },
          { label: "Updated", value: storageString(props.row, "updated_at") }
        ]}
      />

      <StorageDetailSection title="Workspace Config">
        <StorageDetailFacts
          items={[
            { label: "History Mirror", value: typeof props.row.history_mirror_enabled === "boolean" ? String(props.row.history_mirror_enabled) : "n/a" },
            { label: "External Ref", value: storageOptionalString(props.row, "external_ref") ?? "n/a" },
            { label: "Agents", value: storageCollectionSize(props.row.agents) },
            { label: "Actions", value: storageCollectionSize(props.row.actions) },
            { label: "Skills", value: storageCollectionSize(props.row.skills) },
            { label: "MCP Servers", value: storageCollectionSize(props.row.mcp_servers) },
            { label: "Hooks", value: storageCollectionSize(props.row.hooks) },
            { label: "Models", value: storageCollectionSize(props.row.workspace_models) }
          ]}
        />
      </StorageDetailSection>

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageSessionRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={statusTone(storageOptionalString(props.row, "status") ?? "completed")}>{storageString(props.row, "status")}</Badge>
        {storageOptionalString(props.row, "active_agent_name") ? <Badge>{storageString(props.row, "active_agent_name")}</Badge> : null}
        {storageOptionalString(props.row, "model_ref") ? <Badge>{storageString(props.row, "model_ref")}</Badge> : null}
      </div>

      <StorageDetailFacts
        items={[
          { label: "Session ID", value: storageString(props.row, "id") },
          { label: "Workspace ID", value: storageString(props.row, "workspace_id") },
          { label: "Title", value: storageOptionalString(props.row, "title") ?? "Untitled session" },
          { label: "Subject Ref", value: storageString(props.row, "subject_ref") }
        ]}
      />

      <StorageDetailSection title="Session Timeline">
        <StorageDetailFacts
          items={[
            { label: "Agent", value: storageOptionalString(props.row, "agent_name") ?? "n/a" },
            { label: "Last Run", value: storageOptionalString(props.row, "last_run_at") ?? "n/a" },
            { label: "Created", value: storageString(props.row, "created_at") },
            { label: "Updated", value: storageString(props.row, "updated_at") }
          ]}
        />
      </StorageDetailSection>

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageRunRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{storageString(props.row, "trigger_type")}</Badge>
        <Badge className={statusTone(storageOptionalString(props.row, "status") ?? "completed")}>{storageString(props.row, "status")}</Badge>
        {storageOptionalString(props.row, "effective_agent_name") ? <Badge>{storageString(props.row, "effective_agent_name")}</Badge> : null}
      </div>

      <StorageDetailFacts
        items={[
          { label: "Run ID", value: storageString(props.row, "id") },
          { label: "Workspace ID", value: storageString(props.row, "workspace_id") },
          { label: "Session ID", value: storageOptionalString(props.row, "session_id") ?? "n/a" },
          { label: "Parent Run", value: storageOptionalString(props.row, "parent_run_id") ?? "n/a" }
        ]}
      />

      <StorageDetailSection title="Run Timeline">
        <StorageDetailFacts
          items={[
            { label: "Created", value: storageString(props.row, "created_at") },
            { label: "Started", value: storageOptionalString(props.row, "started_at") ?? "n/a" },
            { label: "Heartbeat", value: storageOptionalString(props.row, "heartbeat_at") ?? "n/a" },
            { label: "Ended", value: storageOptionalString(props.row, "ended_at") ?? "n/a" }
          ]}
        />
      </StorageDetailSection>

      {props.row.metadata ? (
        <StorageDetailSection title="Metadata">
          <StorageDetailJson value={props.row.metadata} prettyJson={prettyJson} maxHeightClassName="max-h-36" />
        </StorageDetailSection>
      ) : null}

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageHookRunRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{storageString(props.row, "hook_name")}</Badge>
        <Badge>{storageString(props.row, "event_name")}</Badge>
        <Badge className={statusTone(storageOptionalString(props.row, "status") ?? "completed")}>{storageString(props.row, "status")}</Badge>
      </div>

      <StorageDetailFacts
        items={[
          { label: "Hook Run ID", value: storageString(props.row, "id") },
          { label: "Run ID", value: storageString(props.row, "run_id") },
          { label: "Started", value: storageString(props.row, "started_at") },
          { label: "Ended", value: storageString(props.row, "ended_at") }
        ]}
      />

      <StorageDetailSection title="Capabilities">
        <StorageDetailJson value={props.row.capabilities ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
      {props.row.patch ? (
        <StorageDetailSection title="Patch">
          <StorageDetailJson value={props.row.patch} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
        </StorageDetailSection>
      ) : null}
      {storageOptionalString(props.row, "error_message") ? (
        <StorageDetailSection title="Error">
          <StorageDetailPre value={storageString(props.row, "error_message")} maxHeightClassName="max-h-24" />
        </StorageDetailSection>
      ) : null}

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageArtifactRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{storageString(props.row, "type")}</Badge>
        {storageOptionalString(props.row, "content_ref") ? <Badge>{storageString(props.row, "content_ref")}</Badge> : null}
      </div>

      <StorageDetailFacts
        items={[
          { label: "Artifact ID", value: storageString(props.row, "id") },
          { label: "Run ID", value: storageString(props.row, "run_id") },
          { label: "Path", value: storageOptionalString(props.row, "path") ?? "n/a" },
          { label: "Created", value: storageString(props.row, "created_at") }
        ]}
      />

      {props.row.metadata ? (
        <StorageDetailSection title="Metadata">
          <StorageDetailJson value={props.row.metadata} prettyJson={prettyJson} maxHeightClassName="max-h-36" />
        </StorageDetailSection>
      ) : null}

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

function StorageHistoryEventRowDetail(props: { row: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{storageString(props.row, "entity_type")}</Badge>
        <Badge>{storageString(props.row, "op")}</Badge>
      </div>

      <StorageDetailFacts
        items={[
          { label: "Event ID", value: storageString(props.row, "id") },
          { label: "Workspace ID", value: storageString(props.row, "workspace_id") },
          { label: "Entity ID", value: storageString(props.row, "entity_id") },
          { label: "Occurred", value: storageString(props.row, "occurred_at") }
        ]}
      />

      <StorageDetailSection title="Payload">
        <StorageDetailJson value={props.row.payload ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-40" />
      </StorageDetailSection>

      <StorageDetailSection title="Raw Row">
        <StorageDetailJson value={props.row} prettyJson={prettyJson} maxHeightClassName="max-h-32" />
      </StorageDetailSection>
    </div>
  );
}

export function getStoragePostgresDetailTitle(table: StoragePostgresTableName) {
  switch (table) {
    case "workspaces":
      return "Workspace Detail";
    case "sessions":
      return "Session Detail";
    case "runs":
      return "Run Detail";
    case "messages":
      return "Message Detail";
    case "run_steps":
      return "Run Step Detail";
    case "session_events":
      return "Session Event Detail";
    case "tool_calls":
      return "Tool Call Detail";
    case "hook_runs":
      return "Hook Run Detail";
    case "artifacts":
      return "Artifact Detail";
    case "history_events":
      return "History Event Detail";
    default:
      return "Row Detail";
  }
}

export function renderStoragePostgresRowDetail(table: StoragePostgresTableName, row: Record<string, unknown>) {
  switch (table) {
    case "workspaces":
      return <StorageWorkspaceRowDetail row={row} />;
    case "sessions":
      return <StorageSessionRowDetail row={row} />;
    case "runs":
      return <StorageRunRowDetail row={row} />;
    case "messages":
      return <StorageMessageRowDetail row={row} />;
    case "run_steps":
      return <StorageRunStepRowDetail row={row} />;
    case "session_events":
      return <StorageSessionEventRowDetail row={row} />;
    case "tool_calls":
      return <StorageToolCallRowDetail row={row} />;
    case "hook_runs":
      return <StorageHookRunRowDetail row={row} />;
    case "artifacts":
      return <StorageArtifactRowDetail row={row} />;
    case "history_events":
      return <StorageHistoryEventRowDetail row={row} />;
    default:
      return <StoragePlainRowDetail row={row} prettyJson={prettyJson} />;
  }
}

export function renderStorageRedisDetail(detail: {
  key: string;
  type: string;
  size?: number | undefined;
  ttlMs?: number | undefined;
  value?: unknown;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge>{detail.type}</Badge>
        {detail.size !== undefined ? <Badge>{`size ${detail.size}`}</Badge> : null}
        {detail.ttlMs !== undefined ? <Badge>{`ttl ${detail.ttlMs}ms`}</Badge> : <Badge>persistent</Badge>}
      </div>
      <StorageDetailSection title="Value">
        <StorageDetailJson value={detail.value ?? {}} prettyJson={prettyJson} maxHeightClassName="max-h-[18rem]" />
      </StorageDetailSection>
    </div>
  );
}

export function renderStorageEmptyDetail(title: string, description: string) {
  return <EmptyState title={title} description={description} />;
}
