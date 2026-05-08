import { z } from "zod";

import { AppError } from "../errors.js";
import type { EngineToolSet } from "../types.js";
import { formatImageDescriptionOutput, guessImageMimeType, imageContextMessage } from "./media.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const VIEW_IMAGE_DESCRIPTION = `Views a local image file by injecting it into the current model context.

Usage:
- First locate image files with Glob, Grep, or Bash, then pass the full local path or workspace-relative path here
- The image is injected as an internal user message for the next model step; the tool result never returns base64 image data
- Use the optional prompt parameter to ask a targeted question about the image in the current conversation context
- The path parameter is the local image path to view`;

const ViewImageInputSchema = z
  .object({
    path: z.string().min(1).describe("The full local path or workspace-relative path of the image to view"),
    prompt: z.string().trim().min(1).optional().describe("Optional targeted question or instruction for analyzing the image")
  })
  .strict();

export function createViewImageTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    ViewImage: {
      description: VIEW_IMAGE_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("ViewImage"),
      inputSchema: ViewImageInputSchema,
      async execute(rawInput, executionContext) {
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

          context.injectModelContextMessage(
            imageContextMessage({
              absolutePath: resolved.absolutePath,
              relativePath: resolved.relativePath,
              mediaType,
              sizeBytes: entry.size,
              bytes,
              prompt: input.prompt
            })
          );

          return formatImageDescriptionOutput({
            absolutePath: resolved.absolutePath,
            relativePath: resolved.relativePath,
            mediaType,
            sizeBytes: entry.size,
            injected: Boolean(context.options?.injectModelContextMessage),
            prompt: input.prompt
          });
        });
      }
    }
  };
}
