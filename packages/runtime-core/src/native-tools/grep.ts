import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import type { RuntimeToolSet } from "../types.js";
import { collectWorkspaceFiles } from "./fs-utils.js";
import { normalizePathForMatch, resolveWorkspacePath } from "./paths.js";
import { runRipgrep } from "./process-utils.js";
import { applyHeadLimit, formatGrepOutput, globToRegExp } from "./search-utils.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const GREP_DESCRIPTION = `A powerful search tool built on ripgrep

Usage:
- Supports full regex syntax
- Filter files with glob or type
- Output modes: "content", "files_with_matches", or "count"
- Use multiline: true when patterns need to span lines`;

const GrepInputSchema = z
  .object({
    pattern: z.string().min(1).describe("The regular expression pattern to search for in file contents"),
    path: z.string().min(1).optional().describe("File or directory to search in"),
    glob: z.string().min(1).optional().describe("Glob pattern to filter files"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    "-B": z.number().nonnegative().optional().describe("Number of lines to show before each match"),
    "-A": z.number().nonnegative().optional().describe("Number of lines to show after each match"),
    "-C": z.number().nonnegative().optional().describe("Alias for context"),
    context: z.number().nonnegative().optional().describe("Number of lines to show before and after each match"),
    "-n": z.boolean().optional().describe("Show line numbers in output"),
    "-i": z.boolean().optional().describe("Case insensitive search"),
    type: z.string().min(1).optional().describe("File type to search"),
    head_limit: z.number().nonnegative().optional().describe("Limit output to first N lines or entries"),
    offset: z.number().nonnegative().optional().describe("Skip the first N lines or entries before head_limit"),
    multiline: z.boolean().optional().describe("Enable multiline mode")
  })
  .strict();

export function createGrepTool(context: NativeToolFactoryContext): RuntimeToolSet {
  return {
    Grep: {
      description: GREP_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("Grep"),
      inputSchema: GrepInputSchema,
      async execute(rawInput, executionContext) {
        context.assertVisible("Grep");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...context.omitLegacyKeys(rawInput as Record<string, unknown>, ["include"]),
                glob: (rawInput as Record<string, unknown>).glob ?? (rawInput as Record<string, unknown>).include
              }
            : rawInput;
        const input = GrepInputSchema.parse(normalizedInput);
        const outputMode = input.output_mode ?? "files_with_matches";
        const root = resolveWorkspacePath(context.workspaceRoot, input.path ?? ".");
        const entry = await stat(root.absolutePath).catch(() => null);
        if (!entry) {
          throw new AppError(404, "native_tool_path_not_found", `Path ${input.path ?? "."} was not found.`);
        }

        const rgArgs = ["--color", "never"];
        if (input["-i"]) {
          rgArgs.push("-i");
        }
        if (input.type) {
          rgArgs.push("--type", input.type);
        }
        if (input.glob) {
          rgArgs.push("--glob", input.glob);
        }
        if (input.multiline) {
          rgArgs.push("-U", "--multiline-dotall");
        }

        if (outputMode === "content") {
          rgArgs.push("--no-heading");
          if (input["-n"] !== false) {
            rgArgs.push("-n");
          }
          const contextLines = input.context ?? input["-C"];
          if (typeof contextLines === "number") {
            rgArgs.push("-C", String(contextLines));
          } else {
            if (typeof input["-B"] === "number") {
              rgArgs.push("-B", String(input["-B"]));
            }
            if (typeof input["-A"] === "number") {
              rgArgs.push("-A", String(input["-A"]));
            }
          }
        } else if (outputMode === "files_with_matches") {
          rgArgs.push("--files-with-matches");
        } else {
          rgArgs.push("--count");
        }

        rgArgs.push(input.pattern, root.absolutePath);

        try {
          const rgResult = await runRipgrep(context.workspaceRoot, rgArgs, executionContext.abortSignal);
          if (rgResult.exitCode !== 0 && rgResult.exitCode !== 1) {
            throw new AppError(400, "native_tool_grep_failed", rgResult.stderr.trim() || "ripgrep failed.");
          }

          const allLines = rgResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);
          const { items, appliedLimit, appliedOffset } = applyHeadLimit(allLines, input.head_limit, input.offset ?? 0);
          const renderedItems = items.map((line) => {
            const absoluteRootPrefix = `${root.absolutePath}${path.sep}`;
            if (line.startsWith(absoluteRootPrefix)) {
              const rest = line.slice(absoluteRootPrefix.length);
              const prefix = input.path ? normalizePathForMatch(path.join(input.path, rest)) : normalizePathForMatch(rest);
              const firstColon = rest.indexOf(":");
              if (outputMode === "files_with_matches") {
                return prefix;
              }
              if (firstColon >= 0) {
                return `${prefix}${rest.slice(firstColon)}`;
              }
            }

            if (line.startsWith(context.workspaceRoot + path.sep)) {
              return normalizePathForMatch(path.relative(context.workspaceRoot, line));
            }

            return line;
          });
          const filenames = new Set<string>();

          for (const line of renderedItems) {
            if (outputMode === "files_with_matches") {
              filenames.add(line);
              continue;
            }

            const firstIndex = line.indexOf(":");
            if (firstIndex > 0) {
              const candidate = line.slice(0, firstIndex);
              const absoluteCandidate = path.isAbsolute(candidate) ? candidate : path.resolve(context.workspaceRoot, candidate);
              filenames.add(normalizePathForMatch(path.relative(context.workspaceRoot, absoluteCandidate)));
            }
          }

          return formatGrepOutput({
            pattern: input.pattern,
            root: root.relativePath,
            mode: outputMode,
            numFiles: filenames.size,
            appliedLimit,
            appliedOffset,
            items: renderedItems
          });
        } catch (error) {
          if (!(error instanceof Error) || !/ENOENT/.test(error.message)) {
            throw error;
          }

          let matcher: RegExp;
          try {
            matcher = new RegExp(input.pattern, input["-i"] ? "i" : undefined);
          } catch (regexError) {
            throw new AppError(400, "native_tool_grep_invalid_pattern", `Invalid regular expression: ${String(regexError)}`);
          }

          const includeMatcher = input.glob ? globToRegExp(input.glob) : undefined;
          const searchFiles = entry.isDirectory()
            ? await collectWorkspaceFiles(root.absolutePath)
            : [{ absolutePath: root.absolutePath, mtimeMs: 0 }];
          const rows: string[] = [];

          for (const file of searchFiles) {
            const relativeToRoot = normalizePathForMatch(path.relative(root.absolutePath, file.absolutePath));
            if (includeMatcher && !includeMatcher.test(relativeToRoot)) {
              continue;
            }

            const content = await readFile(file.absolutePath, "utf8").catch(() => null);
            if (content === null) {
              continue;
            }

            const normalizedPath = normalizePathForMatch(path.relative(context.workspaceRoot, file.absolutePath));
            const lines = content.replaceAll("\r\n", "\n").split("\n");
            let count = 0;
            let matched = false;
            for (let index = 0; index < lines.length; index += 1) {
              if (!matcher.test(lines[index] ?? "")) {
                matcher.lastIndex = 0;
                continue;
              }
              matcher.lastIndex = 0;
              matched = true;
              count += 1;
              if (outputMode === "content") {
                rows.push(`${normalizedPath}:${index + 1}:${lines[index] ?? ""}`);
              }
            }

            if (outputMode === "files_with_matches" && matched) {
              rows.push(normalizedPath);
            }
            if (outputMode === "count" && matched) {
              rows.push(`${normalizedPath}:${count}`);
            }
          }

          const { items, appliedLimit, appliedOffset } = applyHeadLimit(rows, input.head_limit, input.offset ?? 0);
          const filenames = new Set(
            items.map((line) => normalizePathForMatch(line.split(":")[0] ?? line)).filter((value) => value.length > 0)
          );

          return formatGrepOutput({
            pattern: input.pattern,
            root: root.relativePath,
            mode: outputMode,
            numFiles: filenames.size,
            appliedLimit,
            appliedOffset,
            items
          });
        }
      }
    }
  };
}
