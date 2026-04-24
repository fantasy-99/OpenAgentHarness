import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";

type PublicStorageRoutesModule = typeof import("./public-storage.js");

let publicStorageRoutesModulePromise: Promise<PublicStorageRoutesModule> | undefined;

async function loadPublicStorageRoutesModule(): Promise<PublicStorageRoutesModule> {
  if (!publicStorageRoutesModulePromise) {
    publicStorageRoutesModulePromise = import("./public-storage.js");
  }

  return publicStorageRoutesModulePromise;
}

async function dispatchPublicStorageRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const module = await loadPublicStorageRoutesModule();
  return module.dispatchRegisteredPublicStorageRoute(request, reply, dependencies);
}

export function registerPublicStorageRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get("/api/v1/storage/overview", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/postgres/tables/:table", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/keys", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/key", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/worker-affinity", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.get("/api/v1/storage/redis/workspace-placements", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.delete("/api/v1/storage/redis/key", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/keys/delete", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/session-queue/clear", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
  app.post("/api/v1/storage/redis/session-lock/release", async (request, reply) =>
    dispatchPublicStorageRoute(request, reply, dependencies)
  );
}
