import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateWorkerDiskReadiness,
  resolveWorkerDiskReadinessThreshold
} from "../apps/server/src/bootstrap/worker-disk-readiness.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("worker disk readiness", () => {
  it("uses the configured readiness threshold", () => {
    vi.stubEnv("OAH_WORKER_DISK_READINESS_THRESHOLD", "0.91");

    expect(resolveWorkerDiskReadinessThreshold()).toBe(0.91);
  });

  it("reports pressure when a watched filesystem exceeds the threshold", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-worker-disk-"));
    tempDirs.push(directory);

    const readiness = evaluateWorkerDiskReadiness({
      paths: [path.join(directory, "workspace-cache")],
      threshold: 0.000001
    });

    expect(readiness.status).toBe("pressure");
    expect(readiness.disks).toHaveLength(1);
    expect(readiness.disks[0]).toMatchObject({
      path: path.join(directory, "workspace-cache"),
      statPath: directory,
      status: "pressure",
      threshold: 0.000001
    });
  });

  it("keeps readiness ok below the threshold", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oah-worker-disk-"));
    tempDirs.push(directory);

    const readiness = evaluateWorkerDiskReadiness({
      paths: [directory],
      threshold: 1
    });

    expect(readiness.status).toBe("ok");
    expect(readiness.disks[0]?.status).toBe("ok");
  });
});
