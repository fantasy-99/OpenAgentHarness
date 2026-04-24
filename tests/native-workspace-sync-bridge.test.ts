import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

class FakeWritable extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writable = true;

  constructor(private readonly onWrite: (chunk: string) => void, private readonly onEnd?: () => void) {
    super();
  }

  write(chunk: string | Buffer, callback?: (error?: Error | null) => void): boolean {
    this.onWrite(chunk.toString());
    callback?.(null);
    return true;
  }

  end(): void {
    this.writableEnded = true;
    this.onEnd?.();
  }
}

function createWorkerChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: FakeWritable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new FakeWritable((chunk) => {
    for (const line of chunk.split("\n").filter((value) => value.trim().length > 0)) {
      const request = JSON.parse(line) as { requestId: string; command: string };
      const response =
        request.command === "plan-seed-upload"
          ? {
              ok: true,
              protocolVersion: 1,
              requestId: request.requestId,
              fingerprint: "seed-fingerprint",
              directories: [],
              files: []
            }
          : request.command === "fingerprint-batch"
            ? {
                ok: true,
                protocolVersion: 1,
                requestId: request.requestId,
                results: []
              }
          : {
              ok: true,
              protocolVersion: 1,
              requestId: request.requestId,
              localFingerprint: "sandbox-fingerprint",
              createdDirectoryCount: 1,
              uploadedFileCount: 0
            };
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify(response)}\n`);
      });
    }
  });
  child.kill = vi.fn();
  return child;
}

function createOneShotChild(command: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: FakeWritable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let payload = "";
  child.stdin = new FakeWritable(
    (chunk) => {
      payload += chunk;
    },
    () => {
      const response =
        command === "fingerprint-batch"
          ? {
              ok: true,
              protocolVersion: 1,
              results: []
            }
          : {
              ok: true,
              protocolVersion: 1
            };
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify(response));
        child.emit("close", 0);
      });
      void payload;
    }
  );
  child.kill = vi.fn();
  return child;
}

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

describe("native workspace sync bridge", () => {
  it("prefers local build outputs over native/bin when resolving the binary", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-native-workspace-sync-resolve-"));
    tempDirs.push(tempDir);
    const binaryBasename = process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync";
    const localReleaseBinary = path.join(tempDir, ".native-target", "release", binaryBasename);
    const nativeReleaseBinary = path.join(tempDir, "native", "target", "release", binaryBasename);
    const nativeBinBinary = path.join(tempDir, "native", "bin", binaryBasename);

    await mkdir(path.dirname(localReleaseBinary), { recursive: true });
    await mkdir(path.dirname(nativeReleaseBinary), { recursive: true });
    await mkdir(path.dirname(nativeBinBinary), { recursive: true });
    await writeFile(localReleaseBinary, "local-release", "utf8");
    await writeFile(nativeReleaseBinary, "native-release", "utf8");
    await writeFile(nativeBinBinary, "native-bin", "utf8");

    process.chdir(tempDir);

    const { resolveWorkspaceSyncBinary } = await import("../packages/native-bridge/src/resolve-binary.ts");
    expect(await realpath(resolveWorkspaceSyncBinary() ?? "")).toBe(await realpath(localReleaseBinary));
  });

  it("routes plan-seed-upload and sandbox-http sync through the persistent worker when enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-native-workspace-sync-bridge-"));
    tempDirs.push(tempDir);
    const fakeBinary = path.join(tempDir, "oah-workspace-sync");
    await writeFile(fakeBinary, "fake", "utf8");

    const spawnCalls: string[][] = [];
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC_BINARY", fakeBinary);
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT", "1");
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((_binary: string, args: string[]) => {
        spawnCalls.push(args);
        return args[0] === "serve" ? createWorkerChild() : createOneShotChild(args[0] ?? "");
      })
    }));

    const workspaceSync = await import("../packages/native-bridge/src/workspace-sync.ts");

    await workspaceSync.planNativeSeedUpload({
      rootDir: "/tmp/workspace",
      remoteBasePath: "/workspace"
    });
    await workspaceSync.syncNativeLocalToSandboxHttp({
      rootDir: "/tmp/workspace",
      remoteRootPath: "/workspace",
      sandbox: {
        baseUrl: "http://127.0.0.1:8787/internal/v1",
        sandboxId: "sb_1"
      }
    });

    expect(spawnCalls.filter((args) => args[0] === "serve")).toHaveLength(1);
    expect(spawnCalls.some((args) => args[0] === "plan-seed-upload")).toBe(false);
    expect(spawnCalls.some((args) => args[0] === "sync-local-to-sandbox-http")).toBe(false);
  });

  it("routes fingerprint-batch through the persistent worker when enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-native-workspace-sync-batch-"));
    tempDirs.push(tempDir);
    const fakeBinary = path.join(tempDir, "oah-workspace-sync");
    await writeFile(fakeBinary, "fake", "utf8");

    const spawnCalls: string[][] = [];
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC_BINARY", fakeBinary);
    vi.stubEnv("OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT", "1");
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((_binary: string, args: string[]) => {
        spawnCalls.push(args);
        return args[0] === "serve" ? createWorkerChild() : createOneShotChild(args[0] ?? "");
      })
    }));

    const workspaceSync = await import("../packages/native-bridge/src/workspace-sync.ts");

    await workspaceSync.computeNativeDirectoryFingerprintBatch({
      directories: [{ rootDir: "/tmp/workspace" }]
    });

    expect(spawnCalls.filter((args) => args[0] === "serve")).toHaveLength(1);
    expect(spawnCalls.filter((args) => args[0] === "fingerprint-batch")).toHaveLength(0);
  });
});
