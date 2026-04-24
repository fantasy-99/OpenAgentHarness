import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  createDirectoryObjectStore,
  deleteRemotePrefixFromObjectStore,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal
} from "../apps/server/src/object-storage.ts";
import { resolveWorkspaceSyncBinary } from "../packages/native-bridge/src/index.ts";

const minioEnabled = process.env.OAH_TEST_MINIO_E2E === "1";
const endpoint = process.env.OAH_TEST_MINIO_ENDPOINT || "http://127.0.0.1:9000";
const bucket = process.env.OAH_TEST_MINIO_BUCKET || "test-oah-server";
const region = process.env.OAH_TEST_MINIO_REGION || "us-east-1";
const accessKey = process.env.OAH_TEST_MINIO_ACCESS_KEY || "oahadmin";
const secretKey = process.env.OAH_TEST_MINIO_SECRET_KEY || "oahadmin123";
const forcePathStyle = process.env.OAH_TEST_MINIO_FORCE_PATH_STYLE !== "0";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

afterAll(() => undefined);

describe.skipIf(!minioEnabled)("object storage MinIO e2e", () => {
  it("round-trips workspace content through MinIO with native sync enabled", async () => {
    process.env.OAH_NATIVE_WORKSPACE_SYNC = "1";
    process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY =
      process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY || resolveWorkspaceSyncBinary() || path.resolve(process.cwd(), "native/bin/oah-workspace-sync");
    process.env.OAH_OBJECT_STORAGE_SYNC_CONCURRENCY = "4";

    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oah-minio-sync-source-"));
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "oah-minio-sync-target-"));
    tempDirs.push(sourceDir, targetDir);

    await mkdir(path.join(sourceDir, ".openharness"), { recursive: true });
    await mkdir(path.join(sourceDir, "docs"), { recursive: true });
    await mkdir(path.join(sourceDir, "empty-dir"), { recursive: true });
    await writeFile(path.join(sourceDir, ".openharness", "settings.yaml"), "default_agent: builder\n", "utf8");
    await writeFile(path.join(sourceDir, "README.md"), "# minio e2e\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "guide.md"), "hello from minio\n", "utf8");
    const expectedMtime = new Date("2026-04-24T03:04:05.000Z");
    await utimes(path.join(sourceDir, "README.md"), expectedMtime, expectedMtime);

    const prefix = `tests/object-storage-minio/${Date.now().toString(36)}`;
    const store = createDirectoryObjectStore({
      provider: "s3",
      bucket,
      region,
      endpoint,
      force_path_style: forcePathStyle,
      access_key: accessKey,
      secret_key: secretKey
    });

    try {
      const pushResult = await syncLocalDirectoryToRemote(store, prefix, sourceDir);
      expect(pushResult.uploadedFileCount).toBe(3);

      await syncRemotePrefixToLocal(store, prefix, targetDir);

      await expect(readFile(path.join(targetDir, "README.md"), "utf8")).resolves.toBe("# minio e2e\n");
      await expect(readFile(path.join(targetDir, "docs", "guide.md"), "utf8")).resolves.toBe("hello from minio\n");
      await expect(readFile(path.join(targetDir, ".openharness", "settings.yaml"), "utf8")).resolves.toBe(
        "default_agent: builder\n"
      );
      expect((await stat(path.join(targetDir, "empty-dir"))).isDirectory()).toBe(true);
      expect(Math.trunc((await stat(path.join(targetDir, "README.md"))).mtimeMs)).toBe(expectedMtime.getTime());
    } finally {
      await deleteRemotePrefixFromObjectStore(store, prefix).catch(() => undefined);
      await (store as { close?: (() => Promise<void>) | undefined }).close?.();
    }
  });
});
