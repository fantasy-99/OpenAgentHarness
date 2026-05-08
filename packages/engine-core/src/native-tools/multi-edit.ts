import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet } from "../types.js";
import { resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const MULTI_EDIT_DESCRIPTION = `Performs multiple exact string replacements in one file atomically.

Usage:
- You must Read the file earlier in the session before editing it
- All edits are validated before anything is written
- Edits are applied in order to the evolving file content
- The operation fails without writing if any old_string is missing or ambiguous`;

const MultiEditInputSchema = z
  .object({
    file_path: z.string().min(1).describe("The path to the file to edit"),
    edits: z
      .array(
        z
          .object({
            old_string: z.string().describe("The exact text to replace"),
            new_string: z.string().describe("The replacement text"),
            replace_all: z.boolean().optional().describe("Replace all occurrences of old_string")
          })
          .strict()
      )
      .min(1)
      .describe("The ordered edit operations to apply atomically")
  })
  .strict();

function applyOneEdit(
  content: string,
  edit: { old_string: string; new_string: string; replace_all?: boolean | undefined },
  index: number
) {
  if (edit.old_string === edit.new_string) {
    throw new AppError(400, "native_tool_multi_edit_invalid", `edits[${index}] old_string and new_string must differ.`);
  }

  const matches = content.split(edit.old_string).length - 1;
  if (matches === 0) {
    throw new AppError(400, "native_tool_multi_edit_not_found", `edits[${index}] old_string was not found.`);
  }

  if (!edit.replace_all && matches > 1) {
    throw new AppError(
      400,
      "native_tool_multi_edit_ambiguous",
      `edits[${index}] old_string matched multiple locations. Provide a more specific old_string or set replace_all=true.`
    );
  }

  return {
    content: edit.replace_all ? content.split(edit.old_string).join(edit.new_string) : content.replace(edit.old_string, edit.new_string),
    occurrences: edit.replace_all ? matches : 1
  };
}

export function createMultiEditTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    MultiEdit: {
      description: MULTI_EDIT_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MultiEdit"),
      inputSchema: MultiEditInputSchema,
      async execute(rawInput) {
        context.assertVisible("MultiEdit");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["path"]),
                file_path:
                  (rawInput as Record<string, unknown>).file_path ??
                  (rawInput as Record<string, unknown>).path
              }
            : rawInput;
        const input = MultiEditInputSchema.parse(normalizedInput);

        return context.withFileSystem("write", input.file_path, async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, input.file_path);
          await context.assertReadBeforeMutating(resolved.relativePath, "Edit", workspaceRoot, fileSystem);
          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (entry?.kind !== "file") {
            throw new AppError(404, "native_tool_file_not_found", `File ${input.file_path} was not found.`);
          }

          let nextContent = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
          const occurrences: number[] = [];
          for (const [index, edit] of input.edits.entries()) {
            const result = applyOneEdit(nextContent, edit, index);
            nextContent = result.content;
            occurrences.push(result.occurrences);
          }

          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
          return formatToolOutput(
            [
              ["file_path", resolved.relativePath],
              ["edits", input.edits.length],
              ["occurrences", occurrences.reduce((total, count) => total + count, 0)]
            ],
            [
              {
                title: "per_edit_occurrences",
                lines: occurrences.map((count, index) => `${index}: ${count}`)
              }
            ]
          );
        });
      }
    }
  };
}
