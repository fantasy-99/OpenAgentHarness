import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";

type InternalSandboxRoutesModule = typeof import("./internal-sandboxes.js");

let internalSandboxRoutesModulePromise: Promise<InternalSandboxRoutesModule> | undefined;

async function loadInternalSandboxRoutesModule(): Promise<InternalSandboxRoutesModule> {
  if (!internalSandboxRoutesModulePromise) {
    internalSandboxRoutesModulePromise = import("./internal-sandboxes.js");
  }

  return internalSandboxRoutesModulePromise;
}

async function dispatchInternalSandboxRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const module = await loadInternalSandboxRoutesModule();
  return module.dispatchRegisteredInternalSandboxRoute(request, reply, dependencies);
}

export function registerInternalSandboxRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.post("/internal/v1/sandboxes", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/sandboxes/:sandboxId", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/sandboxes/:sandboxId/files/entries", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/sandboxes/:sandboxId/files/stat", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/sandboxes/:sandboxId/files/content", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/sandboxes/:sandboxId/files/content", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/sandboxes/:sandboxId/files/upload", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/sandboxes/:sandboxId/files/download", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/sandboxes/:sandboxId/directories", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.delete("/internal/v1/sandboxes/:sandboxId/files/entry", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.patch("/internal/v1/sandboxes/:sandboxId/files/move", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/sandboxes/:sandboxId/commands/foreground", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/sandboxes/:sandboxId/commands/process", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/sandboxes/:sandboxId/commands/background", async (request, reply) =>
    dispatchInternalSandboxRoute(request, reply, dependencies)
  );
}
