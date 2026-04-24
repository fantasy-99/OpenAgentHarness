import { createApiApp } from "./api-app.js";
import { createInternalWorkerApp } from "./internal-worker-app.js";

export type { AppDependencies } from "./http/types.js";

export interface CreateAppOptions {
  surface?: "full" | "internal_only";
}

export { createApiApp, createInternalWorkerApp };

export function createApp(
  dependencies: import("./http/types.js").AppDependencies,
  options: CreateAppOptions = {}
) {
  return options.surface === "internal_only" ? createInternalWorkerApp(dependencies) : createApiApp(dependencies);
}
