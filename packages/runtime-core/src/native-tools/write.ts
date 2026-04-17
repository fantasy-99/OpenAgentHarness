import path from "node:path";

import { z } from "zod";

import { formatToolOutput } from "../capabilities/tool-output.js";
import type { RuntimeToolSet } from "../types.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const WRITE_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool overwrites the target file if it already exists
- If this is an existing file, you must Read it earlier in the session before writing it
- Prefer Edit for modifying existing files instead of rewriting the whole file
- Use this tool for new files or complete rewrites`;

const WriteInputSchema = z
  .object({
    file_path: z.string().min(1).describe("The path to the file to write"),
    content: z.string().describe("The full file contents to write")
  })
  .strict();

export function createWriteTool(context: NativeToolFactoryContext): RuntimeToolSet {
  return {
    Write: {
      description: WRITE_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Write"),
      inputSchema: WriteInputSchema,
      async execute(rawInput) {
        context.assertVisible("Write");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["path"]),
                file_path:
                  (rawInput as Record<string, unknown>).file_path ??
                  (rawInput as Record<string, unknown>).path
              }
            : rawInput;
        const input = WriteInputSchema.parse(normalizedInput);
        const resolved = await resolveWorkspacePath(context.fileSystem, context.workspaceRoot, input.file_path);
        await context.assertReadBeforeMutating(resolved.relativePath, "Write");
        await context.fileSystem.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await context.fileSystem.writeFile(resolved.absolutePath, Buffer.from(input.content, "utf8"));
        return formatToolOutput([
          ["file_path", resolved.relativePath],
          ["bytes_written", Buffer.byteLength(input.content, "utf8")]
        ]);
      }
    }
  };
}
