import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../errors.js";

export function formatReadLines(
  content: string,
  offset: number,
  limit: number
): { rendered: string[]; truncated: boolean; totalLines: number } {
  const lines = content.length === 0 ? [] : content.replaceAll("\r\n", "\n").split("\n");
  const startIndex = offset <= 0 ? 0 : offset - 1;
  if (startIndex > lines.length) {
    throw new AppError(400, "native_tool_read_offset_invalid", `Offset ${offset} is out of range.`);
  }

  const slice = lines.slice(startIndex, startIndex + limit);
  return {
    rendered: slice.map((line, index) => `${startIndex + index + 1}: ${line}`),
    truncated: startIndex + slice.length < lines.length,
    totalLines: lines.length
  };
}

export async function collectWorkspaceFiles(directory: string): Promise<Array<{ absolutePath: string; mtimeMs: number }>> {
  const pending = [directory];
  const files: Array<{ absolutePath: string; mtimeMs: number }> = [];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absoluteEntryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absoluteEntryPath);
        continue;
      }

      if (entry.isFile()) {
        const entryStat = await stat(absoluteEntryPath).catch(() => null);
        if (entryStat?.isFile()) {
          files.push({ absolutePath: absoluteEntryPath, mtimeMs: entryStat.mtimeMs });
        }
      }
    }
  }

  return files;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}
