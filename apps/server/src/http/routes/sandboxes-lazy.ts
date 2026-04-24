import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies, AppRouteOptions } from "../types.js";

type SandboxRoutesModule = typeof import("./sandboxes.js");

let sandboxRoutesModulePromise: Promise<SandboxRoutesModule> | undefined;

async function loadSandboxRoutesModule(): Promise<SandboxRoutesModule> {
  if (!sandboxRoutesModulePromise) {
    sandboxRoutesModulePromise = import("./sandboxes.js");
  }

  return sandboxRoutesModulePromise;
}

async function dispatchSandboxRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies,
  options: { workspaceMode?: AppRouteOptions["workspaceMode"]; publicApi?: boolean | undefined } = {}
) {
  const module = await loadSandboxRoutesModule();
  return module.dispatchRegisteredSandboxRoute(request, reply, dependencies, options);
}

export function registerSandboxRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  options: AppRouteOptions
): void {
  app.post("/api/v1/sandboxes", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.get("/api/v1/sandboxes/:sandboxId", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.get("/api/v1/sandboxes/:sandboxId/files/entries", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.get("/api/v1/sandboxes/:sandboxId/files/stat", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.get("/api/v1/sandboxes/:sandboxId/files/content", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.put("/api/v1/sandboxes/:sandboxId/files/content", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.put("/api/v1/sandboxes/:sandboxId/files/upload", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.get("/api/v1/sandboxes/:sandboxId/files/download", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.post("/api/v1/sandboxes/:sandboxId/directories", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.delete("/api/v1/sandboxes/:sandboxId/files/entry", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.patch("/api/v1/sandboxes/:sandboxId/files/move", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.post("/api/v1/sandboxes/:sandboxId/commands/foreground", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.post("/api/v1/sandboxes/:sandboxId/commands/process", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
  app.post("/api/v1/sandboxes/:sandboxId/commands/background", async (request, reply) =>
    dispatchSandboxRoute(request, reply, dependencies, {
      workspaceMode: options.workspaceMode,
      publicApi: true
    })
  );
}
