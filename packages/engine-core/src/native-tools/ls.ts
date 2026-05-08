import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet, WorkspaceFileSystemEntry } from "../types.js";
import { normalizePathForMatch, resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const LS_DESCRIPTION = `Lists files and directories at a workspace path.

Usage:
- Use this instead of Bash ls/find when inspecting a directory
- Returns names, entry types, sizes when available, and modification timestamps when available
- The path parameter can be workspace-relative or an absolute path inside the workspace`;

const LsInputSchema = z
  .object({
    path: z.string().min(1).optional().describe("The directory path to list. Defaults to the workspace root."),
    ignore: z.array(z.string().min(1)).optional().describe("Entry names or glob-like substrings to omit from the listing")
  })
  .strict();

function shouldIgnore(entry: WorkspaceFileSystemEntry, ignore: string[] | undefined): boolean {
  if (!ignore || ignore.length === 0) {
    return false;
  }

  return ignore.some((pattern) => entry.name === pattern || entry.name.includes(pattern));
}

function formatEntry(entry: WorkspaceFileSystemEntry): string {
  const suffix = entry.kind === "directory" ? "/" : "";
  const fields = [
    entry.kind,
    `${entry.name}${suffix}`,
    ...(typeof entry.sizeBytes === "number" ? [`${entry.sizeBytes} bytes`] : []),
    ...(entry.updatedAt ? [`updated ${entry.updatedAt}`] : [])
  ];
  return fields.join("  ");
}

export function createLsTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    LS: {
      description: LS_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("LS"),
      inputSchema: LsInputSchema,
      async execute(rawInput) {
        context.assertVisible("LS");
        const input = LsInputSchema.parse(rawInput ?? {});
        return context.withFileSystem("read", input.path ?? ".", async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, input.path ?? ".");
          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (entry?.kind !== "directory") {
            throw new AppError(404, "native_tool_directory_not_found", `Directory ${input.path ?? "."} was not found.`);
          }

          const entries = (await fileSystem.readdir(resolved.absolutePath))
            .filter((child) => !shouldIgnore(child, input.ignore))
            .sort((left, right) => {
              if (left.kind !== right.kind) {
                return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : left.kind.localeCompare(right.kind);
              }

              return left.name.localeCompare(right.name);
            });

          return formatToolOutput(
            [
              ["path", resolved.relativePath],
              ["absolute_path", resolved.absolutePath],
              ["entries", entries.length]
            ],
            [
              {
                title: "contents",
                lines: entries.map((child) => formatEntry({
                  ...child,
                  name: normalizePathForMatch(path.basename(child.name))
                })),
                emptyText: "(empty directory)"
              }
            ]
          );
        });
      }
    }
  };
}
