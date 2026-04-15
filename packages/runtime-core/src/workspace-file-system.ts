import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";

import type { WorkspaceFileStat, WorkspaceFileSystem, WorkspaceFileSystemEntry } from "./types.js";

function toWorkspaceFileStat(entry: Awaited<ReturnType<typeof stat>>): WorkspaceFileStat {
  return {
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    size: Number(entry.size),
    mtimeMs: Number(entry.mtimeMs),
    birthtimeMs: Number(entry.birthtimeMs),
    ino: entry.ino
  };
}

export function createLocalWorkspaceFileSystem(): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      return realpath(targetPath);
    },
    async stat(targetPath) {
      return toWorkspaceFileStat(await stat(targetPath));
    },
    async readFile(targetPath) {
      return readFile(targetPath);
    },
    openReadStream(targetPath) {
      return createReadStream(targetPath);
    },
    async readdir(targetPath) {
      const entries = await readdir(targetPath, { withFileTypes: true });
      return entries.map<WorkspaceFileSystemEntry>((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
      }));
    },
    async mkdir(targetPath, options) {
      await mkdir(targetPath, options);
    },
    async writeFile(targetPath, data) {
      await writeFile(targetPath, data);
    },
    async rm(targetPath, options) {
      await rm(targetPath, options);
    },
    async rename(sourcePath, targetPath) {
      await rename(sourcePath, targetPath);
    }
  };
}
