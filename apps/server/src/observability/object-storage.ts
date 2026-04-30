export type ObjectStorageMetricOperation =
  | "list"
  | "get"
  | "head"
  | "put"
  | "delete"
  | "multipart_upload"
  | "bundle_create"
  | "bundle_extract";

export interface ObjectStorageMetricSnapshot {
  operationCounts: Array<{ operation: ObjectStorageMetricOperation; count: number }>;
  bytes: Array<{ direction: "uploaded" | "downloaded"; count: number }>;
  objectCounts: Array<{ direction: "listed" | "uploaded" | "downloaded" | "deleted"; count: number }>;
  retries: Array<{ operation: ObjectStorageMetricOperation; count: number }>;
  throttles: Array<{ operation: ObjectStorageMetricOperation; count: number }>;
  timeouts: Array<{ operation: ObjectStorageMetricOperation; count: number }>;
  durations: Array<{ operation: ObjectStorageMetricOperation; count: number; totalMs: number; lastMs: number; maxMs: number }>;
}

const operationCounts = new Map<ObjectStorageMetricOperation, number>();
const bytes = new Map<"uploaded" | "downloaded", number>();
const objectCounts = new Map<"listed" | "uploaded" | "downloaded" | "deleted", number>();
const retries = new Map<ObjectStorageMetricOperation, number>();
const throttles = new Map<ObjectStorageMetricOperation, number>();
const timeouts = new Map<ObjectStorageMetricOperation, number>();
const durations = new Map<ObjectStorageMetricOperation, { count: number; totalMs: number; lastMs: number; maxMs: number }>();

function increment<T extends string>(map: Map<T, number>, key: T, count = 1): void {
  if (count <= 0) {
    return;
  }
  map.set(key, (map.get(key) ?? 0) + count);
}

export function recordObjectStorageOperation(input: {
  operation: ObjectStorageMetricOperation;
  countOperation?: boolean | undefined;
  durationMs?: number | undefined;
  bytesUploaded?: number | undefined;
  bytesDownloaded?: number | undefined;
  objectsListed?: number | undefined;
  objectsUploaded?: number | undefined;
  objectsDownloaded?: number | undefined;
  objectsDeleted?: number | undefined;
  retries?: number | undefined;
  throttled?: boolean | undefined;
  timeout?: boolean | undefined;
}): void {
  if (input.countOperation ?? true) {
    increment(operationCounts, input.operation);
  }
  increment(bytes, "uploaded", input.bytesUploaded ?? 0);
  increment(bytes, "downloaded", input.bytesDownloaded ?? 0);
  increment(objectCounts, "listed", input.objectsListed ?? 0);
  increment(objectCounts, "uploaded", input.objectsUploaded ?? 0);
  increment(objectCounts, "downloaded", input.objectsDownloaded ?? 0);
  increment(objectCounts, "deleted", input.objectsDeleted ?? 0);
  increment(retries, input.operation, input.retries ?? 0);
  increment(throttles, input.operation, input.throttled ? 1 : 0);
  increment(timeouts, input.operation, input.timeout ? 1 : 0);

  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    const current = durations.get(input.operation);
    if (current) {
      current.count += 1;
      current.totalMs += input.durationMs;
      current.lastMs = input.durationMs;
      current.maxMs = Math.max(current.maxMs, input.durationMs);
      return;
    }
    durations.set(input.operation, {
      count: 1,
      totalMs: input.durationMs,
      lastMs: input.durationMs,
      maxMs: input.durationMs
    });
  }
}

