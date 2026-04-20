import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet } from "../types.js";
import { DEFAULT_GLOB_LIMIT } from "./constants.js";
import { collectWorkspaceFiles } from "./fs-utils.js";
import { normalizePathForMatch, resolveWorkspacePath } from "./paths.js";
import { globToRegExp } from "./search-utils.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns`;

const GlobInputSchema = z
  .object({
    pattern: z.string().min(1).describe("The glob pattern to match files against"),
    path: z.string().min(1).optional().describe("The directory to search in")
  })
  .strict();

export function createGlobTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    Glob: {
      description: GLOB_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Glob"),
      inputSchema: GlobInputSchema,
      async execute(rawInput) {
        context.assertVisible("Glob");
        const input = GlobInputSchema.parse(rawInput);
        const startedAt = Date.now();
        const resolved = await resolveWorkspacePath(context.fileSystem, context.workspaceRoot, input.path ?? ".");
        const entry = await context.fileSystem.stat(resolved.absolutePath).catch(() => null);
        if (entry?.kind !== "directory") {
          throw new AppError(404, "native_tool_directory_not_found", `Directory ${input.path ?? "."} was not found.`);
        }

        const matcher = globToRegExp(input.pattern);
        const files = await collectWorkspaceFiles(context.fileSystem, resolved.absolutePath);
        const matches = files
          .map((file) => ({
            relativePath: normalizePathForMatch(path.relative(resolved.absolutePath, file.absolutePath)),
            mtimeMs: file.mtimeMs
          }))
          .filter((file) => matcher.test(file.relativePath))
          .sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
        const truncated = matches.length > DEFAULT_GLOB_LIMIT;
        const filenames = matches
          .slice(0, DEFAULT_GLOB_LIMIT)
          .map((file) => (input.path ? normalizePathForMatch(path.join(input.path, file.relativePath)) : file.relativePath));

        return formatToolOutput(
          [
            ["pattern", input.pattern],
            ["root", resolved.relativePath],
            ["duration_ms", Date.now() - startedAt],
            ["matches", filenames.length],
            ["truncated", truncated]
          ],
          [
            {
              title: "files",
              lines: filenames,
              emptyText: "(no matches)"
            }
          ]
        );
      }
    }
  };
}
