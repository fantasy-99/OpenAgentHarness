import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import path from "node:path";

import type { ServerConfig } from "@oah/config-server-control";

export type WorkerReplicaTargetOutcome = "disabled" | "steady" | "scaled" | "blocked_scale_down" | "error";

export type WorkerReplicaTargetPhase = "disabled" | "steady" | "accepted" | "progressing" | "ready" | "blocked" | "error";

export interface WorkerReplicaTargetRef {
  platform: "kubernetes" | "docker_compose" | "noop";
  kind?: string | undefined;
  namespace?: string | undefined;
  name?: string | undefined;
  discovery?: "explicit" | "label_selector" | undefined;
  selector?: string | undefined;
}

export interface WorkerReplicaTargetInput {
  timestamp: string;
  reason: string;
  desiredReplicas: number;
  suggestedReplicas: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  readySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface WorkerReplicaTargetResult {
  kind: string;
  attempted: boolean;
  applied: boolean;
  desiredReplicas: number;
  observedReplicas?: number | undefined;
  appliedReplicas?: number | undefined;
  outcome: WorkerReplicaTargetOutcome;
  at: string;
  phase?: WorkerReplicaTargetPhase | undefined;
  stage?: "discover_target" | "read_state" | "apply_scale" | "observe_rollout" | undefined;
  reasonCode?: string | undefined;
  targetRef?: WorkerReplicaTargetRef | undefined;
  generation?: number | undefined;
  observedGeneration?: number | undefined;
  readyReplicas?: number | undefined;
  updatedReplicas?: number | undefined;
  availableReplicas?: number | undefined;
  unavailableReplicas?: number | undefined;
  message?: string | undefined;
}

export interface WorkerReplicaTarget {
  readonly kind: string;
  reconcile(input: WorkerReplicaTargetInput): Promise<WorkerReplicaTargetResult>;
  close?(): Promise<void>;
}

interface ControllerScaleTargetConfigShape {
  type?: "noop" | "kubernetes" | "docker_compose" | undefined;
  allow_scale_down?: boolean | undefined;
  kubernetes?:
    | {
        namespace?: string | undefined;
        deployment?: string | undefined;
        label_selector?: string | undefined;
        api_url?: string | undefined;
        token_file?: string | undefined;
        ca_file?: string | undefined;
        skip_tls_verify?: boolean | undefined;
      }
    | undefined;
  docker_compose?:
    | {
        compose_file?: string | undefined;
        project_name?: string | undefined;
        service?: string | undefined;
        command?: string | undefined;
        endpoint?: string | undefined;
        auth_token?: string | undefined;
        timeout_ms?: number | undefined;
      }
    | undefined;
}

export type ResolvedWorkerReplicaTargetConfig =
  | {
      type: "noop";
      allowScaleDown: boolean;
    }
  | {
      type: "kubernetes";
      allowScaleDown: boolean;
      kubernetes: {
        namespace: string;
        deployment?: string | undefined;
        labelSelector?: string | undefined;
        apiUrl: string;
        tokenFile: string;
        caFile?: string | undefined;
        skipTlsVerify: boolean;
      };
    }
  | {
      type: "docker_compose";
      allowScaleDown: boolean;
      dockerCompose: {
        composeFile?: string | undefined;
        projectName: string;
        service: string;
        command: string;
        remote?:
          | {
              endpoint: string;
              authToken?: string | undefined;
              timeoutMs: number;
            }
          | undefined;
      };
    };

export interface KubernetesJsonRequest {
  url: string;
  method: "GET" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
}

export interface JsonHttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
  timeoutMs?: number | undefined;
}

interface KubernetesDeploymentObservation {
  specReplicas?: number | undefined;
  statusReplicas?: number | undefined;
  readyReplicas?: number | undefined;
  updatedReplicas?: number | undefined;
  availableReplicas?: number | undefined;
  unavailableReplicas?: number | undefined;
  generation?: number | undefined;
  observedGeneration?: number | undefined;
}

class KubernetesReplicaTargetError extends Error {
  readonly code: string;
  readonly stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout";
  readonly status?: number | undefined;

  constructor(input: {
    message: string;
    code: string;
    stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout";
    status?: number | undefined;
  }) {
    super(input.message);
    this.name = "KubernetesReplicaTargetError";
    this.code = input.code;
    this.stage = input.stage;
    this.status = input.status;
  }
}

