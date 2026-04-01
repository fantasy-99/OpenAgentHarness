import path from "node:path";
import { access, rm } from "node:fs/promises";

import {
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot,
  updateWorkspaceHistoryMirrorSetting
} from "@oah/config";
import { RuntimeService } from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";
import { createPostgresRuntimePersistence } from "@oah/storage-postgres";
import {
  FanoutSessionEventStore,
  RedisRunWorker,
  createRedisSessionEventBus,
  createRedisSessionRunQueue
} from "@oah/storage-redis";
import { HistoryMirrorSyncer, inspectHistoryMirrorStatus } from "./history-mirror.js";

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
}

export interface BootstrappedRuntime {
  config: Awaited<ReturnType<typeof loadServerConfig>>;
  runtimeService: RuntimeService;
  modelGateway: AiSdkModelGateway;
  listWorkspaceTemplates: () => Promise<Array<{ name: string }>>;
  rebuildWorkspaceHistoryMirror(workspace: import("@oah/runtime-core").WorkspaceRecord): Promise<
    import("./history-mirror.js").HistoryMirrorStatus
  >;
  healthReport(): Promise<{
    status: "ok" | "degraded";
    storage: {
      primary: "postgres" | "memory";
      events: "redis" | "memory";
      runQueue: "redis" | "in_process";
    };
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
      historyMirror: "up" | "degraded" | "not_configured";
    };
    worker: {
      mode: "inline" | "external" | "disabled";
    };
    mirror: {
      worker: "running" | "disabled";
      enabledWorkspaces: number;
      idleWorkspaces: number;
      missingWorkspaces: number;
      errorWorkspaces: number;
    };
  }>;
  readinessReport(): Promise<{
    status: "ready" | "not_ready";
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
    };
  }>;
  close(): Promise<void>;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isManagedWorkspaceRoot(workspaceRoot: string, managedWorkspaceDir: string): boolean {
  const relativePath = path.relative(path.resolve(managedWorkspaceDir), path.resolve(workspaceRoot));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function parseConfigPath(argv: string[]): { path: string; explicit: boolean } {
  const configFlagIndex = argv.findIndex((value) => value === "--config");
  if (configFlagIndex >= 0) {
    const configPath = argv[configFlagIndex + 1];
    if (!configPath) {
      throw new Error("Missing value for --config.");
    }

    return {
      path: path.resolve(process.cwd(), configPath),
      explicit: true
    };
  }

  const envPath = process.env.OAH_CONFIG;
  if (envPath) {
    return {
      path: path.resolve(process.cwd(), envPath),
      explicit: true
    };
  }

  return {
    path: path.resolve(process.cwd(), "server.yaml"),
    explicit: false
  };
}

export function shouldStartInlineWorker(argv: string[]): boolean {
  if (argv.includes("--api-only") || argv.includes("--no-worker")) {
    return false;
  }

  const inlineWorkerEnv = process.env.OAH_INLINE_WORKER;
  if (inlineWorkerEnv !== undefined) {
    return !["0", "false", "off"].includes(inlineWorkerEnv.toLowerCase());
  }

  return true;
}

export async function bootstrapRuntime(options: BootstrapOptions = {}): Promise<BootstrappedRuntime> {
  const argv = options.argv ?? process.argv.slice(2);
  const startWorker = options.startWorker ?? false;
  const requestedConfig = parseConfigPath(argv);
  const configPath =
    (await fileExists(requestedConfig.path))
      ? requestedConfig.path
      : requestedConfig.explicit
        ? requestedConfig.path
        : path.resolve(process.cwd(), "server.example.yaml");
  const config = await loadServerConfig(configPath);
  const models = await loadPlatformModels(config.paths.models_dir);
  const discoveredWorkspaces = await discoverWorkspaces({
    paths: config.paths,
    platformModels: models
  });

  const modelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models
  });

  const persistence =
    config.storage.postgres_url && config.storage.postgres_url.trim().length > 0
      ? await createPostgresRuntimePersistence({
          connectionString: config.storage.postgres_url
        }).catch((error) => {
          console.warn(
            `PostgreSQL persistence unavailable (${error instanceof Error ? error.message : "unknown error"}); falling back to in-memory persistence.`
          );
          return createMemoryRuntimePersistence();
        })
      : createMemoryRuntimePersistence();
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const primaryStorageMode = "pool" in persistence && "db" in persistence ? "postgres" : "memory";
  const redisBus =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionEventBus({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis event bus unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without Redis fanout.`
          );
          return undefined;
        })
      : undefined;
  const redisRunQueue =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionRunQueue({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis run queue unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing with in-process scheduling.`
          );
          return undefined;
        })
      : undefined;
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const workerMode = startWorker ? "inline" : redisRunQueue ? "external" : "disabled";
  const sessionEventStore = redisBus
    ? new FanoutSessionEventStore(persistence.sessionEventStore, redisBus)
    : persistence.sessionEventStore;

  await Promise.all(discoveredWorkspaces.map((workspace) => persistence.workspaceRepository.upsert(workspace)));
  const runtimeService = new RuntimeService({
    defaultModel: config.llm.default_model,
    modelGateway,
    platformModels: models,
    ...persistence,
    sessionEventStore,
    runQueue: redisRunQueue,
    workspaceDeletionHandler: {
      async deleteWorkspace(workspace) {
        if (workspace.kind !== "project") {
          return;
        }

        if (!isManagedWorkspaceRoot(workspace.rootPath, config.paths.workspace_dir)) {
          return;
        }

        await rm(workspace.rootPath, {
          recursive: true,
          force: true
        });
      }
    },
    workspaceSettingsManager: {
      async updateHistoryMirrorEnabled(workspace, enabled) {
        await updateWorkspaceHistoryMirrorSetting(workspace.rootPath, enabled);
        const refreshed = await discoverWorkspace(workspace.rootPath, workspace.kind, {
          platformModels: models,
          platformSkillDir: config.paths.skill_dir,
          platformMcpDir: config.paths.mcp_dir
        });
        return persistence.workspaceRepository.upsert({
          ...refreshed,
          name: workspace.name,
          executionPolicy: workspace.executionPolicy,
          status: workspace.status,
          createdAt: workspace.createdAt,
          externalRef: workspace.externalRef
        });
      }
    },
    workspaceInitializer: {
      async initialize(input) {
        const workspaceRoot = resolveWorkspaceCreationRoot({
          workspaceDir: config.paths.workspace_dir,
          name: input.name,
          rootPath: input.rootPath
        });

        await initializeWorkspaceFromTemplate({
          templateDir: config.paths.template_dir,
          templateName: input.template,
          rootPath: workspaceRoot,
          agentsMd: input.agentsMd,
          mcpServers: input.mcpServers,
          skills: input.skills
        });

        return discoverWorkspace(workspaceRoot, "project", {
          platformModels: models,
          platformSkillDir: config.paths.skill_dir,
          platformMcpDir: config.paths.mcp_dir
        });
      }
    }
  });
  const redisRunWorker =
    startWorker && redisRunQueue
      ? new RedisRunWorker({
          queue: redisRunQueue,
          runtimeService,
          logger: {
            warn(message, error) {
              console.warn(message, error);
            },
            error(message, error) {
              console.error(message, error);
            }
          }
        })
      : undefined;
  redisRunWorker?.start();
  const historyMirrorSyncer =
    startWorker && "historyEventRepository" in persistence && persistence.historyEventRepository
      ? new HistoryMirrorSyncer({
          workspaceRepository: persistence.workspaceRepository,
          historyEventRepository: persistence.historyEventRepository,
          logger: {
            warn(message, error) {
              console.warn(message, error);
            },
            error(message, error) {
              console.error(message, error);
            }
          }
        })
      : undefined;
  historyMirrorSyncer?.start();

  const closePersistence =
    "close" in persistence && typeof persistence.close === "function" ? () => persistence.close() : async () => undefined;

  async function postgresCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!postgresConfigured) {
      return "not_configured";
    }

    if (primaryStorageMode !== "postgres" || !("pool" in persistence)) {
      return "down";
    }

    try {
      await persistence.pool.query("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  async function redisEventsCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisBus) {
      return "down";
    }

    return (await redisBus.ping()) ? "up" : "down";
  }

  async function redisRunQueueCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisRunQueue) {
      return "down";
    }

    return (await redisRunQueue.ping()) ? "up" : "down";
  }

  async function historyMirrorSummary(): Promise<{
    check: "up" | "degraded" | "not_configured";
    worker: "running" | "disabled";
    enabledWorkspaces: number;
    idleWorkspaces: number;
    missingWorkspaces: number;
    errorWorkspaces: number;
  }> {
    const workspaces: import("@oah/runtime-core").WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await persistence.workspaceRepository.list(100, cursor);
      workspaces.push(...page);
      cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
    } while (cursor);

    const enabledWorkspaces = workspaces.filter((workspace) => workspace.kind === "project" && workspace.historyMirrorEnabled);

    if (enabledWorkspaces.length === 0) {
      return {
        check: "not_configured",
        worker: historyMirrorSyncer ? "running" : "disabled",
        enabledWorkspaces: 0,
        idleWorkspaces: 0,
        missingWorkspaces: 0,
        errorWorkspaces: 0
      };
    }

    const statuses = await Promise.all(enabledWorkspaces.map((workspace) => inspectHistoryMirrorStatus(workspace)));
    const idleWorkspaces = statuses.filter((status) => status.state === "idle").length;
    const missingWorkspaces = statuses.filter((status) => status.state === "missing").length;
    const errorWorkspaces = statuses.filter((status) => status.state === "error").length;
    const degraded = !historyMirrorSyncer || missingWorkspaces > 0 || errorWorkspaces > 0;

    return {
      check: degraded ? "degraded" : "up",
      worker: historyMirrorSyncer ? "running" : "disabled",
      enabledWorkspaces: enabledWorkspaces.length,
      idleWorkspaces,
      missingWorkspaces,
      errorWorkspaces
    };
  }

  return {
    config,
    runtimeService,
    modelGateway,
    listWorkspaceTemplates: () => listWorkspaceTemplates(config.paths.template_dir),
    rebuildWorkspaceHistoryMirror(workspace) {
      if (!historyMirrorSyncer) {
        throw new Error("History mirror rebuild is unavailable because the mirror sync worker is not running.");
      }

      return historyMirrorSyncer.rebuildWorkspace(workspace);
    },
    async healthReport() {
      const mirror = await historyMirrorSummary();
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck(),
        historyMirror: mirror.check
      };

      return {
        status: Object.values(checks).some((value) => value === "down" || value === "degraded") ? "degraded" : "ok",
        storage: {
          primary: primaryStorageMode,
          events: redisBus ? "redis" : "memory",
          runQueue: redisRunQueue ? "redis" : "in_process"
        },
        checks,
        worker: {
          mode: workerMode
        },
        mirror
      };
    },
    async readinessReport() {
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };

      return {
        status: Object.values(checks).includes("down") ? "not_ready" : "ready",
        checks
      };
    },
    async close() {
      await Promise.all([
        historyMirrorSyncer?.close() ?? Promise.resolve(),
        redisRunWorker?.close() ?? Promise.resolve(),
        closePersistence(),
        redisBus?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
    }
  };
}

export function installSignalHandlers(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;

  const shutdown = () => {
    if (!closing) {
      closing = close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    }

    return closing;
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit());
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit());
  });
}
