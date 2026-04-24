import { createBaseApp, registerInternalOnlySurface, registerInternalRoutes } from "./app-core.js";
import type { AppDependencies } from "./http/types.js";

export function createInternalWorkerApp(dependencies: AppDependencies) {
  const app = createBaseApp(dependencies);

  registerInternalOnlySurface(app, dependencies);
  registerInternalRoutes(app, dependencies);

  return app;
}
