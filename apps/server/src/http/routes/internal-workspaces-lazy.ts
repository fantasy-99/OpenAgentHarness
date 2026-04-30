import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";

type WorkspaceRoutesModule = typeof import("./workspaces.js");

let workspaceRoutesModulePromise: Promise<WorkspaceRoutesModule> | undefined;

async function loadWorkspaceRoutesModule(): Promise<WorkspaceRoutesModule> {
  if (!workspaceRoutesModulePromise) {
    workspaceRoutesModulePromise = import("./workspaces.js");
  }

  return workspaceRoutesModulePromise;
}

async function dispatchInternalWorkspaceRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const module = await loadWorkspaceRoutesModule();
  return module.dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies);
}

export function registerInternalWorkspaceRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.post("/internal/v1/workspaces/:workspaceId/lifecycle", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.delete("/internal/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/workspaces/:workspaceId/files/upload", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/files/download", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/workspaces/:workspaceId/directories", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.delete("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.patch("/internal/v1/workspaces/:workspaceId/entries/move", async (request, reply) =>
    dispatchInternalWorkspaceRoute(request, reply, dependencies)
  );
}
