import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet } from "../types.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must Read the file earlier in the session before editing it
- Match old_string exactly, without including any line-number prefixes from Read output
- The edit fails if old_string is not unique unless replace_all is true
- Use replace_all for systematic renames within a single file`;

const EditInputSchema = z
  .object({
    file_path: z.string().min(1).describe("The path to the file to edit"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The replacement text"),
    replace_all: z.boolean().optional().describe("Replace all occurrences of old_string")
  })
  .strict();

export function createEditTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    Edit: {
      description: EDIT_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Edit"),
      inputSchema: EditInputSchema,
      async execute(rawInput) {
        context.assertVisible("Edit");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["path", "oldString", "newString", "replaceAll"]),
                file_path:
                  (rawInput as Record<string, unknown>).file_path ??
                  (rawInput as Record<string, unknown>).path,
                old_string:
                  (rawInput as Record<string, unknown>).old_string ??
                  (rawInput as Record<string, unknown>).oldString,
                new_string:
                  (rawInput as Record<string, unknown>).new_string ??
                  (rawInput as Record<string, unknown>).newString,
                replace_all:
                  (rawInput as Record<string, unknown>).replace_all ??
                  (rawInput as Record<string, unknown>).replaceAll
              }
            : rawInput;
        const input = EditInputSchema.parse(normalizedInput);
        if (input.old_string === input.new_string) {
          throw new AppError(400, "native_tool_edit_invalid", "old_string and new_string must differ.");
        }

        return context.withFileSystem("write", input.file_path, async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, input.file_path);
          await context.assertReadBeforeMutating(resolved.relativePath, "Edit", workspaceRoot, fileSystem);
          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (entry?.kind !== "file") {
            throw new AppError(404, "native_tool_file_not_found", `File ${input.file_path} was not found.`);
          }

          const content = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
          const matches = content.split(input.old_string).length - 1;
          if (matches === 0) {
            throw new AppError(400, "native_tool_edit_not_found", "old_string was not found in the target file.");
          }
          if (!input.replace_all && matches > 1) {
            throw new AppError(
              400,
              "native_tool_edit_ambiguous",
              "old_string matched multiple locations. Provide a more specific old_string or set replace_all=true."
            );
          }

          const nextContent = input.replace_all
            ? content.split(input.old_string).join(input.new_string)
            : content.replace(input.old_string, input.new_string);
          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
          return formatToolOutput([
            ["file_path", resolved.relativePath],
            ["occurrences", input.replace_all ? matches : 1]
          ]);
        });
      }
    }
  };
}