export interface DockerComposeCommandInput {
  args: string[];
  cwd?: string | undefined;
}

export interface DockerComposeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface DockerComposeManagedContainer {
  id: string;
  name: string;
  running: boolean;
}

export interface DockerComposeRemoteReconcileRequest {
  input: WorkerReplicaTargetInput;
  allowScaleDown: boolean;
}

export type DockerComposeCommandFn = (input: DockerComposeCommandInput) => Promise<DockerComposeCommandResult>;

export type KubernetesJsonRequestFn = (
  input: KubernetesJsonRequest
) => Promise<{
  status: number;
  body: unknown;
  text: string;
}>;

export type JsonHttpRequestFn = (
  input: JsonHttpRequest
) => Promise<{
  status: number;
  body: unknown;
  text: string;
}>;

function readEnv(names: string | string[]): string | undefined {
  for (const name of Array.isArray(names) ? names : [names]) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return undefined;
}

function readBoolEnv(names: string | string[], fallback: boolean): boolean {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readStringEnv(names: string | string[], fallback?: string | undefined): string | undefined {
  return readEnv(names) ?? fallback;
}

function readPositiveIntEnv(names: string | string[], fallback: number, minimum: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolveKubernetesApiUrl(raw?: string | undefined): string | undefined {
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }

  const host = readStringEnv("KUBERNETES_SERVICE_HOST");
  const port = readStringEnv("KUBERNETES_SERVICE_PORT_HTTPS") ?? readStringEnv("KUBERNETES_SERVICE_PORT") ?? undefined;
  if (!host || !port) {
    return undefined;
  }

  return `https://${host}:${port}`;
}

export function resolveWorkerReplicaTargetConfig(config: ServerConfig): ResolvedWorkerReplicaTargetConfig {
  const controllerConfig = (config.workers?.controller ?? {}) as NonNullable<ServerConfig["workers"]>["controller"] & {
    scale_target?: ControllerScaleTargetConfigShape | undefined;
  };
  const scaleTarget = controllerConfig.scale_target;
  const targetTypeRaw = readStringEnv("OAH_CONTROLLER_TARGET_TYPE", scaleTarget?.type ?? "noop");
  const targetType =
    targetTypeRaw === "kubernetes" ? "kubernetes" : targetTypeRaw === "docker_compose" ? "docker_compose" : "noop";
  const allowScaleDown = readBoolEnv("OAH_CONTROLLER_ALLOW_SCALE_DOWN", scaleTarget?.allow_scale_down ?? true);

  if (targetType === "noop") {
    return {
      type: "noop",
      allowScaleDown
    };
  }

  if (targetType === "docker_compose") {
    const dockerCompose = scaleTarget?.docker_compose;
    const composeFile = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_FILE", dockerCompose?.compose_file);
    const projectName = readStringEnv("OAH_CONTROLLER_TARGET_PROJECT_NAME", dockerCompose?.project_name);
    const service = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_SERVICE", dockerCompose?.service ?? "oah-sandbox");
    const command = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_COMMAND", dockerCompose?.command ?? "docker") ?? "docker";
    const endpoint = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_ENDPOINT", dockerCompose?.endpoint);
    const authToken = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_AUTH_TOKEN", dockerCompose?.auth_token);
    const timeoutMs = readPositiveIntEnv("OAH_CONTROLLER_TARGET_COMPOSE_TIMEOUT_MS", dockerCompose?.timeout_ms ?? 5_000, 100);

    if (!service) {
      throw new Error("controller docker_compose scale target requires service.");
    }
    if (!projectName) {
      throw new Error("controller docker_compose scale target requires project_name.");
    }

    return {
      type: "docker_compose",
      allowScaleDown,
      dockerCompose: {
        ...(composeFile ? { composeFile } : {}),
        projectName,
        service,
        command,
        ...(endpoint
          ? {
              remote: {
                endpoint,
                ...(authToken ? { authToken } : {}),
                timeoutMs
              }
            }
          : {})
      }
    };
  }

  const kubernetes = scaleTarget?.kubernetes;
  const namespace = readStringEnv("OAH_CONTROLLER_TARGET_NAMESPACE", kubernetes?.namespace);
  const deployment = readStringEnv("OAH_CONTROLLER_TARGET_DEPLOYMENT", kubernetes?.deployment);
  const labelSelector = readStringEnv("OAH_CONTROLLER_TARGET_LABEL_SELECTOR", kubernetes?.label_selector);
  const apiUrl = resolveKubernetesApiUrl(readStringEnv("OAH_CONTROLLER_KUBE_API_URL", kubernetes?.api_url));
  const tokenFile = readStringEnv(
    "OAH_CONTROLLER_KUBE_TOKEN_FILE",
    kubernetes?.token_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/token"
  );
  const caFile = readStringEnv(
    "OAH_CONTROLLER_KUBE_CA_FILE",
    kubernetes?.ca_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
  );
  const skipTlsVerify = readBoolEnv("OAH_CONTROLLER_KUBE_SKIP_TLS_VERIFY", kubernetes?.skip_tls_verify ?? false);

  if (!namespace) {
    throw new Error("controller kubernetes scale target requires namespace.");
  }
  if (!deployment && !labelSelector) {
    throw new Error("controller kubernetes scale target requires deployment or label_selector.");
  }
  if (!apiUrl) {
    throw new Error("controller kubernetes scale target requires api_url or in-cluster service env.");
  }
  if (!tokenFile) {
    throw new Error("controller kubernetes scale target requires token_file.");
  }

  return {
    type: "kubernetes",
    allowScaleDown,
    kubernetes: {
      namespace,
      ...(deployment ? { deployment } : {}),
      ...(labelSelector ? { labelSelector } : {}),
      apiUrl,
      tokenFile,
      ...(caFile ? { caFile } : {}),
      skipTlsVerify
    }
  };
}

export function createWorkerReplicaTarget(
  config: ResolvedWorkerReplicaTargetConfig,
  options?: {
    request?: KubernetesJsonRequestFn | undefined;
    command?: DockerComposeCommandFn | undefined;
    httpRequest?: JsonHttpRequestFn | undefined;
  }
): WorkerReplicaTarget {
  if (config.type === "kubernetes") {
    return createKubernetesWorkerReplicaTarget(config, options);
  }

  if (config.type === "docker_compose") {
    if (config.dockerCompose.remote) {
      return createRemoteDockerComposeWorkerReplicaTarget(config, options);
    }

    return createDockerComposeWorkerReplicaTarget(config, options);
  }

  return createNoopWorkerReplicaTarget(config);
}

export function createNoopWorkerReplicaTarget(config: { allowScaleDown: boolean }): WorkerReplicaTarget {
  void config;
  return {
    kind: "noop",
    async reconcile(input) {
      return {
        kind: "noop",
        attempted: false,
        applied: false,
        desiredReplicas: input.desiredReplicas,
        outcome: "disabled",
        at: input.timestamp,
        phase: "disabled",
        targetRef: {
          platform: "noop"
        },
        message: "scale target disabled"
      };
    }
  };
}

export function createKubernetesWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "kubernetes" }>,
  options?: {
    request?: KubernetesJsonRequestFn | undefined;
  }
): WorkerReplicaTarget {
  const request = options?.request ?? defaultKubernetesJsonRequest;

  return {
    kind: "kubernetes",
    async reconcile(input) {
      let targetRef: WorkerReplicaTargetRef | undefined;
      let observedState: KubernetesDeploymentObservation | undefined;
      let observedReplicas: number | undefined;

      try {
        const deploymentName =
          config.kubernetes.deployment ??
          (await discoverKubernetesDeploymentName(
            {
              namespace: config.kubernetes.namespace,
              labelSelector: config.kubernetes.labelSelector!,
              apiUrl: config.kubernetes.apiUrl,
              tokenFile: config.kubernetes.tokenFile,
              caFile: config.kubernetes.caFile,
              skipTlsVerify: config.kubernetes.skipTlsVerify
            },
            request
          ));
        targetRef = {
          platform: "kubernetes",
          kind: "Deployment",
          namespace: config.kubernetes.namespace,
          name: deploymentName,
          discovery: config.kubernetes.deployment ? "explicit" : "label_selector",
          ...(config.kubernetes.labelSelector ? { selector: config.kubernetes.labelSelector } : {})
        };

        const authHeaders = await buildKubernetesAuthHeaders(config.kubernetes.tokenFile);
        observedState = await readKubernetesDeploymentState(
          {
            apiUrl: config.kubernetes.apiUrl,
            namespace: config.kubernetes.namespace,
            deployment: deploymentName,
            headers: authHeaders,
            caFile: config.kubernetes.caFile,
            skipTlsVerify: config.kubernetes.skipTlsVerify
          },
          request,
          "read_state"
        );
        observedReplicas = observedState.specReplicas ?? observedState.statusReplicas;

        if (typeof observedReplicas === "number" && !config.allowScaleDown && input.desiredReplicas < observedReplicas) {
          return buildKubernetesResult({
            input,
            targetRef,
            attempted: true,
            applied: false,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "blocked_scale_down",
            phase: "blocked",
            reasonCode: "scale_down_disabled",
            message: "scale down blocked by controller policy",
            observedState
          });
        }

        if (typeof observedReplicas === "number" && input.desiredReplicas === observedReplicas) {
          const phase = isKubernetesDeploymentReady(observedState, input.desiredReplicas) ? "ready" : "progressing";
          return buildKubernetesResult({
            input,
            targetRef,
            attempted: true,
            applied: false,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "steady",
            phase,
            ...(phase === "progressing"
              ? {
                  reasonCode: "rollout_in_progress",
                  stage: "observe_rollout" as const,
                  message: "deployment already targets desired replicas but rollout is still progressing"
                }
              : {}),
            observedState
          });
        }

        const scaleUrl = buildKubernetesDeploymentScaleUrl({
          apiUrl: config.kubernetes.apiUrl,
          namespace: config.kubernetes.namespace,
          deployment: deploymentName
        });
        const patchResponse = await request({
          url: scaleUrl,
          method: "PATCH",
          headers: {
            ...authHeaders,
            accept: "application/json",
            "content-type": "application/merge-patch+json"
          },
          body: JSON.stringify({
            spec: {
              replicas: input.desiredReplicas
            }
          }),
          caFile: config.kubernetes.caFile,
          skipTlsVerify: config.kubernetes.skipTlsVerify
        });
        assertKubernetesSuccess("patch deployment scale", patchResponse, "apply_scale");
        const appliedReplicas = parseReplicas(patchResponse.body) ?? input.desiredReplicas;

        let postPatchState: KubernetesDeploymentObservation | undefined;
        try {
          postPatchState = await readKubernetesDeploymentState(
            {
              apiUrl: config.kubernetes.apiUrl,
              namespace: config.kubernetes.namespace,
              deployment: deploymentName,
              headers: authHeaders,
              caFile: config.kubernetes.caFile,
              skipTlsVerify: config.kubernetes.skipTlsVerify
            },
            request,
            "observe_rollout"
          );
        } catch (error) {
          if (error instanceof KubernetesReplicaTargetError) {
            return buildKubernetesResult({
              input,
              targetRef,
              attempted: true,
              applied: true,
              observedReplicas,
              appliedReplicas,
              outcome: "scaled",
              phase: "accepted",
              reasonCode: "post_patch_observation_unavailable",
              stage: "observe_rollout",
              message: `scale request accepted but rollout observation is unavailable: ${error.message}`,
              observedState
            });
          }

          throw error;
        }

        const postPatchReplicas = postPatchState.specReplicas ?? postPatchState.statusReplicas ?? appliedReplicas;
        const phase =
          postPatchReplicas !== input.desiredReplicas
            ? "accepted"
            : isKubernetesDeploymentReady(postPatchState, input.desiredReplicas)
              ? "ready"
              : "progressing";

        return buildKubernetesResult({
          input,
          targetRef,
          attempted: true,
          applied: true,
          observedReplicas,
          appliedReplicas: postPatchReplicas,
          outcome: "scaled",
          phase,
          ...(phase === "accepted"
            ? {
                reasonCode: "scale_request_accepted",
                stage: "apply_scale" as const,
                message: "scale request accepted and waiting for deployment spec to converge"
              }
            : phase === "progressing"
              ? {
                  reasonCode: "rollout_in_progress",
                  stage: "observe_rollout" as const,
                  message: "deployment accepted the new replica target and rollout is progressing"
                }
              : {
                  reasonCode: "rollout_ready",
                  stage: "observe_rollout" as const,
                  message: "deployment reached the desired replica target and is ready"
                }),
          observedState: postPatchState
        });
      } catch (error) {
        return buildKubernetesErrorResult({
          input,
          error,
          targetRef,
          observedReplicas,
          observedState
        });
      }
    }
  };
}

