import { z } from "zod";
import { jsonObjectSchema } from "./common.js";

export const agentCatalogItemSchema = z.object({
  name: z.string(),
  mode: z.enum(["primary", "subagent", "all"]),
  source: z.enum(["platform", "workspace"]),
  description: z.string().optional()
});

export const modelCatalogItemSchema = z.object({
  ref: z.string().regex(/^(platform|workspace)\/.+$/),
  name: z.string(),
  source: z.enum(["platform", "workspace"]),
  provider: z.string(),
  modelName: z.string().optional(),
  url: z.string().optional()
});

export const actionRetryPolicySchema = z.enum(["manual", "safe"]);

export const actionCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional(),
  callableByUser: z.boolean().optional(),
  callableByApi: z.boolean().optional(),
  retryPolicy: actionRetryPolicySchema.optional(),
  inputSchema: jsonObjectSchema.optional()
});

export const skillCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposeToLlm: z.boolean().optional()
});

export const toolCatalogItemSchema = z.object({
  name: z.string(),
  transportType: z.string().optional(),
  toolPrefix: z.string().optional()
});

export const hookCatalogItemSchema = z.object({
  name: z.string(),
  matcher: z.string().optional(),
  handlerType: z.enum(["command", "http", "prompt", "agent"]).optional(),
  events: z.array(z.string()).optional()
});

export const workspaceCatalogSchema = z.object({
  workspaceId: z.string(),
  agents: z.array(agentCatalogItemSchema),
  models: z.array(modelCatalogItemSchema),
  actions: z.array(actionCatalogItemSchema),
  skills: z.array(skillCatalogItemSchema),
  tools: z.array(toolCatalogItemSchema).optional(),
  hooks: z.array(hookCatalogItemSchema),
  nativeTools: z.array(z.string()),
  engineTools: z.array(z.string()).optional()
});

export type AgentCatalogItem = z.infer<typeof agentCatalogItemSchema>;
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ActionRetryPolicy = z.infer<typeof actionRetryPolicySchema>;
export type ActionCatalogItem = z.infer<typeof actionCatalogItemSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type ToolCatalogItem = z.infer<typeof toolCatalogItemSchema>;
export type HookCatalogItem = z.infer<typeof hookCatalogItemSchema>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
