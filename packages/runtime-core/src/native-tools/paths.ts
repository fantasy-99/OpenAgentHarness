import path from "node:path";

import { AppError } from "../errors.js";

export function normalizePathForMatch(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveWorkspacePath(workspaceRoot: string, targetPath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(workspaceRoot, targetPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AppError(403, "native_tool_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
  }

  return {
    absolutePath,
    relativePath: relativePath.length > 0 ? relativePath.split(path.sep).join("/") : "."
  };
}
