import type { ServerConfig } from "@oah/config";
import type { WorkerRegistry, WorkspacePlacementRegistry } from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";
import { trimToUndefined } from "./string-utils.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";

let sandboxHostModulePromise: Promise<typeof import("./sandbox-host.js")> | undefined;
let e2bCompatibleSandboxHostModulePromise: Promise<typeof import("./e2b-compatible-sandbox-host.js")> | undefined;
let nativeE2BSandboxServiceModulePromise: Promise<typeof import("./native-e2b-sandbox-service.js")> | undefined;
let selfHostedSandboxRoutingModulePromise: Promise<typeof import("./self-hosted-sandbox-routing.js")> | undefined;

function loadSandboxHostModule(): Promise<typeof import("./sandbox-host.js")> {
  sandboxHostModulePromise ??= import("./sandbox-host.js");
  return sandboxHostModulePromise;
}

function loadE2BCompatibleSandboxHostModule(): Promise<typeof import("./e2b-compatible-sandbox-host.js")> {
  e2bCompatibleSandboxHostModulePromise ??= import("./e2b-compatible-sandbox-host.js");
  return e2bCompatibleSandboxHostModulePromise;
}

function loadNativeE2BSandboxServiceModule(): Promise<typeof import("./native-e2b-sandbox-service.js")> {
  nativeE2BSandboxServiceModulePromise ??= import("./native-e2b-sandbox-service.js");
  return nativeE2BSandboxServiceModulePromise;
}

function loadSelfHostedSandboxRoutingModule(): Promise<typeof import("./self-hosted-sandbox-routing.js")> {
  selfHostedSandboxRoutingModulePromise ??= import("./self-hosted-sandbox-routing.js");
  return selfHostedSandboxRoutingModulePromise;
}

export async function createConfiguredSandboxHost(options: {
  config: ServerConfig;
  workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
}): Promise<SandboxHost | undefined> {
  const provider =
    options.config.sandbox?.provider ??
    (trimToUndefined(options.config.sandbox?.self_hosted?.base_url) ? "self_hosted" : "embedded");

  if (provider === "embedded") {
    if (!options.workspaceMaterializationManager) {
      return undefined;
    }

    return (await loadSandboxHostModule()).createMaterializationSandboxHost({
      materializationManager: options.workspaceMaterializationManager
    });
  }

  if (provider === "self_hosted") {
    const baseUrl = trimToUndefined(options.config.sandbox?.self_hosted?.base_url);
    if (!baseUrl) {
      throw new Error("sandbox.self_hosted.base_url is required when sandbox.provider is self_hosted.");
    }

    const [{ createE2BCompatibleSandboxHost, createHttpE2BCompatibleSandboxService }, { resolveSelfHostedSandboxCreateBaseUrl }] =
      await Promise.all([loadE2BCompatibleSandboxHostModule(), loadSelfHostedSandboxRoutingModule()]);

    return createE2BCompatibleSandboxHost({
      providerKind: "self_hosted",
      diagnostics: {
        provider: "self_hosted",
        transport: "http",
        executionModel: "sandbox_hosted",
        workerPlacement: "inside_sandbox"
      },
      service: createHttpE2BCompatibleSandboxService({
        baseUrl,
        ...(options.config.sandbox?.self_hosted?.headers ? { headers: options.config.sandbox.self_hosted.headers } : {}),
        ...(options.workspacePlacementRegistry
          ? {
              resolveCreateBaseUrl: (workspace) =>
                resolveSelfHostedSandboxCreateBaseUrl({
                  baseUrl,
                  workspace,
                  workspacePlacementRegistry: options.workspacePlacementRegistry,
                  ...(options.workerRegistry ? { workerRegistry: options.workerRegistry } : {})
                })
            }
          : {})
      })
    });
  }

  const [{ createE2BCompatibleSandboxHost }, { createNativeE2BSandboxService, normalizeE2BApiUrl }] = await Promise.all([
    loadE2BCompatibleSandboxHostModule(),
    loadNativeE2BSandboxServiceModule()
  ]);

  return createE2BCompatibleSandboxHost({
    providerKind: "e2b",
    service: createNativeE2BSandboxService({
      apiKey: trimToUndefined(options.config.sandbox?.e2b?.api_key),
      apiUrl: normalizeE2BApiUrl(options.config.sandbox?.e2b?.base_url),
      domain: trimToUndefined(options.config.sandbox?.e2b?.domain),
      headers: options.config.sandbox?.e2b?.headers,
      template: trimToUndefined(options.config.sandbox?.e2b?.template),
      timeoutMs: options.config.sandbox?.e2b?.timeout_ms,
      requestTimeoutMs: options.config.sandbox?.e2b?.request_timeout_ms
    })
  });
}
