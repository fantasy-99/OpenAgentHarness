import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDirectoryObjectStore,
  deleteRemotePrefixFromObjectStore,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal
} from "../apps/server/src/object-storage.ts";

interface BenchmarkOptions {
  files: number;
  sizeBytes: number;
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

const noisySdkBodyLogPattern = /^\{ sendHeader: false, bodyLength: \d+, threshold: \d+ \}\s*$/;

function installStdoutNoiseFilter(): void {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const filterChunk = (chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return noisySdkBodyLogPattern.test(text);
  };

  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (filterChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else {
        callback?.();
      }
      return true;
    }

    if (typeof encoding === "function") {
      return originalStdoutWrite(chunk, encoding);
    }

    return originalStdoutWrite(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (filterChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else {
        callback?.();
      }
      return true;
    }

    if (typeof encoding === "function") {
      return originalStderrWrite(chunk, encoding);
    }

    return originalStderrWrite(chunk, encoding, callback);
  }) as typeof process.stderr.write;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    files: Number.parseInt(process.env.OAH_BENCH_SYNC_FILES || "64", 10) || 64,
    sizeBytes: Number.parseInt(process.env.OAH_BENCH_SYNC_SIZE_BYTES || "65536", 10) || 65536,
    bucket: process.env.OAH_BENCH_SYNC_BUCKET || "test-oah-server",
    endpoint: process.env.OAH_BENCH_SYNC_ENDPOINT || "http://127.0.0.1:9000",
    region: process.env.OAH_BENCH_SYNC_REGION || "us-east-1",
    accessKey: process.env.OAH_BENCH_SYNC_ACCESS_KEY || "oahadmin",
    secretKey: process.env.OAH_BENCH_SYNC_SECRET_KEY || "oahadmin123",
    forcePathStyle: process.env.OAH_BENCH_SYNC_FORCE_PATH_STYLE !== "0"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || value === undefined) {
      continue;
    }

    switch (arg) {
      case "--files":
        options.files = Math.max(1, Number.parseInt(value, 10) || options.files);
        index += 1;
        break;
      case "--size-bytes":
        options.sizeBytes = Math.max(1, Number.parseInt(value, 10) || options.sizeBytes);
        index += 1;
        break;
      case "--bucket":
        options.bucket = value;
        index += 1;
        break;
      case "--endpoint":
        options.endpoint = value;
        index += 1;
        break;
      case "--region":
        options.region = value;
        index += 1;
        break;
      case "--access-key":
        options.accessKey = value;
        index += 1;
        break;
      case "--secret-key":
        options.secretKey = value;
        index += 1;
        break;
      case "--force-path-style":
        options.forcePathStyle = value !== "0" && value !== "false";
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

async function createFixture(rootDir: string, files: number, sizeBytes: number): Promise<void> {
  const payload = Buffer.alloc(sizeBytes, "a");
  for (let index = 0; index < files; index += 1) {
    const relativeDirectory = path.join(
      `batch-${String(index % 8).padStart(2, "0")}`,
      `group-${String(index % 4).padStart(2, "0")}`
    );
    const absoluteDirectory = path.join(rootDir, relativeDirectory);
    const absoluteFile = path.join(absoluteDirectory, `file-${String(index).padStart(4, "0")}.txt`);
    await mkdir(absoluteDirectory, { recursive: true });
    await writeFile(absoluteFile, payload);
    const mtime = new Date(Date.now() - index * 1000);
    await utimes(absoluteFile, mtime, mtime);
  }
}

async function countLocalFiles(rootDir: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  };
  await walk(rootDir);
  return count;
}

async function runCase(options: {
  label: string;
  nativeEnabled: boolean;
  remotePrefix: string;
  benchmark: BenchmarkOptions;
}): Promise<{
  pushMs: number;
  pullMs: number;
  uploadedFileCount: number;
  pulledFileCount: number;
}> {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-source-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-target-"));
  const store = createDirectoryObjectStore({
    provider: "s3",
    bucket: options.benchmark.bucket,
    region: options.benchmark.region,
    endpoint: options.benchmark.endpoint,
    force_path_style: options.benchmark.forcePathStyle,
    access_key: options.benchmark.accessKey,
    secret_key: options.benchmark.secretKey
  });

  process.env.OAH_NATIVE_WORKSPACE_SYNC = options.nativeEnabled ? "1" : "0";

  try {
    await createFixture(sourceDir, options.benchmark.files, options.benchmark.sizeBytes);

    const pushStart = performance.now();
    const pushResult = await syncLocalDirectoryToRemote(store, options.remotePrefix, sourceDir);
    const pushMs = performance.now() - pushStart;

    const pullStart = performance.now();
    await syncRemotePrefixToLocal(store, options.remotePrefix, targetDir);
    const pullMs = performance.now() - pullStart;

    return {
      pushMs,
      pullMs,
      uploadedFileCount: pushResult.uploadedFileCount,
      pulledFileCount: await countLocalFiles(targetDir)
    };
  } finally {
    await deleteRemotePrefixFromObjectStore(store, options.remotePrefix).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await (store as { close?: (() => Promise<void>) | undefined }).close?.();
  }
}

async function main(): Promise<void> {
  installStdoutNoiseFilter();
  const options = parseArgs(process.argv.slice(2));
  const runId = Date.now().toString(36);
  const sharedPrefix = `benchmarks/object-storage-sync/${runId}`;

  console.log(
    `Benchmarking object-storage sync against ${options.endpoint} bucket=${options.bucket} prefix=${sharedPrefix} files=${options.files} sizeBytes=${options.sizeBytes}`
  );
  console.log(
    "This script expects the target bucket to already exist. In the local stack, `pnpm storage:sync` prepares the default `test-oah-server` bucket."
  );

  const typescriptCase = await runCase({
    label: "typescript",
    nativeEnabled: false,
    remotePrefix: `${sharedPrefix}/typescript`,
    benchmark: options
  });
  const nativeCase = await runCase({
    label: "native",
    nativeEnabled: true,
    remotePrefix: `${sharedPrefix}/native`,
    benchmark: options
  });

  console.table([
    {
      mode: "typescript",
      pushMs: Math.round(typescriptCase.pushMs),
      pullMs: Math.round(typescriptCase.pullMs),
      uploadedFiles: typescriptCase.uploadedFileCount,
      pulledFiles: typescriptCase.pulledFileCount
    },
    {
      mode: "native",
      pushMs: Math.round(nativeCase.pushMs),
      pullMs: Math.round(nativeCase.pullMs),
      uploadedFiles: nativeCase.uploadedFileCount,
      pulledFiles: nativeCase.pulledFileCount
    }
  ]);

  console.log(
    `Native delta: push ${Math.round(typescriptCase.pushMs - nativeCase.pushMs)}ms, pull ${Math.round(
      typescriptCase.pullMs - nativeCase.pullMs
    )}ms`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
