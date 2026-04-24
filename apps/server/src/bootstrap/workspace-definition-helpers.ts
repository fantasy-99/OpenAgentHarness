import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";

import type {
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "@oah/engine-core";

interface DefinitionFsAccess {
  stat(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | null>;
  readdir(targetPath: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  readFile(targetPath: string): Promise<Buffer>;
}

async function withWorkspaceDefinitionAccess<T>(input: {
  workspace: WorkspaceRecord;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
  operation: (input: { rootPath: string; fs: DefinitionFsAccess }) => Promise<T>;
}): Promise<T> {
  if (!input.workspaceFileAccessProvider || !input.workspaceFileSystem) {
    return input.operation({
      rootPath: input.workspace.rootPath,
      fs: {
        async stat(targetPath) {
          return stat(targetPath).catch(() => null);
        },
        async readdir(targetPath) {
          return readdir(targetPath, { withFileTypes: true }).catch(() => []);
        },
        async readFile(targetPath) {
          return readFile(targetPath);
        }
      }
    });
  }

  const lease = await input.workspaceFileAccessProvider.acquire({
    workspace: input.workspace,
    access: "read"
  });

  try {
    return await input.operation({
      rootPath: lease.workspace.rootPath,
      fs: {
        async stat(targetPath) {
          try {
            const entry = await input.workspaceFileSystem!.stat(targetPath);
            return {
              isDirectory: () => entry.kind === "directory",
              isFile: () => entry.kind === "file",
              mtimeMs: entry.mtimeMs
            } as Awaited<ReturnType<typeof stat>>;
          } catch {
            return null;
          }
        },
        async readdir(targetPath) {
          const entries = await input.workspaceFileSystem!.readdir(targetPath).catch(() => []);
          return entries.map((entry) => ({
            name: entry.name,
            isDirectory: () => entry.kind === "directory",
            isFile: () => entry.kind === "file"
          }));
        },
        async readFile(targetPath) {
          return input.workspaceFileSystem!.readFile(targetPath);
        }
      }
    });
  } finally {
    await lease.release({ dirty: false });
  }
}

export async function readLiveWorkspaceSkillNames(input: {
  workspace: WorkspaceRecord;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
}): Promise<string[]> {
  return withWorkspaceDefinitionAccess({
    ...input,
    operation: async ({ rootPath, fs }) => {
      const skillsRoot = path.join(rootPath, ".openharness", "skills");
      const entries = await fs.readdir(skillsRoot);
      const names: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillFilePath = path.join(skillsRoot, entry.name, "SKILL.md");
        const skillFile = await fs.stat(skillFilePath);
        if (skillFile?.isFile()) {
          const rawContent = (await fs.readFile(skillFilePath)).toString("utf8");
          const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(rawContent);
          const frontmatterBody = frontmatterMatch?.[1] ?? "";
          const nameMatch = /^name:\s*(.+)$/mu.exec(frontmatterBody);
          names.push(nameMatch?.[1]?.trim() || entry.name);
        }
      }

      return names.sort((left, right) => left.localeCompare(right));
    }
  });
}

export async function copyWorkspaceDefinitionSnapshot(input: {
  workspace: WorkspaceRecord;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  workspaceFileSystem?: WorkspaceFileSystem | undefined;
}): Promise<string> {
  return withWorkspaceDefinitionAccess({
    ...input,
    operation: async ({ rootPath, fs }) => {
      const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "oah-workspace-definition-"));
      const candidates = [
        "AGENTS.md",
        path.join(".openharness", "settings.yaml"),
        path.join(".openharness", "agents"),
        path.join(".openharness", "actions"),
        path.join(".openharness", "skills"),
        path.join(".openharness", "tools"),
        path.join(".openharness", "hooks"),
        path.join(".openharness", "models")
      ];

      async function copyRelativePath(relativePath: string): Promise<void> {
        const sourcePath = path.join(rootPath, relativePath);
        const targetPath = path.join(snapshotRoot, relativePath);
        const entry = await fs.stat(sourcePath);
        if (!entry) {
          return;
        }

        if (entry.isDirectory()) {
          await mkdir(targetPath, { recursive: true });
          const children = await fs.readdir(sourcePath);
          for (const child of children) {
            await copyRelativePath(path.join(relativePath, child.name));
          }
          return;
        }

        if (entry.isFile()) {
          await mkdir(path.dirname(targetPath), { recursive: true });
          await writeFile(targetPath, await fs.readFile(sourcePath));
        }
      }

      for (const candidate of candidates) {
        await copyRelativePath(candidate);
      }

      return snapshotRoot;
    }
  });
}

async function readLatestPathMtimeMs(targetPath: string): Promise<number | undefined> {
  const entry = await stat(targetPath).catch(() => null);
  if (!entry) {
    return undefined;
  }

  let latest = Number(entry.mtimeMs);
  if (!entry.isDirectory()) {
    return latest;
  }

  const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const child of entries) {
    const childLatest = await readLatestPathMtimeMs(path.join(targetPath, child.name));
    if (typeof childLatest === "number" && Number.isFinite(childLatest) && childLatest > latest) {
      latest = childLatest;
    }
  }

  return latest;
}

export async function readLatestWorkspaceDefinitionMtimeMs(rootPath: string): Promise<number | undefined> {
  const candidates = [
    path.join(rootPath, "AGENTS.md"),
    path.join(rootPath, ".openharness", "settings.yaml"),
    path.join(rootPath, ".openharness", "agents"),
    path.join(rootPath, ".openharness", "actions"),
    path.join(rootPath, ".openharness", "skills"),
    path.join(rootPath, ".openharness", "tools"),
    path.join(rootPath, ".openharness", "hooks"),
    path.join(rootPath, ".openharness", "models")
  ];
  let latest: number | undefined;

  for (const candidate of candidates) {
    const candidateLatest = await readLatestPathMtimeMs(candidate);
    if (typeof candidateLatest === "number" && Number.isFinite(candidateLatest) && (latest === undefined || candidateLatest > latest)) {
      latest = candidateLatest;
    }
  }

  return latest;
}