async function defaultDockerComposeCommand(input: DockerComposeCommandInput): Promise<DockerComposeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.args[0]!, input.args.slice(1), {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function composeTargetCwd(config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>): string | undefined {
  return config.dockerCompose.composeFile ? path.dirname(config.dockerCompose.composeFile) : undefined;
}

function composeArgs(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  args: string[]
): string[] {
  return [
    config.dockerCompose.command,
    "compose",
    ...(config.dockerCompose.composeFile ? ["-f", config.dockerCompose.composeFile] : []),
    "-p",
    config.dockerCompose.projectName,
    ...args
  ];
}

async function listManagedDockerComposeContainers(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  commandRunner: DockerComposeCommandFn
): Promise<DockerComposeManagedContainer[]> {
  const cwd = composeTargetCwd(config);
  const listResult = await commandRunner({
    args: composeArgs(config, ["ps", "-a", "-q", config.dockerCompose.service]),
    ...(cwd ? { cwd } : {})
  });
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr.trim() || listResult.stdout.trim() || "failed to list docker compose containers");
  }

  const ids = listResult.stdout
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (ids.length === 0) {
    return [];
  }

  const inspectResult = await commandRunner({
    args: [config.dockerCompose.command, "inspect", ...ids],
    ...(cwd ? { cwd } : {})
  });
  if (inspectResult.code !== 0) {
    throw new Error(inspectResult.stderr.trim() || inspectResult.stdout.trim() || "failed to inspect docker compose containers");
  }

  const inspected = JSON.parse(inspectResult.stdout) as Array<{
    Id: string;
    Name?: string | undefined;
    State?: {
      Running?: boolean | undefined;
    } | undefined;
  }>;

  return inspected
    .map((entry) => ({
      id: entry.Id,
      name: entry.Name?.replace(/^\/+/u, "") ?? entry.Id,
      running: entry.State?.Running === true
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createDockerComposeWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  options?: {
    command?: DockerComposeCommandFn | undefined;
  }
): WorkerReplicaTarget {
  const commandRunner = options?.command ?? defaultDockerComposeCommand;

  return {
    kind: "docker_compose",
    async reconcile(input) {
      const containers = await listManagedDockerComposeContainers(config, commandRunner);
      const runningContainers = containers.filter((container) => container.running);

      if (!config.allowScaleDown && input.desiredReplicas < runningContainers.length) {
        return {
          kind: "docker_compose",
          attempted: true,
          applied: false,
          desiredReplicas: input.desiredReplicas,
          observedReplicas: runningContainers.length,
          appliedReplicas: runningContainers.length,
          outcome: "blocked_scale_down",
          at: input.timestamp,
          phase: "blocked",
          reasonCode: "scale_down_disabled",
          targetRef: {
            platform: "docker_compose",
            kind: "service",
            name: config.dockerCompose.service
          },
          message: "scale down blocked by controller policy"
        };
      }

      if (input.desiredReplicas === runningContainers.length) {
        return {
          kind: "docker_compose",
          attempted: true,
          applied: false,
          desiredReplicas: input.desiredReplicas,
          observedReplicas: runningContainers.length,
          appliedReplicas: runningContainers.length,
          outcome: "steady",
          at: input.timestamp,
          phase: "steady",
          targetRef: {
            platform: "docker_compose",
            kind: "service",
            name: config.dockerCompose.service
          }
        };
      }

      const cwd = composeTargetCwd(config);
      const result = await commandRunner({
        args: composeArgs(config, [
          "up",
          "-d",
          "--no-deps",
          "--scale",
          `${config.dockerCompose.service}=${input.desiredReplicas}`,
          config.dockerCompose.service
        ]),
        ...(cwd ? { cwd } : {})
      });

      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "docker compose reconcile failed");
      }

      return {
        kind: "docker_compose",
        attempted: true,
        applied: true,
        desiredReplicas: input.desiredReplicas,
        observedReplicas: runningContainers.length,
        appliedReplicas: input.desiredReplicas,
        outcome: "scaled",
        at: input.timestamp,
        phase: "accepted",
        reasonCode: "scale_request_accepted",
        targetRef: {
          platform: "docker_compose",
          kind: "service",
          name: config.dockerCompose.service
        },
        ...(result.stdout.trim() ? { message: result.stdout.trim() } : {})
      };
    }
  };
}

