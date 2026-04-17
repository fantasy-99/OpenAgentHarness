import { z } from "zod";

export const workspaceBlueprintSchema = z.object({
  name: z.string()
});

export const workspaceBlueprintListSchema = z.object({
  items: z.array(workspaceBlueprintSchema)
});

export const uploadWorkspaceBlueprintRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, "Blueprint name must contain only alphanumeric characters, hyphens, and underscores"),
  overwrite: z.boolean().default(false)
});

export const uploadWorkspaceBlueprintResponseSchema = z.object({
  name: z.string()
});

export type WorkspaceBlueprint = z.infer<typeof workspaceBlueprintSchema>;
export type WorkspaceBlueprintList = z.infer<typeof workspaceBlueprintListSchema>;
export type UploadWorkspaceBlueprintRequest = z.infer<typeof uploadWorkspaceBlueprintRequestSchema>;
export type UploadWorkspaceBlueprintResponse = z.infer<typeof uploadWorkspaceBlueprintResponseSchema>;
