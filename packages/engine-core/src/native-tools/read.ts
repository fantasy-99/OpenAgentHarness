import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet, WorkspaceFileSystemEntry } from "../types.js";
import { DEFAULT_READ_LIMIT } from "./constants.js";
import { formatReadLines } from "./fs-utils.js";
import { formatImageDescriptionOutput, guessImageMimeType, imageContextMessage } from "./media.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:
- The file_path parameter should point to a file inside the current workspace
- Subagent task outputs can also be read with agent-task://<task_id>/output when the user explicitly asks you to inspect the stored transcript
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify an offset and limit for targeted reads
- Results are returned with line numbers starting at 1
- Directories are returned as sorted listings
- Images are injected into the current model context as an internal user message instead of being returned as base64.`;

const ReadInputSchema = z
  .object({
    file_path: z.string().min(1).describe("The path to the file to read"),
    offset: z.number().int().nonnegative().optional().describe("The line number to start reading from"),
    limit: z.number().int().positive().optional().describe("The number of lines to read"),
    pages: z.string().optional().describe("Page range for PDF files")
  })
  .strict();

function formatDirectoryEntry(entry: WorkspaceFileSystemEntry): string {
  const suffix = entry.kind === "directory" ? "/" : "";
  return [
    entry.kind,
    `${entry.name}${suffix}`,
    ...(typeof entry.sizeBytes === "number" ? [`${entry.sizeBytes} bytes`] : []),
    ...(entry.updatedAt ? [`updated ${entry.updatedAt}`] : [])
  ].join("  ");
}

export function createReadTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    Read: {
      description: READ_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Read"),
      inputSchema: ReadInputSchema,
      async execute(rawInput, executionContext) {
        context.assertVisible("Read");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["path"]),
                file_path:
                  (rawInput as Record<string, unknown>).file_path ??
                  (rawInput as Record<string, unknown>).path
              }
            : rawInput;
        const input = ReadInputSchema.parse(normalizedInput);
        if (input.pages) {
          throw new AppError(501, "native_tool_pdf_pages_unsupported", "Read pages is not implemented for PDF files in this runtime.");
        }

        const virtualFile = await context.readVirtualFile({
          filePath: input.file_path,
          abortSignal: executionContext.abortSignal
        });
        if (virtualFile) {
          const offset = input.offset ?? 0;
          const limit = input.limit ?? DEFAULT_READ_LIMIT;
          const { rendered, truncated, totalLines } = formatReadLines(virtualFile.content, offset, limit);
          return formatToolOutput(
            [
              ["file_path", virtualFile.filePath],
              ["offset", Math.max(1, offset || 1)],
              ["returned_lines", rendered.length],
              ["total_lines", totalLines],
              ["truncated", truncated],
              ["virtual", true]
            ],
            [
              {
                title: "content",
                lines: rendered,
                emptyText: "(empty file)"
              }
            ]
          );
        }

        return context.withFileSystem("read", input.file_path, async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, input.file_path);
          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (!entry) {
            throw new AppError(404, "native_tool_file_not_found", `File ${input.file_path} was not found.`);
          }

          if (entry.kind === "directory") {
            const entries = (await fileSystem.readdir(resolved.absolutePath)).sort((left, right) => {
              if (left.kind !== right.kind) {
                return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : left.kind.localeCompare(right.kind);
              }

              return left.name.localeCompare(right.name);
            });
            return formatToolOutput(
              [
                ["path", resolved.relativePath],
                ["absolute_path", resolved.absolutePath],
                ["entries", entries.length],
                ["kind", "directory"]
              ],
              [
                {
                  title: "contents",
                  lines: entries.map(formatDirectoryEntry),
                  emptyText: "(empty directory)"
                }
              ]
            );
          }

          if (entry.kind !== "file") {
            throw new AppError(400, "native_tool_entry_not_readable", `Path ${input.file_path} is not a readable file or directory.`);
          }

          const mediaType = guessImageMimeType(resolved.absolutePath);
          if (mediaType) {
            const bytes = await fileSystem.readFile(resolved.absolutePath);
            await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);
            context.injectModelContextMessage(
              imageContextMessage({
                absolutePath: resolved.absolutePath,
                relativePath: resolved.relativePath,
                mediaType,
                sizeBytes: entry.size,
                bytes
              })
            );
            return formatImageDescriptionOutput({
              absolutePath: resolved.absolutePath,
              relativePath: resolved.relativePath,
              mediaType,
              sizeBytes: entry.size,
              injected: Boolean(context.options?.injectModelContextMessage)
            });
          }

          const content = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
          const offset = input.offset ?? 0;
          const limit = input.limit ?? DEFAULT_READ_LIMIT;
          const { rendered, truncated, totalLines } = formatReadLines(content, offset, limit);
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);
          return formatToolOutput(
            [
              ["file_path", resolved.relativePath],
              ["offset", Math.max(1, offset || 1)],
              ["returned_lines", rendered.length],
              ["total_lines", totalLines],
              ["truncated", truncated]
            ],
            [
              {
                title: "content",
                lines: rendered,
                emptyText: "(empty file)"
              }
            ]
          );
        });
      }
    }
  };
}
