import { z } from "zod";
import { timestampSchema } from "./common.js";
import { workspaceFileEncodingSchema } from "./workspaces.js";

export const sessionTerminalStatusSchema = z.enum(["running", "completed", "failed", "stopped", "unknown"]);

export const sessionTerminalSnapshotSchema = z.object({
  sessionId: z.string(),
  terminalId: z.string(),
  status: sessionTerminalStatusSchema,
  outputPath: z.string(),
  output: z.string(),
  encoding: workspaceFileEncodingSchema,
  truncated: z.boolean(),
  inputWritable: z.boolean().optional(),
  terminalKind: z.enum(["pty", "pipe"]).optional(),
  pid: z.number().optional(),
  description: z.string().optional(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional()
});

export const sessionTerminalInputRequestSchema = z.object({
  input: z.string(),
  appendNewline: z.boolean().optional()
});

export const sessionTerminalInputAcceptedSchema = z.object({
  sessionId: z.string(),
  terminalId: z.string(),
  status: sessionTerminalStatusSchema,
  inputWritten: z.literal(true),
  appendNewline: z.boolean(),
  inputWritable: z.boolean().optional(),
  updatedAt: timestampSchema.optional()
});

export type SessionTerminalSnapshot = z.infer<typeof sessionTerminalSnapshotSchema>;
export type SessionTerminalInputRequest = z.infer<typeof sessionTerminalInputRequestSchema>;
export type SessionTerminalInputAccepted = z.infer<typeof sessionTerminalInputAcceptedSchema>;
