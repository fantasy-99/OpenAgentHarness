import path from "node:path";
import { existsSync, statfsSync, statSync } from "node:fs";

export interface WorkerDiskWatermark {
  path: string;
  statPath: string;
  status: "ok" | "pressure" | "unavailable";
  threshold: number;
  usedRatio?: number | undefined;
  usedBytes?: number | undefined;
  totalBytes?: number | undefined;
  error?: string | undefined;
}

export interface WorkerDiskReadiness {
  status: "ok" | "pressure";
  disks: WorkerDiskWatermark[];
}

function readRatioEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}

export function resolveWorkerDiskReadinessThreshold(): number {
  return readRatioEnv("OAH_WORKER_DISK_READINESS_THRESHOLD", 0.95);
}

function firstExistingAncestor(targetPath: string): string | undefined {
  let current = path.resolve(targetPath);
  while (current !== path.dirname(current)) {
    if (existsSync(current)) {
      return current;
    }
    current = path.dirname(current);
  }

  return existsSync(current) ? current : undefined;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}

export function evaluateWorkerDiskReadiness(input: {
  paths: string[];
  threshold?: number | undefined;
}): WorkerDiskReadiness {
  const threshold = input.threshold ?? resolveWorkerDiskReadinessThreshold();
  const disks = uniquePaths(input.paths).map((targetPath): WorkerDiskWatermark => {
    const statPath = firstExistingAncestor(targetPath);
    if (!statPath) {
      return {
        path: targetPath,
        statPath: targetPath,
        status: "unavailable",
        threshold,
        error: "no_existing_ancestor"
      };
    }

    try {
      const fileStat = statSync(statPath);
      if (!fileStat.isDirectory()) {
        return {
          path: targetPath,
          statPath,
          status: "unavailable",
          threshold,
          error: "not_directory"
        };
      }

      const stats = statfsSync(statPath, { bigint: false });
      const totalBytes = Math.max(0, stats.blocks * stats.bsize);
      const availableBytes = Math.max(0, stats.bavail * stats.bsize);
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const usedRatio = totalBytes > 0 ? Math.max(0, Math.min(1, usedBytes / totalBytes)) : 0;
      return {
        path: targetPath,
        statPath,
        status: usedRatio >= threshold ? "pressure" : "ok",
        threshold,
        usedRatio,
        usedBytes,
        totalBytes
      };
    } catch (error) {
      return {
        path: targetPath,
        statPath,
        status: "unavailable",
        threshold,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  return {
    status: disks.some((disk) => disk.status === "pressure") ? "pressure" : "ok",
    disks
  };
}
