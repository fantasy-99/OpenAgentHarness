import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema, timestampSchema } from "./common.js";

export const runtimeLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const runtimeLogCategorySchema = z.enum(["run", "model", "tool", "hook", "agent", "http", "system"]);
export const runtimeLogEventContextSchema = z.object({
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  toolCallId: z.string().optional(),
  agentName: z.string().optional()
});
export const runtimeLogEventDataSchema = z.object({
  level: runtimeLogLevelSchema,
  category: runtimeLogCategorySchema,
  message: z.string(),
  details: z.union([jsonValueSchema, z.string()]).optional(),
  context: runtimeLogEventContextSchema.optional(),
  source: z.enum(["server", "web"]),
  timestamp: timestampSchema
});

export const sessionEventSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  event: z.enum([
    "run.queued",
    "run.started",
    "message.delta",
    "message.completed",
    "agent.switch.requested",
    "agent.switched",
    "agent.delegate.started",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "hook.notice",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "runtime.log",
    "run.completed",
    "run.failed",
    "run.cancelled"
  ]),
  data: jsonObjectSchema,
  createdAt: timestampSchema
});

export type RuntimeLogLevel = z.infer<typeof runtimeLogLevelSchema>;
export type RuntimeLogCategory = z.infer<typeof runtimeLogCategorySchema>;
export type RuntimeLogEventContext = z.infer<typeof runtimeLogEventContextSchema>;
export type RuntimeLogEventData = z.infer<typeof runtimeLogEventDataSchema>;
export type SessionEventContract = z.infer<typeof sessionEventSchema>;
