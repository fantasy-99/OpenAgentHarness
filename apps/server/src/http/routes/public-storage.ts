import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  storageOverviewSchema,
  storageOverviewQuerySchema,
  storagePostgresTableNameSchema,
  storagePostgresTablePageSchema,
  storageRedisDeleteKeyResponseSchema,
  storageRedisDeleteKeysRequestSchema,
  storageRedisDeleteKeysResponseSchema,
  storageRedisKeyDetailSchema,
  storageRedisKeyPageSchema,
  storageRedisKeyQuerySchema,
  storageRedisKeysQuerySchema,
  storageRedisMaintenanceRequestSchema,
  storageRedisMaintenanceResponseSchema,
  storageRedisWorkerAffinityQuerySchema,
  storageRedisWorkerAffinitySchema,
  storageRedisWorkspacePlacementPageSchema,
  storageRedisWorkspacePlacementQuerySchema,
  storageTableQuerySchema
} from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";

import { createParamsSchema } from "../context.js";
import { resolveOwnerId } from "../proxy-utils.js";
import type { AppDependencies } from "../types.js";

function readRegisteredRouteUrl(request: FastifyRequest): string {
  return typeof request.routeOptions.url === "string" ? request.routeOptions.url : request.url.split("?")[0] ?? request.url;
}

export async function dispatchRegisteredPublicStorageRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  if (!dependencies.storageAdmin) {
    throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
  }

  const routeUrl = readRegisteredRouteUrl(request);

  switch (`${request.method} ${routeUrl}`) {
    case "GET /api/v1/storage/overview": {
      const query = storageOverviewQuerySchema.parse(request.query);
      return reply.send(
        storageOverviewSchema.parse(
          await dependencies.storageAdmin.overview(query.serviceName ? { serviceName: query.serviceName } : undefined)
        )
      );
    }
    case "GET /api/v1/storage/postgres/tables/:table": {
      const params = createParamsSchema("table").parse(request.params);
      const rawQuery = request.query as Record<string, unknown>;
      const parsedQuery = storageTableQuerySchema.parse(request.query);
      const query = {
        ...parsedQuery,
        ...(typeof rawQuery.status === "string" ? { status: rawQuery.status } : {}),
        ...(typeof rawQuery.errorCode === "string" ? { errorCode: rawQuery.errorCode } : {}),
        ...(typeof rawQuery.recoveryState === "string" ? { recoveryState: rawQuery.recoveryState } : {})
      };
      const table = storagePostgresTableNameSchema.parse(params.table);
      return reply.send(
        storagePostgresTablePageSchema.parse(
          await dependencies.storageAdmin.postgresTable(table, {
            limit: query.limit,
            offset: query.offset,
            ...(query.serviceName ? { serviceName: query.serviceName } : {}),
            ...(query.q ? { q: query.q } : {}),
            ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
            ...(query.sessionId ? { sessionId: query.sessionId } : {}),
            ...(query.runId ? { runId: query.runId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.errorCode ? { errorCode: query.errorCode } : {}),
            ...(query.recoveryState ? { recoveryState: query.recoveryState } : {})
          })
        )
      );
    }
    case "GET /api/v1/storage/redis/keys": {
      const query = storageRedisKeysQuerySchema.parse(request.query);
      return reply.send(
        storageRedisKeyPageSchema.parse(await dependencies.storageAdmin.redisKeys(query.pattern, query.cursor, query.pageSize))
      );
    }
    case "GET /api/v1/storage/redis/key": {
      const query = storageRedisKeyQuerySchema.parse(request.query);
      return reply.send(storageRedisKeyDetailSchema.parse(await dependencies.storageAdmin.redisKeyDetail(query.key)));
    }
    case "GET /api/v1/storage/redis/worker-affinity": {
      const rawQuery = request.query as Record<string, unknown>;
      const query = storageRedisWorkerAffinityQuerySchema.parse({
        ...rawQuery,
        ownerId: resolveOwnerId({
          ownerId: typeof rawQuery.ownerId === "string" ? rawQuery.ownerId : undefined
        })
      });
      return reply.send(storageRedisWorkerAffinitySchema.parse(await dependencies.storageAdmin.redisWorkerAffinity(query)));
    }
    case "GET /api/v1/storage/redis/workspace-placements": {
      const rawQuery = request.query as Record<string, unknown>;
      const query = storageRedisWorkspacePlacementQuerySchema.parse({
        ...rawQuery,
        ownerId: resolveOwnerId({
          ownerId: typeof rawQuery.ownerId === "string" ? rawQuery.ownerId : undefined
        })
      });
      return reply.send(
        storageRedisWorkspacePlacementPageSchema.parse(await dependencies.storageAdmin.redisWorkspacePlacements(query))
      );
    }
    case "DELETE /api/v1/storage/redis/key": {
      const query = storageRedisKeyQuerySchema.parse(request.query);
      return reply.send(storageRedisDeleteKeyResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKey(query.key)));
    }
    case "POST /api/v1/storage/redis/keys/delete": {
      const body = storageRedisDeleteKeysRequestSchema.parse(request.body);
      return reply.send(
        storageRedisDeleteKeysResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKeys(body.keys))
      );
    }
    case "POST /api/v1/storage/redis/session-queue/clear": {
      const body = storageRedisMaintenanceRequestSchema.parse(request.body);
      return reply.send(
        storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.clearRedisSessionQueue(body.key))
      );
    }
    case "POST /api/v1/storage/redis/session-lock/release": {
      const body = storageRedisMaintenanceRequestSchema.parse(request.body);
      return reply.send(
        storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.releaseRedisSessionLock(body.key))
      );
    }
    default:
      throw new AppError(404, "route_not_found", `Unsupported public storage route: ${request.method} ${routeUrl}`);
  }
}

export function registerPublicStorageRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get("/api/v1/storage/overview", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/postgres/tables/:table", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/keys", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/key", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/worker-affinity", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/workspace-placements", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.delete("/api/v1/storage/redis/key", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/keys/delete", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/session-queue/clear", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/session-lock/release", async (request, reply) =>
    dispatchRegisteredPublicStorageRoute(request, reply, dependencies)
  );
}