export function getObjectStorageMetricSnapshot(): ObjectStorageMetricSnapshot {
  const sortByOperation = <T extends { operation: ObjectStorageMetricOperation }>(items: T[]): T[] =>
    items.sort((left, right) => left.operation.localeCompare(right.operation));

  return {
    operationCounts: sortByOperation([...operationCounts.entries()].map(([operation, count]) => ({ operation, count }))),
    bytes: [...bytes.entries()].map(([direction, count]) => ({ direction, count })).sort((left, right) => left.direction.localeCompare(right.direction)),
    objectCounts: [...objectCounts.entries()]
      .map(([direction, count]) => ({ direction, count }))
      .sort((left, right) => left.direction.localeCompare(right.direction)),
    retries: sortByOperation([...retries.entries()].map(([operation, count]) => ({ operation, count }))),
    throttles: sortByOperation([...throttles.entries()].map(([operation, count]) => ({ operation, count }))),
    timeouts: sortByOperation([...timeouts.entries()].map(([operation, count]) => ({ operation, count }))),
    durations: sortByOperation([...durations.entries()].map(([operation, value]) => ({ operation, ...value })))
  };
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

export function renderObjectStorageMetrics(): string {
  const snapshot = getObjectStorageMetricSnapshot();
  const lines = [
    "# HELP oah_object_storage_operations_total Total observed object storage operations.",
    "# TYPE oah_object_storage_operations_total counter"
  ];

  for (const item of snapshot.operationCounts) {
    lines.push(`oah_object_storage_operations_total${formatLabels({ operation: item.operation })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_bytes_total Total bytes uploaded or downloaded through object storage.");
  lines.push("# TYPE oah_object_storage_bytes_total counter");
  for (const item of snapshot.bytes) {
    lines.push(`oah_object_storage_bytes_total${formatLabels({ direction: item.direction })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_objects_total Total object counts observed by direction.");
  lines.push("# TYPE oah_object_storage_objects_total counter");
  for (const item of snapshot.objectCounts) {
    lines.push(`oah_object_storage_objects_total${formatLabels({ direction: item.direction })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_retries_total Total object storage retry attempts.");
  lines.push("# TYPE oah_object_storage_retries_total counter");
  for (const item of snapshot.retries) {
    lines.push(`oah_object_storage_retries_total${formatLabels({ operation: item.operation })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_throttles_total Total object storage throttling failures observed before retry or surfacing.");
  lines.push("# TYPE oah_object_storage_throttles_total counter");
  for (const item of snapshot.throttles) {
    lines.push(`oah_object_storage_throttles_total${formatLabels({ operation: item.operation })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_timeouts_total Total object storage request timeouts.");
  lines.push("# TYPE oah_object_storage_timeouts_total counter");
  for (const item of snapshot.timeouts) {
    lines.push(`oah_object_storage_timeouts_total${formatLabels({ operation: item.operation })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_duration_ms_total Total cumulative object storage operation duration in milliseconds.");
  lines.push("# TYPE oah_object_storage_duration_ms_total counter");
  for (const item of snapshot.durations) {
    lines.push(`oah_object_storage_duration_ms_total${formatLabels({ operation: item.operation })} ${item.totalMs}`);
  }

  lines.push("# HELP oah_object_storage_duration_ms_count Number of observed object storage durations.");
  lines.push("# TYPE oah_object_storage_duration_ms_count counter");
  for (const item of snapshot.durations) {
    lines.push(`oah_object_storage_duration_ms_count${formatLabels({ operation: item.operation })} ${item.count}`);
  }

  lines.push("# HELP oah_object_storage_duration_ms_last Most recent object storage operation duration in milliseconds.");
  lines.push("# TYPE oah_object_storage_duration_ms_last gauge");
  for (const item of snapshot.durations) {
    lines.push(`oah_object_storage_duration_ms_last${formatLabels({ operation: item.operation })} ${item.lastMs}`);
  }

  lines.push("# HELP oah_object_storage_duration_ms_max Maximum observed object storage operation duration in milliseconds.");
  lines.push("# TYPE oah_object_storage_duration_ms_max gauge");
  for (const item of snapshot.durations) {
    lines.push(`oah_object_storage_duration_ms_max${formatLabels({ operation: item.operation })} ${item.maxMs}`);
  }

  return `${lines.join("\n")}\n`;
}

export function resetObjectStorageMetricsForTests(): void {
  operationCounts.clear();
  bytes.clear();
  objectCounts.clear();
  retries.clear();
  throttles.clear();
  timeouts.clear();
  durations.clear();
}
