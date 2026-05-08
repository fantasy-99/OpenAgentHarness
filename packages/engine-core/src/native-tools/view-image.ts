import { z } from "zod";

import { AppError } from "../errors.js";
import type { EngineToolSet } from "../types.js";
import { guessImageMimeType, imageToolContent } from "./media.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const VIEW_IMAGE_DESCRIPTION = `Views a local image file as visual input for the model.

Usage:
- First locate image files with Glob, Grep, or Bash, then pass the full local path or workspace-relative path here
- Do not use Read for images; this tool returns AI SDK image content so the next model step can inspect the picture visually
- The path parameter is the local image path to view
- The optional detail parameter can be "original" to request the image at original detail/resolution when supported`;

const ViewImageInputSchema = z
  .object({
    path: z.string().min(1).describe("The full local path or workspace-relative path of the image to view"),
    detail: z.enum(["original"]).optional().describe('Optional detail mode. Use "original" to request original resolution when supported')
  })
  .strict();

export function createViewImageTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    ViewImage: {
      description: VIEW_IMAGE_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("ViewImage"),
      inputSchema: ViewImageInputSchema,
      async execute(rawInput) {
        context.assertVisible("ViewImage");
        const input = ViewImageInputSchema.parse(rawInput);

        return context.withFileSystem("read", input.path, async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, input.path);
          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (entry?.kind !== "file") {
            throw new AppError(404, "native_tool_file_not_found", `Image ${input.path} was not found.`);
          }

          const mediaType = guessImageMimeType(resolved.absolutePath);
          if (!mediaType) {
            throw new AppError(400, "native_tool_unsupported_image", `File ${resolved.relativePath} is not a supported image type.`);
          }

          const bytes = await fileSystem.readFile(resolved.absolutePath);
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);

          return imageToolContent({
            absolutePath: resolved.absolutePath,
            relativePath: resolved.relativePath,
            mediaType,
            sizeBytes: entry.size,
            bytes,
            detail: input.detail
          });
        });
      }
    }
  };
}
