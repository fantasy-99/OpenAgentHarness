import type {
  EngineLogCategory,
  EngineLogEventContext,
  EngineLogEventData,
  EngineLogLevel
} from "@oah/api-contracts";
import { engineLogEventDataSchema } from "@oah/api-contracts";
import type {
  EngineLogger,
  SessionEventStore,
  Session
} from "@oah/engine-core";

const sensitiveKeyPattern = /(^|_)(authorization|token|api_?key|secret|password)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitiveDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveDetails(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[redacted]" : redactSensitiveDetails(nestedValue)
    ])
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveEngineLogCategory(message: string, details: Record<string, unknown> | undefined): EngineLogCategory {
  const detailCategory = readString(details?.category);
  if (
    detailCategory === "run" ||
    detailCategory === "model" ||
    detailCategory === "tool" ||
    detailCategory === "hook" ||
    detailCategory === "agent" ||
    detailCategory === "http" ||
    detailCategory === "system"
  ) {
    return detailCategory;
  }

  if (readString(details?.toolName) || readString(details?.toolCallId) || /tool/iu.test(message)) {
    return "tool";
  }

  if (readString(details?.hookName) || /hook/iu.test(message)) {
    return "hook";
  }

  if (readString(details?.provider) || readString(details?.canonicalModelRef) || /model/iu.test(message)) {
    return "model";
  }

  if (readString(details?.agentName) || /agent/iu.test(message)) {
    return "agent";
  }

  if (details && ("status" in details || "errorCode" in details || "runId" in details)) {
    return "run";
  }

  return "system";
}

function resolveEngineLogContext(details: Record<string, unknown> | undefined): EngineLogEventContext | undefined {
  if (!details) {
    return undefined;
  }

  const context = {
    ...(readString(details.workspaceId) ? { workspaceId: readString(details.workspaceId) } : {}),
    ...(readString(details.sessionId) ? { sessionId: readString(details.sessionId) } : {}),
    ...(readString(details.runId) ? { runId: readString(details.runId) } : {}),
    ...(readString(details.stepId) ? { stepId: readString(details.stepId) } : {}),
    ...(readString(details.toolCallId) ? { toolCallId: readString(details.toolCallId) } : {}),
    ...(readString(details.agentName) ? { agentName: readString(details.agentName) } : {})
  };

  return Object.keys(context).length > 0 ? context : undefined;
}

function buildEngineLogEventData(input: {
  level: EngineLogLevel;
  category: EngineLogCategory;
  message: string;
  details?: unknown;
  context?: EngineLogEventContext | undefined;
  source: "server" | "web";
  timestamp: string;
}): EngineLogEventData {
  return engineLogEventDataSchema.parse({
    level: input.level,
    category: input.category,
    message: input.message,
    ...(input.details !== undefined ? { details: redactSensitiveDetails(input.details) } : {}),
    ...(input.context ? { context: input.context } : {}),
    source: input.source,
    timestamp: input.timestamp
  });
}

export async function appendEngineLogEvent(
  sessionEventStore: SessionEventStore,
  input: {
    sessionId: string;
    runId?: string | undefined;
    level: EngineLogLevel;
    category: EngineLogCategory;
    message: string;
    details?: unknown;
    context?: EngineLogEventContext | undefined;
    timestamp: string;
  }
): Promise<void> {
  const data = buildEngineLogEventData({
    level: input.level,
    category: input.category,
    message: input.message,
    details: input.details,
    context: {
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.context ?? {})
    },
    source: "server",
    timestamp: input.timestamp
  });

  await sessionEventStore.append({
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    event: "engine.log",
    data
  });
}

export function buildRuntimeConsoleLogger(options: {
  enabled: boolean;
  echoToStdout?: boolean | undefined;
  sessionEventStore?: SessionEventStore | undefined;
  now: () => string;
}): EngineLogger | undefined {
  if (!options.enabled) {
    return undefined;
  }

  const emit = (level: EngineLogLevel, message: string, details?: Record<string, unknown>) => {
    const sanitizedDetails = details ? (redactSensitiveDetails(details) as Record<string, unknown>) : undefined;
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;

    if (options.echoToStdout !== false) {
      if (sanitizedDetails) {
        consoleMethod(`[oah-runtime-debug] ${message}`, sanitizedDetails);
      } else {
        consoleMethod(`[oah-runtime-debug] ${message}`);
      }
    }

    const sessionId = readString(sanitizedDetails?.sessionId);
    if (!sessionId || !options.sessionEventStore) {
      return;
    }

    void appendEngineLogEvent(options.sessionEventStore, {
      sessionId,
      ...(readString(sanitizedDetails?.runId) ? { runId: readString(sanitizedDetails?.runId) } : {}),
      level,
      category: resolveEngineLogCategory(message, sanitizedDetails),
      message,
      details: sanitizedDetails,
      context: resolveEngineLogContext(sanitizedDetails),
      timestamp: options.now()
    }).catch((error) => {
      console.error(
        `[oah-runtime-debug] Failed to append engine.log for session ${sessionId}.`,
        error
      );
    });
  };

  return {
    debug(message, details) {
      emit("debug", message, details);
    },
    warn(message, details) {
      emit("warn", message, details);
    },
    error(message, details) {
      emit("error", message, details);
    }
  };
}

export function normalizeEngineLogDetails(details: unknown): unknown {
  return redactSensitiveDetails(details);
}

export function buildHttpErrorEngineLogContext(input: {
  sessionId: string;
  runId?: string | undefined;
  workspaceId?: string | undefined;
}): EngineLogEventContext {
  return {
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
  };
}

export type { EngineLogEventData };
