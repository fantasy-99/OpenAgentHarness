import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet } from "../types.js";
import { DEFAULT_READ_LIMIT } from "./constants.js";
import { formatReadLines } from "./fs-utils.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:
- The file_path parameter should point to a file inside the current workspace
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify an offset and limit for targeted reads
- Results are returned with line numbers starting at 1
- This tool can only read files, not directories. To inspect directories, use Bash.`;

const ReadInputSchema = z
  .object({
    file_path: z.string().min(1).describe("The path to the file to read"),
    offset: z.number().int().nonnegative().optional().describe("The line number to start reading from"),
    limit: z.number().int().positive().optional().describe("The number of lines to read"),
    pages: z.string().optional().describe("Page range for PDF files")
  })
  .strict();

export function createReadTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    Read: {
      description: READ_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Read"),
      inputSchema: ReadInputSchema,
      async execute(rawInput) {
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
        const resolved = await resolveWorkspacePath(context.fileSystem, context.workspaceRoot, input.file_path);
        const entry = await context.fileSystem.stat(resolved.absolutePath).catch(() => null);
        if (entry?.kind !== "file") {
          throw new AppError(404, "native_tool_file_not_found", `File ${input.file_path} was not found.`);
        }

        if (input.pages) {
          throw new AppError(501, "native_tool_pdf_pages_unsupported", "Read pages is not implemented for PDF files in this runtime.");
        }

        const content = (await context.fileSystem.readFile(resolved.absolutePath)).toString("utf8");
        const offset = input.offset ?? 0;
        const limit = input.limit ?? DEFAULT_READ_LIMIT;
        const { rendered, truncated, totalLines } = formatReadLines(content, offset, limit);
        await context.rememberRead(resolved.relativePath);
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
      }
    }
  };
}