export function createRemoteDockerComposeWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  options?: {
    httpRequest?: JsonHttpRequestFn | undefined;
  }
): WorkerReplicaTarget {
  const remote = config.dockerCompose.remote;
  if (!remote) {
    throw new Error("remote docker compose scale target requires endpoint.");
  }

  const httpRequest = options?.httpRequest ?? defaultJsonHttpRequest;

  return {
    kind: "docker_compose",
    async reconcile(input) {
      const url = new URL("/reconcile", appendTrailingSlash(remote.endpoint)).toString();
      const response = await httpRequest({
        url,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(remote.authToken ? { authorization: `Bearer ${remote.authToken}` } : {})
        },
        body: JSON.stringify({
          input,
          allowScaleDown: config.allowScaleDown
        } satisfies DockerComposeRemoteReconcileRequest),
        timeoutMs: remote.timeoutMs
      });
      assertHttpSuccess("docker compose remote reconcile", response);

      if (!response.body || typeof response.body !== "object") {
        throw new Error("docker compose remote reconcile returned an invalid JSON body.");
      }

      return response.body as WorkerReplicaTargetResult;
    }
  };
}

function buildKubernetesDeploymentScaleUrl(input: {
  apiUrl: string;
  namespace: string;
  deployment: string;
}): string {
  return new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/deployments/${encodeURIComponent(input.deployment)}/scale`,
    appendTrailingSlash(input.apiUrl)
  ).toString();
}

function buildKubernetesDeploymentUrl(input: {
  apiUrl: string;
  namespace: string;
  deployment: string;
}): string {
  return new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/deployments/${encodeURIComponent(input.deployment)}`,
    appendTrailingSlash(input.apiUrl)
  ).toString();
}

