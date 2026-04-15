import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";

import type { ServerConfig } from "@oah/config";

export type WorkerReplicaTargetOutcome = "disabled" | "steady" | "scaled" | "blocked_scale_down" | "error";

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
  message?: string | undefined;
}

export interface WorkerReplicaTarget {
  readonly kind: string;
  reconcile(input: WorkerReplicaTargetInput): Promise<WorkerReplicaTargetResult>;
  close?(): Promise<void>;
}

interface ControllerScaleTargetConfigShape {
  type?: "noop" | "kubernetes" | undefined;
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
    };

export interface KubernetesJsonRequest {
  url: string;
  method: "GET" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
}

export type KubernetesJsonRequestFn = (
  input: KubernetesJsonRequest
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

function resolveKubernetesApiUrl(raw?: string | undefined): string | undefined {
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }

  const host = readStringEnv("KUBERNETES_SERVICE_HOST");
  const port =
    readStringEnv("KUBERNETES_SERVICE_PORT_HTTPS") ??
    readStringEnv("KUBERNETES_SERVICE_PORT") ??
    undefined;
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
  const targetType = targetTypeRaw === "kubernetes" ? "kubernetes" : "noop";
  const allowScaleDown = readBoolEnv("OAH_CONTROLLER_ALLOW_SCALE_DOWN", scaleTarget?.allow_scale_down ?? true);

  if (targetType === "noop") {
    return {
      type: "noop",
      allowScaleDown
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
      caFile,
      skipTlsVerify
    }
  };
}

export function createWorkerReplicaTarget(
  config: ResolvedWorkerReplicaTargetConfig,
  options?: {
    request?: KubernetesJsonRequestFn | undefined;
  }
): WorkerReplicaTarget {
  if (config.type === "kubernetes") {
    return createKubernetesWorkerReplicaTarget(config, options);
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
      const scaleUrl = buildKubernetesDeploymentScaleUrl({
        apiUrl: config.kubernetes.apiUrl,
        namespace: config.kubernetes.namespace,
        deployment: deploymentName
      });
      const authHeaders = await buildKubernetesAuthHeaders(config.kubernetes.tokenFile);
      const getResponse = await request({
        url: scaleUrl,
        method: "GET",
        headers: {
          ...authHeaders,
          accept: "application/json"
        },
        caFile: config.kubernetes.caFile,
        skipTlsVerify: config.kubernetes.skipTlsVerify
      });
      assertKubernetesSuccess("read deployment scale", getResponse);
      const observedReplicas = parseReplicas(getResponse.body);
      if (typeof observedReplicas === "number") {
        if (!config.allowScaleDown && input.desiredReplicas < observedReplicas) {
          return {
            kind: "kubernetes",
            attempted: true,
            applied: false,
            desiredReplicas: input.desiredReplicas,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "blocked_scale_down",
            at: input.timestamp,
            message: "scale down blocked by controller policy"
          };
        }

        if (input.desiredReplicas === observedReplicas) {
          return {
            kind: "kubernetes",
            attempted: true,
            applied: false,
            desiredReplicas: input.desiredReplicas,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "steady",
            at: input.timestamp
          };
        }
      }

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
      assertKubernetesSuccess("patch deployment scale", patchResponse);
      const appliedReplicas = parseReplicas(patchResponse.body) ?? input.desiredReplicas;

      return {
        kind: "kubernetes",
        attempted: true,
        applied: true,
        desiredReplicas: input.desiredReplicas,
        observedReplicas,
        appliedReplicas,
        outcome: "scaled",
        at: input.timestamp
      };
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
  assertKubernetesSuccess("discover target deployment", response);
  const deploymentNames = extractDeploymentNames(response.body);
  if (deploymentNames.length === 0) {
    throw new Error(`no deployment matched label selector ${input.labelSelector}`);
  }
  if (deploymentNames.length > 1) {
    throw new Error(
      `label selector ${input.labelSelector} matched multiple deployments: ${deploymentNames.join(", ")}`
    );
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
  }
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractKubernetesStatusMessage(response.body) ??
    response.text.trim() ??
    `${operation} failed with status ${response.status}`;
  throw new Error(`${operation} failed with status ${response.status}: ${message}`);
}

function extractKubernetesStatusMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const message = Reflect.get(body, "message");
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

export async function defaultKubernetesJsonRequest(
  input: KubernetesJsonRequest
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
