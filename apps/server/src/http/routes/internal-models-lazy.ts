import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";

type InternalModelRoutesModule = typeof import("./internal-models.js");

let internalModelRoutesModulePromise: Promise<InternalModelRoutesModule> | undefined;

async function loadInternalModelRoutesModule(): Promise<InternalModelRoutesModule> {
  if (!internalModelRoutesModulePromise) {
    internalModelRoutesModulePromise = import("./internal-models.js");
  }

  return internalModelRoutesModulePromise;
}

async function dispatchInternalModelRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const module = await loadInternalModelRoutesModule();
  return module.dispatchRegisteredInternalModelRoute(request, reply, dependencies);
}

export function registerInternalModelRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  if (!dependencies.modelGateway) {
    return;
  }

  app.post("/internal/v1/platform-models/refresh", async (request, reply) =>
    dispatchInternalModelRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/models/generate", async (request, reply) =>
    dispatchInternalModelRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/models/stream", async (request, reply) =>
    dispatchInternalModelRoute(request, reply, dependencies)
  );
}
