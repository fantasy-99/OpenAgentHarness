import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncRemotePrefixToLocal, type DirectoryObjectStore } from "../apps/server/src/object-storage.ts";

class EmptyDirectoryStore implements DirectoryObjectStore {
  async listEntries(): Promise<[]> {
    return [];
  }

  async getObject(): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    throw new Error("getObject should not be called for an empty remote prefix");
  }

  async putObject(): Promise<void> {
    throw new Error("putObject should not be called during remote-to-local sync");
  }

  async deleteObjects(): Promise<void> {
    throw new Error("deleteObjects should not be called during remote-to-local sync");
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
});

describe("syncRemotePrefixToLocal", () => {
  it("preserves entire top-level directories when preserveTopLevelNames is set", async () => {
    const previousNativeFlag = process.env.OAH_NATIVE_WORKSPACE_SYNC;
    delete process.env.OAH_NATIVE_WORKSPACE_SYNC;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oah-object-storage-"));
    createdDirectories.push(rootDir);

    await mkdir(path.join(rootDir, "keep", "nested"), { recursive: true });
    await mkdir(path.join(rootDir, "remove", "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "keep", "nested", "child.txt"), "keep me");
    await writeFile(path.join(rootDir, "remove", "nested", "child.txt"), "remove me");
    await writeFile(path.join(rootDir, "orphan.txt"), "remove me too");

    try {
      await syncRemotePrefixToLocal(new EmptyDirectoryStore(), "workspace", rootDir, undefined, undefined, {
        preserveTopLevelNames: ["keep"]
      });
    } finally {
      if (previousNativeFlag === undefined) {
        delete process.env.OAH_NATIVE_WORKSPACE_SYNC;
      } else {
        process.env.OAH_NATIVE_WORKSPACE_SYNC = previousNativeFlag;
      }
    }

    expect(await pathExists(path.join(rootDir, "keep"))).toBe(true);
    expect(await pathExists(path.join(rootDir, "keep", "nested", "child.txt"))).toBe(true);
    expect(await pathExists(path.join(rootDir, "remove"))).toBe(false);
    expect(await pathExists(path.join(rootDir, "orphan.txt"))).toBe(false);
  });
});