async function readKubernetesDeploymentState(
  input: {
    apiUrl: string;
    namespace: string;
    deployment: string;
    headers: Record<string, string>;
    caFile?: string | undefined;
    skipTlsVerify: boolean;
  },
  request: KubernetesJsonRequestFn,
  stage: "read_state" | "observe_rollout"
): Promise<KubernetesDeploymentObservation> {
  const response = await request({
    url: buildKubernetesDeploymentUrl(input),
    method: "GET",
    headers: {
      ...input.headers,
      accept: "application/json"
    },
    caFile: input.caFile,
    skipTlsVerify: input.skipTlsVerify
  });
  assertKubernetesSuccess("read deployment state", response, stage);
  return parseKubernetesDeploymentObservation(response.body);
}

async function discoverKubernetesDeploymentName(
  input: {
    namespace: string;
    labelSelector: string;
    apiUrl: string;
    tokenFile: string;
    caFile?: string | undefined;
    skipTlsVerify: boolean;
  },
  request: KubernetesJsonRequestFn
): Promise<string> {
  const authHeaders = await buildKubernetesAuthHeaders(input.tokenFile);
  const deploymentsUrl = new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/deployments`,
    appendTrailingSlash(input.apiUrl)
  );
  deploymentsUrl.searchParams.set("labelSelector", input.labelSelector);

  const response = await request({
    url: deploymentsUrl.toString(),
    method: "GET",
    headers: {
      ...authHeaders,
      accept: "application/json"
    },
    caFile: input.caFile,
    skipTlsVerify: input.skipTlsVerify
  });
  assertKubernetesSuccess("discover target deployment", response, "discover_target");
  const deploymentNames = extractDeploymentNames(response.body);
  if (deploymentNames.length === 0) {
    throw new KubernetesReplicaTargetError({
      message: `no deployment matched label selector ${input.labelSelector}`,
      code: "selector_no_match",
      stage: "discover_target"
    });
  }
  if (deploymentNames.length > 1) {
    throw new KubernetesReplicaTargetError({
      message: `label selector ${input.labelSelector} matched multiple deployments: ${deploymentNames.join(", ")}`,
      code: "selector_multiple_matches",
      stage: "discover_target"
    });
  }

  return deploymentNames[0]!;
}

async function buildKubernetesAuthHeaders(tokenFile: string): Promise<Record<string, string>> {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) {
    throw new Error(`Kubernetes service account token file is empty: ${tokenFile}`);
  }

  return {
    authorization: `Bearer ${token}`
  };
}

function appendTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseReplicas(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const spec = Reflect.get(payload, "spec");
  if (!spec || typeof spec !== "object") {
    return undefined;
  }

  const replicas = Reflect.get(spec, "replicas");
  return typeof replicas === "number" && Number.isFinite(replicas) ? replicas : undefined;
}

function readNestedNumber(payload: unknown, pathSegments: string[]): number | undefined {
  let current: unknown = payload;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function parseKubernetesDeploymentObservation(payload: unknown): KubernetesDeploymentObservation {
  return {
    specReplicas: readNestedNumber(payload, ["spec", "replicas"]),
    statusReplicas: readNestedNumber(payload, ["status", "replicas"]),
    readyReplicas: readNestedNumber(payload, ["status", "readyReplicas"]),
    updatedReplicas: readNestedNumber(payload, ["status", "updatedReplicas"]),
    availableReplicas: readNestedNumber(payload, ["status", "availableReplicas"]),
    unavailableReplicas: readNestedNumber(payload, ["status", "unavailableReplicas"]),
    generation: readNestedNumber(payload, ["metadata", "generation"]),
    observedGeneration: readNestedNumber(payload, ["status", "observedGeneration"])
  };
}

function isKubernetesDeploymentReady(
  observation: KubernetesDeploymentObservation | undefined,
  desiredReplicas: number
): boolean {
  if (!observation) {
    return false;
  }

  const desired = Math.max(0, desiredReplicas);
  const specReplicas = observation.specReplicas;
  if (typeof specReplicas === "number" && specReplicas !== desired) {
    return false;
  }

  const generationConverged =
    typeof observation.generation !== "number" ||
    typeof observation.observedGeneration !== "number" ||
    observation.observedGeneration >= observation.generation;
  if (!generationConverged) {
    return false;
  }

  const readyReplicas = observation.readyReplicas ?? 0;
  const updatedReplicas = observation.updatedReplicas ?? desired;
  const availableReplicas = observation.availableReplicas ?? readyReplicas;
  const unavailableReplicas = observation.unavailableReplicas ?? Math.max(0, desired - availableReplicas);

  if (desired === 0) {
    return readyReplicas === 0 && availableReplicas === 0 && unavailableReplicas === 0;
  }

  return readyReplicas >= desired && updatedReplicas >= desired && availableReplicas >= desired && unavailableReplicas === 0;
}

function buildKubernetesResult(input: {
  input: WorkerReplicaTargetInput;
  targetRef: WorkerReplicaTargetRef;
  attempted: boolean;
  applied: boolean;
  observedReplicas?: number | undefined;
  appliedReplicas?: number | undefined;
  outcome: WorkerReplicaTargetOutcome;
  phase: WorkerReplicaTargetPhase;
  stage?: "discover_target" | "read_state" | "apply_scale" | "observe_rollout" | undefined;
  reasonCode?: string | undefined;
  message?: string | undefined;
  observedState?: KubernetesDeploymentObservation | undefined;
}): WorkerReplicaTargetResult {
  return {
    kind: "kubernetes",
    attempted: input.attempted,
    applied: input.applied,
    desiredReplicas: input.input.desiredReplicas,
    ...(typeof input.observedReplicas === "number" ? { observedReplicas: input.observedReplicas } : {}),
    ...(typeof input.appliedReplicas === "number" ? { appliedReplicas: input.appliedReplicas } : {}),
    outcome: input.outcome,
    at: input.input.timestamp,
    phase: input.phase,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    targetRef: input.targetRef,
    ...(typeof input.observedState?.generation === "number" ? { generation: input.observedState.generation } : {}),
    ...(typeof input.observedState?.observedGeneration === "number"
      ? { observedGeneration: input.observedState.observedGeneration }
      : {}),
    ...(typeof input.observedState?.readyReplicas === "number" ? { readyReplicas: input.observedState.readyReplicas } : {}),
    ...(typeof input.observedState?.updatedReplicas === "number"
      ? { updatedReplicas: input.observedState.updatedReplicas }
      : {}),
    ...(typeof input.observedState?.availableReplicas === "number"
      ? { availableReplicas: input.observedState.availableReplicas }
      : {}),
    ...(typeof input.observedState?.unavailableReplicas === "number"
      ? { unavailableReplicas: input.observedState.unavailableReplicas }
      : {}),
    ...(input.message ? { message: input.message } : {})
  };
}

function buildKubernetesErrorResult(input: {
  input: WorkerReplicaTargetInput;
  error: unknown;
  targetRef?: WorkerReplicaTargetRef | undefined;
  observedReplicas?: number | undefined;
  observedState?: KubernetesDeploymentObservation | undefined;
}): WorkerReplicaTargetResult {
  const classified = input.error instanceof KubernetesReplicaTargetError ? input.error : classifyKubernetesError(input.error);

  return {
    kind: "kubernetes",
    attempted: true,
    applied: false,
    desiredReplicas: input.input.desiredReplicas,
    ...(typeof input.observedReplicas === "number" ? { observedReplicas: input.observedReplicas } : {}),
    outcome: "error",
    at: input.input.timestamp,
    phase: "error",
    stage: classified.stage,
    reasonCode: classified.code,
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    ...(typeof input.observedState?.generation === "number" ? { generation: input.observedState.generation } : {}),
    ...(typeof input.observedState?.observedGeneration === "number"
      ? { observedGeneration: input.observedState.observedGeneration }
      : {}),
    ...(typeof input.observedState?.readyReplicas === "number" ? { readyReplicas: input.observedState.readyReplicas } : {}),
    ...(typeof input.observedState?.updatedReplicas === "number"
      ? { updatedReplicas: input.observedState.updatedReplicas }
      : {}),
    ...(typeof input.observedState?.availableReplicas === "number"
      ? { availableReplicas: input.observedState.availableReplicas }
      : {}),
    ...(typeof input.observedState?.unavailableReplicas === "number"
      ? { unavailableReplicas: input.observedState.unavailableReplicas }
      : {}),
    message: classified.message
  };
}

function extractDeploymentNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const items = Reflect.get(payload, "items");
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const metadata = Reflect.get(item, "metadata");
      if (!metadata || typeof metadata !== "object") {
        return undefined;
      }
      const name = Reflect.get(metadata, "name");
      return typeof name === "string" && name.trim().length > 0 ? name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

function assertKubernetesSuccess(
  operation: string,
  response: {
    status: number;
    body: unknown;
    text: string;
  },
  stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout"
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractStatusMessage(response.body) ?? (response.text.trim() || `${operation} failed with status ${response.status}`);
  throw new KubernetesReplicaTargetError({
    message: `${operation} failed with status ${response.status}: ${message}`,
    code: classifyKubernetesStatusCode(response.status),
    stage,
    status: response.status
  });
}

function assertHttpSuccess(
  operation: string,
  response: {
    status: number;
    body: unknown;
    text: string;
  }
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractStatusMessage(response.body) ?? (response.text.trim() || `${operation} failed with status ${response.status}`);
  throw new Error(`${operation} failed with status ${response.status}: ${message}`);
}

function extractStatusMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const error = Reflect.get(body, "error");
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  const message = Reflect.get(body, "message");
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

function classifyKubernetesStatusCode(status: number): string {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "api_unavailable";
  }
  if (status >= 400) {
    return "invalid_request";
  }
  return "unexpected_status";
}

function classifyKubernetesError(error: unknown): KubernetesReplicaTargetError {
  if (error instanceof KubernetesReplicaTargetError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message) || /timeout/iu.test(message) || /abort/iu.test(message)) {
    return new KubernetesReplicaTargetError({
      message,
      code: "timeout",
      stage: "read_state"
    });
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/iu.test(message)) {
    return new KubernetesReplicaTargetError({
      message,
      code: "network_error",
      stage: "read_state"
    });
  }

  return new KubernetesReplicaTargetError({
    message,
    code: "unexpected_error",
    stage: "read_state"
  });
}

export async function defaultKubernetesJsonRequest(
  input: KubernetesJsonRequest
): Promise<{
  status: number;
  body: unknown;
  text: string;
}> {
  return defaultJsonHttpRequest(input);
}

export async function defaultJsonHttpRequest(
  input: JsonHttpRequest
): Promise<{
  status: number;
  body: unknown;
  text: string;
}> {
  const url = new URL(input.url);
  const transport = url.protocol === "https:" ? https : http;
  const ca = input.caFile ? await readFile(input.caFile, "utf8") : undefined;

  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        ...(url.protocol === "https:"
          ? {
              ca,
              rejectUnauthorized: input.skipTlsVerify ? false : true
            }
          : {})
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(input.timeoutMs ?? 0, () => {
      request.destroy(new Error(`request timed out after ${input.timeoutMs}ms`));
    });
    if (input.body) {
      request.write(input.body);
    }
    request.end();
  });

  const body = text.trim().length > 0 ? tryParseJson(text) : undefined;

  return {
    status,
    body,
    text
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
