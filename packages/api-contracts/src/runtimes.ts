import { z } from "zod";

export const workspaceRuntimeSchema = z.object({
  name: z.string()
});

export const workspaceRuntimeListSchema = z.object({
  items: z.array(workspaceRuntimeSchema)
});

const booleanQuerySchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return value;
}, z.boolean());

export const uploadWorkspaceRuntimeRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, "Runtime name must contain only alphanumeric characters, hyphens, and underscores"),
  overwrite: booleanQuerySchema.default(false)
});

export const uploadWorkspaceRuntimeResponseSchema = z.object({
  name: z.string()
});

export const updateWorkspaceRuntimeResponseSchema = z.object({
  name: z.string()
});

export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>;
export type WorkspaceRuntimeList = z.infer<typeof workspaceRuntimeListSchema>;
export type UploadWorkspaceRuntimeRequest = z.infer<typeof uploadWorkspaceRuntimeRequestSchema>;
export type UploadWorkspaceRuntimeResponse = z.infer<typeof uploadWorkspaceRuntimeResponseSchema>;
export type UpdateWorkspaceRuntimeResponse = z.infer<typeof updateWorkspaceRuntimeResponseSchema>;
