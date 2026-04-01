import { createApp } from "./app.js";
import { bootstrapRuntime, installSignalHandlers, shouldStartInlineWorker } from "./bootstrap.js";

async function main() {
  const runtime = await bootstrapRuntime({
    argv: process.argv.slice(2),
    startWorker: shouldStartInlineWorker(process.argv.slice(2))
  });

  const app = createApp({
    runtimeService: runtime.runtimeService,
    modelGateway: runtime.modelGateway,
    defaultModel: runtime.config.llm.default_model,
    listWorkspaceTemplates: runtime.listWorkspaceTemplates,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
    rebuildWorkspaceHistoryMirror: runtime.rebuildWorkspaceHistoryMirror
  });

  app.addHook("onClose", async () => {
    await runtime.close();
  });

  installSignalHandlers(async () => {
    await app.close();
  });

  await app.listen({
    host: runtime.config.server.host,
    port: runtime.config.server.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
