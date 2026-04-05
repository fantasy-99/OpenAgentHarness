import { AppError } from "../errors.js";
import { formatToolOutput } from "../tool-output.js";
import { DEFAULT_GREP_LIMIT } from "./constants.js";
import { normalizePathForMatch } from "./paths.js";

function globSegmentToRegExp(segment: string): string {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const current = segment[index]!;
    if (current === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (current === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += current.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return pattern;
}

export function globToRegExp(globPattern: string): RegExp {
  const normalized = normalizePathForMatch(globPattern.trim());
  if (normalized.length === 0) {
    throw new AppError(400, "native_tool_glob_invalid", "Glob pattern must not be empty.");
  }

  const segments = normalized.split("/");
  let expression = "^";

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;

    if (segment === "**") {
      expression += last ? ".*" : "(?:.*/)?";
      continue;
    }

    expression += globSegmentToRegExp(segment);
    if (!last) {
      expression += "/";
    }
  }

  expression += "$";
  return new RegExp(expression);
}

export function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number
): { items: T[]; appliedLimit: number | undefined; appliedOffset: number | undefined } {
  const effectiveOffset = Math.max(0, offset);
  if (limit === 0) {
    return {
      items: items.slice(effectiveOffset),
      appliedLimit: undefined,
      appliedOffset: effectiveOffset > 0 ? effectiveOffset : undefined
    };
  }

  const effectiveLimit = limit ?? DEFAULT_GREP_LIMIT;
  const sliced = items.slice(effectiveOffset, effectiveOffset + effectiveLimit);
  const truncated = items.length - effectiveOffset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: effectiveOffset > 0 ? effectiveOffset : undefined
  };
}

export function formatGrepOutput(input: {
  pattern: string;
  root: string;
  mode: string;
  numFiles: number;
  appliedLimit?: number | undefined;
  appliedOffset?: number | undefined;
  items: string[];
}): string {
  return formatToolOutput(
    [
      ["pattern", input.pattern],
      ["root", input.root],
      ["mode", input.mode],
      ["num_files", input.numFiles],
      ["applied_limit", input.appliedLimit],
      ["applied_offset", input.appliedOffset]
    ],
    [
      {
        title: "results",
        lines: input.items,
        emptyText: "(no matches)"
      }
    ]
  );
}
