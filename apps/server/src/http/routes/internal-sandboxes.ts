import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";
import {
  dispatchRegisteredSandboxRoute,
  registerInternalSandboxRoutes as registerSharedInternalSandboxRoutes
} from "./sandboxes.js";

export async function dispatchRegisteredInternalSandboxRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  return dispatchRegisteredSandboxRoute(request, reply, dependencies);
}

export function registerInternalSandboxRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  registerSharedInternalSandboxRoutes(app, dependencies);
}
