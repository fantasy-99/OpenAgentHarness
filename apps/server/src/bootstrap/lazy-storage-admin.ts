import type {
  StorageOverview,
  StoragePostgresTableName,
  StoragePostgresTablePage,
  StorageRedisDeleteKeyResponse,
  StorageRedisDeleteKeysResponse,
  StorageRedisKeyDetail,
  StorageRedisKeyPage,
  StorageRedisMaintenanceResponse,
  StorageRedisWorkerAffinity,
  StorageRedisWorkspacePlacementPage
} from "@oah/api-contracts";
import type { StorageAdmin } from "../storage-admin.js";

export function createLazyStorageAdmin(factory: () => Promise<StorageAdmin>): StorageAdmin {
  let adminPromise: Promise<StorageAdmin> | undefined;

  const load = (): Promise<StorageAdmin> => {
    adminPromise ??= factory();
    return adminPromise;
  };

  return {
    overview(options?: { serviceName?: string | undefined }): Promise<StorageOverview> {
      return load().then((admin) => admin.overview(options));
    },
    postgresTable(
      table: StoragePostgresTableName,
      options: {
        limit: number;
        offset?: number | undefined;
        serviceName?: string | undefined;
        q?: string | undefined;
        workspaceId?: string | undefined;
        sessionId?: string | undefined;
        runId?: string | undefined;
        status?: string | undefined;
        errorCode?: string | undefined;
        recoveryState?: string | undefined;
      }
    ): Promise<StoragePostgresTablePage> {
      return load().then((admin) => admin.postgresTable(table, options));
    },
    redisKeys(pattern: string, cursor: string | undefined, pageSize: number): Promise<StorageRedisKeyPage> {
      return load().then((admin) => admin.redisKeys(pattern, cursor, pageSize));
    },
    redisKeyDetail(key: string): Promise<StorageRedisKeyDetail> {
      return load().then((admin) => admin.redisKeyDetail(key));
    },
    redisWorkerAffinity(input: {
      sessionId?: string | undefined;
      workspaceId?: string | undefined;
      ownerId?: string | undefined;
      ownerWorkerId?: string | undefined;
    }): Promise<StorageRedisWorkerAffinity> {
      return load().then((admin) => admin.redisWorkerAffinity(input));
    },
    redisWorkspacePlacements(input?: {
      workspaceId?: string | undefined;
      ownerId?: string | undefined;
      ownerWorkerId?: string | undefined;
      state?: "unassigned" | "active" | "idle" | "draining" | "evicted" | undefined;
    }): Promise<StorageRedisWorkspacePlacementPage> {
      return load().then((admin) => admin.redisWorkspacePlacements(input));
    },
    deleteRedisKey(key: string): Promise<StorageRedisDeleteKeyResponse> {
      return load().then((admin) => admin.deleteRedisKey(key));
    },
    deleteRedisKeys(keys: string[]): Promise<StorageRedisDeleteKeysResponse> {
      return load().then((admin) => admin.deleteRedisKeys(keys));
    },
    clearRedisSessionQueue(key: string): Promise<StorageRedisMaintenanceResponse> {
      return load().then((admin) => admin.clearRedisSessionQueue(key));
    },
    releaseRedisSessionLock(key: string): Promise<StorageRedisMaintenanceResponse> {
      return load().then((admin) => admin.releaseRedisSessionLock(key));
    },
    async close(): Promise<void> {
      await adminPromise?.then((admin) => admin.close());
    }
  };
}
