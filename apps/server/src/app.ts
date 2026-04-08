import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import YAML from "yaml";
import {
  cancelRunAcceptedSchema,
  createWorkspaceDirectoryRequestSchema,
  createActionRunRequestSchema,
  createMessageRequestSchema,
  createSessionRequestSchema,
  createWorkspaceRequestSchema,
  errorResponseSchema,
  messageAcceptedSchema,
  modelGenerateRequestSchema,
  modelGenerateResponseSchema,
  platformModelListSchema,
  modelProviderListSchema,
  pageQuerySchema,
  putWorkspaceFileRequestSchema,
  runPageSchema,
  storageOverviewSchema,
  storagePostgresTableNameSchema,
  storagePostgresTablePageSchema,
  storageRedisDeleteKeyResponseSchema,
  storageRedisDeleteKeysRequestSchema,
  storageRedisDeleteKeysResponseSchema,
  storageRedisKeyDetailSchema,
  storageRedisKeyPageSchema,
  storageRedisKeyQuerySchema,
  storageRedisKeysQuerySchema,
  storageRedisMaintenanceRequestSchema,
  storageRedisMaintenanceResponseSchema,
  storageTableQuerySchema,
  runEventsQuerySchema,
  runStepPageSchema,
  sessionPageSchema,
  updateSessionRequestSchema,
  workspaceDeleteEntryQuerySchema,
  workspaceDeleteResultSchema,
  workspaceEntriesQuerySchema,
  workspaceEntryPageSchema,
  workspaceEntryPathQuerySchema,
  workspaceEntrySchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentSchema,
  workspaceFileUploadQuerySchema,
  workspaceHistoryMirrorStatusSchema,
  workspacePageSchema,
  workspaceTemplateListSchema,
  moveWorkspaceEntryRequestSchema
} from "@oah/api-contracts";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-gateway";
import type { CallerContext, ModelGateway, RuntimeService, SessionEvent, WorkspaceRecord } from "@oah/runtime-core";
import { AppError, isAppError } from "@oah/runtime-core";
import { inspectHistoryMirrorStatus, type HistoryMirrorStatus } from "./history-mirror.js";
import type { StorageAdmin } from "./storage-admin.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const openApiSpecPath = path.join(repoRoot, "docs", "openapi", "openapi.yaml");

declare module "fastify" {
  interface FastifyRequest {
    callerContext?: CallerContext;
  }
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.status(statusCode).send(
    errorResponseSchema.parse({
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    })
  );
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getRequestOrigin(request: FastifyRequest): string {
  const host = request.headers.host?.trim() || "localhost";
  return `${request.protocol}://${host}`;
}

async function loadOpenApiSpec(origin: string): Promise<string> {
  const raw = await readFile(openApiSpecPath, "utf8");
  return raw.replace(
    /servers:\n\s+- url:\s+.+?\n\s+description:\s+.+?\n/u,
    `servers:\n  - url: ${origin}/api/v1\n    description: Current server\n`
  );
}

async function loadOpenApiDocument(origin: string): Promise<Record<string, unknown>> {
  return YAML.parse(await loadOpenApiSpec(origin)) as Record<string, unknown>;
}

function buildApiIndex(request: FastifyRequest) {
  const origin = getRequestOrigin(request);
  const groups = {
    workspaces: {
      description: "Create, import, inspect, and enumerate workspaces exposed by this server.",
      routes: [
        "GET /api/v1/workspaces",
        "POST /api/v1/workspaces",
        "POST /api/v1/workspaces/import",
        "GET /api/v1/workspace-templates"
      ]
    },
    sessions: {
      description: "Create sessions inside workspaces and manage session-level metadata.",
      routes: [
        "POST /api/v1/workspaces/{workspaceId}/sessions",
        "GET /api/v1/workspaces/{workspaceId}/sessions",
        "GET /api/v1/sessions/{sessionId}",
        "PATCH /api/v1/sessions/{sessionId}",
        "DELETE /api/v1/sessions/{sessionId}"
      ]
    },
    messagesAndRuns: {
      description: "Send messages, inspect run state, follow run steps, and cancel active work.",
      routes: [
        "POST /api/v1/sessions/{sessionId}/messages",
        "GET /api/v1/sessions/{sessionId}/messages",
        "GET /api/v1/sessions/{sessionId}/runs",
        "GET /api/v1/sessions/{sessionId}/events",
        "GET /api/v1/runs/{runId}",
        "GET /api/v1/runs/{runId}/steps",
        "POST /api/v1/runs/{runId}/cancel"
      ]
    },
    filesAndCatalog: {
      description: "Browse workspace files, read or mutate content, and inspect discovered catalog state.",
      routes: [
        "GET /api/v1/workspaces/{workspaceId}/catalog",
        "GET /api/v1/workspaces/{workspaceId}/entries",
        "GET /api/v1/workspaces/{workspaceId}/files/content",
        "PUT /api/v1/workspaces/{workspaceId}/files/content",
        "PUT /api/v1/workspaces/{workspaceId}/files/upload",
        "GET /api/v1/workspaces/{workspaceId}/files/download",
        "POST /api/v1/workspaces/{workspaceId}/directories",
        "DELETE /api/v1/workspaces/{workspaceId}/entries",
        "PATCH /api/v1/workspaces/{workspaceId}/entries/move"
      ]
    },
    mirrorAndModels: {
      description: "Inspect local history mirror health and discover model/provider configuration.",
      routes: [
        "GET /api/v1/workspaces/{workspaceId}/history-mirror",
        "POST /api/v1/workspaces/{workspaceId}/history-mirror/rebuild",
        "GET /api/v1/model-providers",
        "GET /api/v1/platform-models"
      ]
    }
  };

  return {
    name: "Open Agent Harness API",
    docs: {
      landingPage: `${origin}/`,
      docsPage: `${origin}/docs`,
      openapiYaml: `${origin}/openapi.yaml`,
      openapiJson: `${origin}/openapi.json`
    },
    probes: {
      healthz: `${origin}/healthz`,
      readyz: `${origin}/readyz`
    },
    auth: {
      apiPrefix: "/api/v1",
      standaloneBehavior: "When no external caller-context resolver is configured, /api/v1 requests run as standalone:anonymous.",
      hostedBehavior: "When an external caller-context resolver is configured, clients must present caller context through the host integration."
    },
    entrypoints: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.routes])),
    groups
  };
}

function buildDeveloperLandingHtml(request: FastifyRequest): string {
  const origin = getRequestOrigin(request);
  const apiIndex = `${origin}/api/v1`;
  const docsPage = `${origin}/docs`;
  const openApiYaml = `${origin}/openapi.yaml`;
  const openApiJson = `${origin}/openapi.json`;
  const healthz = `${origin}/healthz`;
  const readyz = `${origin}/readyz`;
  const sampleWorkspaceList = `${origin}/api/v1/workspaces?pageSize=20`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Agent Harness</title>
    <style>
      :root {
        color-scheme: light;
        --background: hsl(0 0% 94%);
        --foreground: hsl(0 0% 9%);
        --muted-foreground: hsl(0 0% 38%);
        --border: hsl(0 0% 82%);
        --muted: hsl(0 0% 91.2%);
        --card: hsl(0 0% 98.8%);
        --app-shell-background: #e7e7e3;
        --app-shell-gradient:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.65), transparent 30%),
          radial-gradient(circle at top right, rgba(255, 255, 255, 0.45), transparent 24%),
          linear-gradient(180deg, #ebebe7 0%, #ddddda 100%);
        --pane-background: linear-gradient(180deg, rgba(255, 255, 253, 0.88) 0%, rgba(249, 249, 246, 0.96) 100%);
        --pane-border: rgba(17, 17, 17, 0.08);
        --pane-shadow: rgba(17, 17, 17, 0.22);
        --code: #f2ede3;
        --code-border: rgba(17, 17, 17, 0.08);
        --pill: rgba(255, 255, 255, 0.75);
        --pill-hover: rgba(255, 255, 255, 0.92);
        --accent-strong: #111214;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11";
        background-color: var(--app-shell-background);
        background-image: var(--app-shell-gradient);
        color: var(--foreground);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        letter-spacing: -0.01em;
      }
      main {
        position: relative;
        max-width: 1040px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      .hero, .panel {
        position: relative;
        overflow: hidden;
        border: 1px solid var(--pane-border);
        border-radius: 16px;
        background: var(--pane-background);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74), 0 18px 40px -34px rgba(17, 17, 17, 0.24);
        animation: rise-in 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .hero {
        padding: 28px;
        min-height: 260px;
      }
      .hero::before,
      .panel::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.52), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 40%);
        pointer-events: none;
      }
      .hero > *,
      .panel > * {
        position: relative;
        z-index: 1;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 11px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--foreground) 9%, transparent);
        background: var(--pill);
        color: rgba(20, 20, 20, 0.76);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      h1 {
        max-width: 760px;
        margin: 18px 0 12px;
        font-size: clamp(32px, 6vw, 52px);
        line-height: 1.02;
        letter-spacing: -0.045em;
        text-wrap: balance;
      }
      p {
        margin: 0;
        color: var(--muted-foreground);
        line-height: 1.7;
      }
      .grid {
        display: grid;
        gap: 16px;
        margin-top: 22px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      }
      .panel {
        padding: 22px;
      }
      .panel h2 {
        margin: 0 0 10px;
        font-size: 17px;
        letter-spacing: -0.03em;
      }
      ul {
        margin: 12px 0 0;
        padding-left: 18px;
        color: var(--muted-foreground);
      }
      li + li {
        margin-top: 8px;
      }
      a {
        color: var(--accent-strong);
      }
      code, pre {
        font-family: "SFMono-Regular", "Consolas", monospace;
      }
      code {
        background: var(--code);
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--code-border);
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      pre {
        margin: 12px 0 0;
        padding: 14px;
        border-radius: 16px;
        overflow-x: auto;
        background: var(--code);
        border: 1px solid var(--code-border);
        color: var(--foreground);
        line-height: 1.6;
      }
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }
      .links a {
        text-decoration: none;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        background: var(--pill);
        color: var(--foreground);
        padding: 10px 14px;
        border-radius: 999px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82), 0 10px 18px -16px rgba(17, 17, 17, 0.28);
        transition:
          transform 180ms ease,
          background-color 180ms ease,
          border-color 180ms ease;
      }
      .links a:hover {
        background: var(--pill-hover);
        border-color: color-mix(in srgb, var(--foreground) 11%, transparent);
        transform: translateY(-1px);
      }
      .lede {
        max-width: 680px;
        font-size: 15px;
      }
      .surface-kicker {
        margin-bottom: 8px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 18px;
      }
      .info-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 11px;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        border-radius: 999px;
        background: var(--pill);
        color: var(--foreground);
        font-size: 12px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .panel-muted {
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.46);
      }
      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .stat {
        padding: 12px 13px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
        background: rgba(255, 255, 255, 0.48);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .stat-label {
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      .stat-value {
        margin-top: 6px;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.03em;
      }
      .card-grid {
        display: grid;
        gap: 12px;
        margin-top: 14px;
      }
      .card-grid.three {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .subcard {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--foreground) 7%, transparent);
        background: rgba(255, 255, 255, 0.34);
      }
      .subcard h3 {
        margin: 0 0 8px;
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .subcard p {
        font-size: 14px;
      }
      .subcard li {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .subcard ul {
        margin-top: 10px;
      }
      .route-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }
      .route-list li + li {
        margin-top: 8px;
      }
      .route-list code {
        display: inline-block;
        min-width: 220px;
      }
      @keyframes rise-in {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @media (max-width: 640px) {
        main {
          padding: 18px 14px 34px;
        }
        .hero,
        .panel {
          border-radius: 14px;
        }
        .hero {
          padding: 20px;
        }
        .panel {
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">Developer Entry</span>
        <p class="surface-kicker">OpenAgentHarness / Runtime Endpoint</p>
        <h1>Open Agent Harness is listening.</h1>
        <p class="lede">
          This server exposes a headless agent runtime over HTTP. Start here, then use the OpenAPI spec or the API index to
          explore the surface area on your own.
        </p>
        <div class="meta-row">
          <span class="info-chip">Theme: runtime workbench</span>
          <span class="info-chip">Surface: developer entry</span>
          <span class="info-chip">Base URL: ${escapeHtml(origin)}</span>
        </div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Primary Prefix</div>
            <div class="stat-value">/api/v1</div>
          </div>
          <div class="stat">
            <div class="stat-label">API Spec</div>
            <div class="stat-value">OpenAPI 3.1</div>
          </div>
          <div class="stat">
            <div class="stat-label">Realtime</div>
            <div class="stat-value">SSE Events</div>
          </div>
          <div class="stat">
            <div class="stat-label">Files</div>
            <div class="stat-value">Workspace I/O</div>
          </div>
        </div>
        <div class="links">
          <a href="${escapeHtml(docsPage)}">Open Docs</a>
          <a href="${escapeHtml(openApiYaml)}">OpenAPI YAML</a>
          <a href="${escapeHtml(openApiJson)}">OpenAPI JSON</a>
          <a href="${escapeHtml(apiIndex)}">API Index</a>
          <a href="${escapeHtml(healthz)}">Health</a>
          <a href="${escapeHtml(readyz)}">Readiness</a>
        </div>
      </section>

      <div class="grid two">
        <section class="panel">
          <p class="panel-muted">Start Here</p>
          <h2>What To Open</h2>
          <ul>
            <li><a href="${escapeHtml(docsPage)}">${escapeHtml(docsPage)}</a> for a human-readable quickstart.</li>
            <li><a href="${escapeHtml(openApiYaml)}">${escapeHtml(openApiYaml)}</a> for the raw OpenAPI document.</li>
            <li><a href="${escapeHtml(openApiJson)}">${escapeHtml(openApiJson)}</a> for direct import into API clients and tooling.</li>
            <li><a href="${escapeHtml(apiIndex)}">${escapeHtml(apiIndex)}</a> for a machine-readable route index.</li>
          </ul>
        </section>

        <section class="panel">
          <p class="panel-muted">Probe The Server</p>
          <h2>First Calls</h2>
          <ul>
            <li><code>GET /healthz</code> and <code>GET /readyz</code> to verify the process and dependencies.</li>
            <li><code>GET /api/v1/workspaces</code> to inspect available workspaces.</li>
            <li><code>GET /api/v1/model-providers</code> and <code>GET /api/v1/platform-models</code> to inspect model configuration.</li>
          </ul>
        </section>
      </div>

      <section class="panel" style="margin-top: 18px;">
        <p class="panel-muted">Use Directly</p>
        <h2>Quick Probe</h2>
        <p>If this server is running in standalone mode, many <code>/api/v1</code> requests work immediately as <code>standalone:anonymous</code>.</p>
        <pre>curl ${escapeHtml(JSON.stringify(sampleWorkspaceList))}
curl ${escapeHtml(JSON.stringify(openApiYaml))}
curl ${escapeHtml(JSON.stringify(openApiJson))}
curl ${escapeHtml(JSON.stringify(apiIndex))}</pre>
      </section>

      <section class="panel" style="margin-top: 18px;">
        <p class="panel-muted">Common Workflows</p>
        <h2>Choose A Task, Then Follow The Matching Surface</h2>
        <div class="card-grid three">
          <article class="subcard">
            <h3>Inspect Runtime State</h3>
            <p>Start with health, workspace list, session list, then drill into messages and runs.</p>
            <ul>
              <li><code>GET /healthz</code></li>
              <li><code>GET /api/v1/workspaces</code></li>
              <li><code>GET /api/v1/workspaces/{workspaceId}/sessions</code></li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Send Work Into A Session</h3>
            <p>Create a session, post a message, then follow run state and event streaming.</p>
            <ul>
              <li><code>POST /api/v1/workspaces/{workspaceId}/sessions</code></li>
              <li><code>POST /api/v1/sessions/{sessionId}/messages</code></li>
              <li><code>GET /api/v1/sessions/{sessionId}/events</code></li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Work With Files</h3>
            <p>Browse, read, write, upload, download, or move entries inside a workspace root.</p>
            <ul>
              <li><code>GET /api/v1/workspaces/{workspaceId}/entries</code></li>
              <li><code>GET /api/v1/workspaces/{workspaceId}/files/content</code></li>
              <li><code>PUT /api/v1/workspaces/{workspaceId}/files/upload</code></li>
            </ul>
          </article>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function buildDeveloperDocsHtml(request: FastifyRequest): string {
  const origin = getRequestOrigin(request);
  const apiIndex = `${origin}/api/v1`;
  const openApiYaml = `${origin}/openapi.yaml`;
  const openApiJson = `${origin}/openapi.json`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Agent Harness Docs</title>
    <style>
      :root {
        color-scheme: light;
        --foreground: hsl(0 0% 9%);
        --muted-foreground: hsl(0 0% 38%);
        --app-shell-background: #e7e7e3;
        --app-shell-gradient:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.65), transparent 30%),
          radial-gradient(circle at top right, rgba(255, 255, 255, 0.45), transparent 24%),
          linear-gradient(180deg, #ebebe7 0%, #ddddda 100%);
        --pane-background: linear-gradient(180deg, rgba(255, 255, 253, 0.88) 0%, rgba(249, 249, 246, 0.96) 100%);
        --pane-border: rgba(17, 17, 17, 0.08);
        --code: #f2ede3;
        --code-border: rgba(17, 17, 17, 0.08);
        --pill: rgba(255, 255, 255, 0.75);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11";
        background-color: var(--app-shell-background);
        background-image: var(--app-shell-gradient);
        color: var(--foreground);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        letter-spacing: -0.01em;
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      section {
        position: relative;
        overflow: hidden;
        background: var(--pane-background);
        border: 1px solid var(--pane-border);
        border-radius: 16px;
        padding: 22px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74), 0 18px 40px -34px rgba(17, 17, 17, 0.24);
        animation: rise-in 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      section::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.52), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 40%);
        pointer-events: none;
      }
      section > * {
        position: relative;
        z-index: 1;
      }
      section + section {
        margin-top: 16px;
      }
      h1, h2 {
        margin: 0 0 10px;
        letter-spacing: -0.04em;
      }
      p, li {
        color: var(--muted-foreground);
        line-height: 1.7;
      }
      code, pre {
        font-family: "SFMono-Regular", "Consolas", monospace;
      }
      code {
        background: var(--code);
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--code-border);
      }
      pre {
        margin: 12px 0 0;
        background: var(--code);
        padding: 14px;
        border-radius: 16px;
        overflow-x: auto;
        border: 1px solid var(--code-border);
      }
      .surface-kicker {
        margin-bottom: 8px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(20, 20, 20, 0.48);
      }
      a {
        color: #111214;
      }
      .link-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .link-row a {
        text-decoration: none;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--pill);
        border: 1px solid rgba(17, 17, 17, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
      .grid {
        display: grid;
        gap: 16px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .subcard {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(17, 17, 17, 0.07);
        background: rgba(255, 255, 255, 0.34);
      }
      .subcard h3 {
        margin: 0 0 8px;
        font-size: 15px;
        letter-spacing: -0.03em;
      }
      .subcard p, .subcard li {
        font-size: 14px;
      }
      .step-list {
        margin: 12px 0 0;
        padding-left: 18px;
      }
      .route-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }
      .route-list li + li {
        margin-top: 8px;
      }
      .route-list code {
        display: inline-block;
        min-width: 240px;
      }
      .callout {
        margin-top: 14px;
        padding: 13px 14px;
        border-radius: 14px;
        border: 1px solid rgba(17, 17, 17, 0.07);
        background: rgba(255, 255, 255, 0.42);
      }
      @keyframes rise-in {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @media (max-width: 640px) {
        main {
          padding: 18px 14px 34px;
        }
        section {
          padding: 18px;
          border-radius: 14px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <p class="surface-kicker">OpenAgentHarness / Docs</p>
        <h1>Developer Quickstart</h1>
        <p>
          Open Agent Harness serves its HTTP API under <code>/api/v1</code>. Use the API index and OpenAPI YAML below to inspect
          routes, payloads, and response shapes.
        </p>
        <div class="link-row">
          <a href="${escapeHtml(apiIndex)}">API Index</a>
          <a href="${escapeHtml(openApiYaml)}">OpenAPI YAML</a>
          <a href="${escapeHtml(openApiJson)}">OpenAPI JSON</a>
          <a href="${escapeHtml(origin)}/">Landing Page</a>
        </div>
        <div class="callout">
          Use this page when you want a short guided path. Use <code>/api/v1</code> when you want a machine-readable route index. Use
          <code>/openapi.yaml</code> or <code>/openapi.json</code> when you want schema-level detail in Postman, Insomnia, codegen, or your own tooling.
        </div>
      </section>

      <section>
        <p class="surface-kicker">Caller Context</p>
        <h2>How Auth Works</h2>
        <p>
          In standalone mode, <code>/api/v1</code> requests are handled as <code>standalone:anonymous</code>. In hosted mode, the
          upstream integration must attach caller context before requests reach this process.
        </p>
      </section>

      <section>
        <p class="surface-kicker">Three Minute Path</p>
        <h2>Start Here If You Are New</h2>
        <ol class="step-list">
          <li>Probe <code>/healthz</code> and <code>/readyz</code> to confirm the process and backing services are up.</li>
          <li>Read <code>/api/v1</code> to see the route families exposed by this concrete server.</li>
          <li>List workspaces with <code>GET /api/v1/workspaces</code>.</li>
          <li>Create or pick a session, then send a message with <code>POST /api/v1/sessions/{sessionId}/messages</code>.</li>
          <li>Follow live state over <code>GET /api/v1/sessions/{sessionId}/events</code>.</li>
        </ol>
      </section>

      <section>
        <p class="surface-kicker">By Job</p>
        <h2>Common Endpoint Groups</h2>
        <div class="grid two">
          <article class="subcard">
            <h3>Workspace Discovery</h3>
            <ul class="route-list">
              <li><code>GET /api/v1/workspaces</code> List visible workspaces</li>
              <li><code>GET /api/v1/workspace-templates</code> List templates</li>
              <li><code>POST /api/v1/workspaces</code> Create a managed workspace</li>
              <li><code>POST /api/v1/workspaces/import</code> Register an existing root</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Conversation Runtime</h3>
            <ul class="route-list">
              <li><code>POST /api/v1/workspaces/{workspaceId}/sessions</code> Create a session</li>
              <li><code>POST /api/v1/sessions/{sessionId}/messages</code> Queue a new user message</li>
              <li><code>GET /api/v1/sessions/{sessionId}/runs</code> Inspect runs</li>
              <li><code>GET /api/v1/runs/{runId}/steps</code> Inspect run steps</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Realtime Streaming</h3>
            <ul class="route-list">
              <li><code>GET /api/v1/sessions/{sessionId}/events</code> Session-scoped SSE stream</li>
              <li><code>?cursor=...</code> Resume after the last seen event</li>
              <li><code>?runId=...</code> Narrow the stream to one run</li>
            </ul>
          </article>
          <article class="subcard">
            <h3>Workspace Files</h3>
            <ul class="route-list">
              <li><code>GET /api/v1/workspaces/{workspaceId}/entries</code> List files</li>
              <li><code>GET /api/v1/workspaces/{workspaceId}/files/content</code> Read a file</li>
              <li><code>PUT /api/v1/workspaces/{workspaceId}/files/content</code> Write a file</li>
              <li><code>PUT /api/v1/workspaces/{workspaceId}/files/upload</code> Upload raw bytes</li>
            </ul>
          </article>
        </div>
      </section>

      <section>
        <p class="surface-kicker">Streaming Notes</p>
        <h2>Event Stream Expectations</h2>
        <div class="grid two">
          <article class="subcard">
            <h3>Transport</h3>
            <p>The event stream is Server-Sent Events. Expect <code>event:</code>, <code>data:</code>, and optional <code>id:</code> lines.</p>
          </article>
          <article class="subcard">
            <h3>Replay</h3>
            <p>Persist the latest cursor you receive, then reconnect with <code>?cursor=...</code> to continue from that point.</p>
          </article>
        </div>
      </section>

      <section>
        <p class="surface-kicker">Minimal Flow</p>
        <h2>Minimal Flow</h2>
        <pre>curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces?pageSize=20`))}
curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/model-providers`))}
curl ${escapeHtml(JSON.stringify(`${origin}/api/v1/platform-models`))}

# create a workspace
curl -X POST ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces`))} \\
  -H "content-type: application/json" \\
  -d '{"name":"demo","rootPath":"/tmp/demo","executionPolicy":"local"}'

# create a session in that workspace
curl -X POST ${escapeHtml(JSON.stringify(`${origin}/api/v1/workspaces/{workspaceId}/sessions`))} \\
  -H "content-type: application/json" \\
  -d '{}'</pre>
      </section>
    </main>
  </body>
</html>`;
}

function writeSseEvent(reply: FastifyReply, event: string, data: Record<string, unknown>, cursor?: string): void {
  if (cursor) {
    reply.raw.write(`id: ${cursor}\n`);
  }

  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function toCallerContext(request: FastifyRequest): CallerContext {
  if (!request.callerContext) {
    throw new AppError(401, "unauthorized", "Missing caller context.");
  }

  return request.callerContext;
}

function createStandaloneCallerContext(): CallerContext {
  return {
    subjectRef: "standalone:anonymous",
    authSource: "standalone_server",
    scopes: [],
    workspaceAccess: []
  };
}

export interface AppDependencies {
  runtimeService: {
    createWorkspace: RuntimeService["createWorkspace"];
    listWorkspaces: RuntimeService["listWorkspaces"];
    getWorkspace: RuntimeService["getWorkspace"];
    getWorkspaceRecord: RuntimeService["getWorkspaceRecord"];
    getWorkspaceCatalog: RuntimeService["getWorkspaceCatalog"];
    listWorkspaceEntries: (
      workspaceId: string,
      input: {
        path?: string | undefined;
        pageSize: number;
        cursor?: string | undefined;
        sortBy: "name" | "updatedAt" | "sizeBytes" | "type";
        sortOrder: "asc" | "desc";
      }
    ) => Promise<unknown>;
    getWorkspaceFileContent: (
      workspaceId: string,
      input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
    ) => Promise<unknown>;
    putWorkspaceFileContent: (
      workspaceId: string,
      input: {
        path: string;
        content: string;
        encoding: "utf8" | "base64";
        overwrite?: boolean | undefined;
        ifMatch?: string | undefined;
      }
    ) => Promise<unknown>;
    uploadWorkspaceFile: (
      workspaceId: string,
      input: {
        path: string;
        data: Buffer;
        overwrite?: boolean | undefined;
        ifMatch?: string | undefined;
      }
    ) => Promise<unknown>;
    getWorkspaceFileDownload: (
      workspaceId: string,
      targetPath: string
    ) => Promise<{ absolutePath: string; name: string; sizeBytes: number; mimeType?: string | undefined; etag: string; updatedAt: string }>;
    createWorkspaceDirectory: (
      workspaceId: string,
      input: { path: string; createParents: boolean }
    ) => Promise<unknown>;
    deleteWorkspaceEntry: (workspaceId: string, input: { path: string; recursive: boolean }) => Promise<unknown>;
    moveWorkspaceEntry: (
      workspaceId: string,
      input: { sourcePath: string; targetPath: string; overwrite: boolean }
    ) => Promise<unknown>;
    deleteWorkspace: RuntimeService["deleteWorkspace"];
    createSession: RuntimeService["createSession"];
    listWorkspaceSessions: RuntimeService["listWorkspaceSessions"];
    triggerActionRun: RuntimeService["triggerActionRun"];
    getSession: RuntimeService["getSession"];
    updateSession: RuntimeService["updateSession"];
    deleteSession: RuntimeService["deleteSession"];
    listSessionMessages: RuntimeService["listSessionMessages"];
    listSessionRuns: RuntimeService["listSessionRuns"];
    createSessionMessage: RuntimeService["createSessionMessage"];
    listSessionEvents: RuntimeService["listSessionEvents"];
    subscribeSessionEvents: RuntimeService["subscribeSessionEvents"];
    getRun: RuntimeService["getRun"];
    listRunSteps: RuntimeService["listRunSteps"];
    cancelRun: RuntimeService["cancelRun"];
  };
  modelGateway: ModelGateway;
  defaultModel: string;
  logger?: boolean;
  workspaceMode?: "multi" | "single";
  resolveCallerContext?: ((request: FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined) | undefined;
  listWorkspaceTemplates?: (() => Promise<import("@oah/config").WorkspaceTemplateDescriptor[]>) | undefined;
  listPlatformModels?: (() => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >) | undefined;
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project" | "chat";
    name?: string;
    externalRef?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  healthCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  readinessCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  getWorkspaceHistoryMirrorStatus?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  rebuildWorkspaceHistoryMirror?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  storageAdmin?: StorageAdmin;
}

export function createApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.logger ?? true
  });
  const hostOwnsCallerContext = Boolean(dependencies.resolveCallerContext);
  const workspaceMode = dependencies.workspaceMode ?? "multi";

  app.addContentTypeParser(/^application\/octet-stream(?:\s*;.*)?$/i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(buildDeveloperLandingHtml(request));
  });

  app.get("/docs", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(buildDeveloperDocsHtml(request));
  });

  app.get("/openapi.yaml", async (request, reply) => {
    reply.type("application/yaml; charset=utf-8");
    return reply.send(await loadOpenApiSpec(getRequestOrigin(request)));
  });

  app.get("/openapi.json", async (request, reply) => {
    return reply.send(await loadOpenApiDocument(getRequestOrigin(request)));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      void sendError(reply, error.statusCode, error.code, error.message, error.details);
      return;
    }

    app.log.error(error);
    void sendError(reply, 500, "internal_error", error instanceof Error ? error.message : "Unknown server error.");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz") {
      return;
    }

    if (request.url.startsWith("/internal/v1/models/")) {
      const remoteAddress = request.ip || request.raw.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        await sendError(reply, 403, "forbidden", "Internal model routes are only available from loopback addresses.");
        return reply;
      }

      return;
    }

    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    const resolvedCallerContext = await dependencies.resolveCallerContext?.(request);
    if (resolvedCallerContext) {
      request.callerContext = resolvedCallerContext;
      return;
    }

    if (!hostOwnsCallerContext) {
      request.callerContext = createStandaloneCallerContext();
      return;
    }

    await sendError(reply, 401, "unauthorized", "Missing caller context.");
    return reply;
  });

  app.get("/healthz", async () =>
    dependencies.healthCheck
      ? dependencies.healthCheck()
      : {
          status: "ok"
        }
  );

  app.get("/readyz", async (_request, reply) => {
    const payload = dependencies.readinessCheck
      ? await dependencies.readinessCheck()
      : {
          status: "ready"
        };

    if (payload.status === "not_ready") {
      return reply.status(503).send(payload);
    }

    return reply.send(payload);
  });

  app.get("/api/v1", async (request, reply) => reply.send(buildApiIndex(request)));

  app.get("/api/v1/workspace-templates", async (_request, reply) => {
    if (workspaceMode === "single" || !dependencies.listWorkspaceTemplates) {
      throw new AppError(501, "workspace_templates_unavailable", "Workspace templates are not available on this server.");
    }

    const templates = await dependencies.listWorkspaceTemplates();
    return reply.send(
      workspaceTemplateListSchema.parse({
        items: templates
      })
    );
  });

  app.get("/api/v1/model-providers", async (_request, reply) =>
    reply.send(
      modelProviderListSchema.parse({
        items: SUPPORTED_MODEL_PROVIDERS
      })
    )
  );

  app.get("/api/v1/platform-models", async (_request, reply) => {
    if (!dependencies.listPlatformModels) {
      throw new AppError(404, "platform_models_unavailable", "Platform models are not available.");
    }

    const items = await dependencies.listPlatformModels();
    return reply.send(
      platformModelListSchema.parse({
        items
      })
    );
  });

  app.get("/api/v1/storage/overview", async (_request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    return reply.send(storageOverviewSchema.parse(await dependencies.storageAdmin.overview()));
  });

  app.get("/api/v1/storage/postgres/tables/:table", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const params = createParamsSchema("table").parse(request.params);
    const query = storageTableQuerySchema.parse(request.query);
    const table = storagePostgresTableNameSchema.parse(params.table);
    return reply.send(
      storagePostgresTablePageSchema.parse(
        await dependencies.storageAdmin.postgresTable(table, {
          limit: query.limit,
          offset: query.offset,
          ...(query.q ? { q: query.q } : {}),
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
          ...(query.runId ? { runId: query.runId } : {})
        })
      )
    );
  });

  app.get("/api/v1/storage/redis/keys", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeysQuerySchema.parse(request.query);
    return reply.send(
      storageRedisKeyPageSchema.parse(await dependencies.storageAdmin.redisKeys(query.pattern, query.cursor, query.pageSize))
    );
  });

  app.get("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisKeyDetailSchema.parse(await dependencies.storageAdmin.redisKeyDetail(query.key)));
  });

  app.delete("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisDeleteKeyResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKey(query.key)));
  });

  app.post("/api/v1/storage/redis/keys/delete", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisDeleteKeysRequestSchema.parse(request.body);
    return reply.send(storageRedisDeleteKeysResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKeys(body.keys)));
  });

  app.post("/api/v1/storage/redis/session-queue/clear", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.clearRedisSessionQueue(body.key))
    );
  });

  app.post("/api/v1/storage/redis/session-lock/release", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.releaseRedisSessionLock(body.key))
    );
  });

  app.post("/api/v1/workspaces", async (request, reply) => {
    if (workspaceMode === "single") {
      throw new AppError(501, "workspace_creation_unavailable", "Workspace creation is not available in single-workspace mode.");
    }

    const input = createWorkspaceRequestSchema.parse(request.body);
    const workspace = await dependencies.runtimeService.createWorkspace({ input });
    return reply.status(201).send(workspace);
  });

  app.post("/api/v1/workspaces/import", async (request, reply) => {
    if (workspaceMode === "single" || !dependencies.importWorkspace) {
      throw new AppError(501, "workspace_import_unavailable", "Workspace import is not available on this server.");
    }

    const body = request.body as Record<string, unknown> | null;
    const rootPath = typeof body?.rootPath === "string" ? body.rootPath : undefined;
    if (!rootPath) {
      throw new AppError(400, "invalid_request", "rootPath is required.");
    }

    const kind = body?.kind === "chat" ? "chat" : "project";
    const name = typeof body?.name === "string" ? body.name : undefined;
    const externalRef = typeof body?.externalRef === "string" ? body.externalRef : undefined;
    const workspace = await dependencies.importWorkspace({
      rootPath,
      kind,
      ...(name ? { name } : {}),
      ...(externalRef ? { externalRef } : {})
    });
    return reply.status(201).send(workspace);
  });

  app.get("/api/v1/workspaces", async (request, reply) => {
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaces(query.pageSize, query.cursor);
    return reply.send(workspacePageSchema.parse(page));
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
    return reply.send(workspace);
  });

  app.get("/api/v1/workspaces/:workspaceId/history-mirror", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspaceRecord(params.workspaceId);
    const status = dependencies.getWorkspaceHistoryMirrorStatus
      ? await dependencies.getWorkspaceHistoryMirrorStatus(workspace)
      : await inspectHistoryMirrorStatus(workspace);
    return reply.send(workspaceHistoryMirrorStatusSchema.parse(status));
  });

  app.post("/api/v1/workspaces/:workspaceId/history-mirror/rebuild", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspaceRecord(params.workspaceId);

    if (workspace.kind !== "project") {
      throw new AppError(
        400,
        "history_mirror_not_supported",
        `Workspace ${params.workspaceId} does not support local history mirror sync.`
      );
    }

    if (!dependencies.rebuildWorkspaceHistoryMirror) {
      throw new AppError(501, "history_mirror_rebuild_unavailable", "History mirror rebuild is not available on this server.");
    }

    const status = await dependencies.rebuildWorkspaceHistoryMirror(workspace);
    return reply.send(workspaceHistoryMirrorStatusSchema.parse(status));
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (workspaceMode === "single") {
      throw new AppError(501, "workspace_deletion_unavailable", "Workspace deletion is not available in single-workspace mode.");
    }

    const params = createParamsSchema("workspaceId").parse(request.params);
    await dependencies.runtimeService.deleteWorkspace(params.workspaceId);
    return reply.status(204).send();
  });

  app.get("/api/v1/workspaces/:workspaceId/catalog", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const catalog = await dependencies.runtimeService.getWorkspaceCatalog(params.workspaceId);
    return reply.send(catalog);
  });

  app.get("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceEntriesQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaceEntries(params.workspaceId, query);
    return reply.send(workspaceEntryPageSchema.parse(page));
  });

  app.get("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceFileContentQuerySchema.parse(request.query);
    const file = await dependencies.runtimeService.getWorkspaceFileContent(params.workspaceId, query);
    return reply.send(workspaceFileContentSchema.parse(file));
  });

  app.put("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = putWorkspaceFileRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.putWorkspaceFileContent(params.workspaceId, {
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      overwrite: input.overwrite,
      ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {})
    });
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.put("/api/v1/workspaces/:workspaceId/files/upload", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceFileUploadQuerySchema.parse(request.query);
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(415, "invalid_upload_content_type", "File upload requires Content-Type: application/octet-stream.");
    }

    const entry = await dependencies.runtimeService.uploadWorkspaceFile(params.workspaceId, {
      path: query.path,
      data: request.body,
      overwrite: query.overwrite,
      ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {})
    });
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.get("/api/v1/workspaces/:workspaceId/files/download", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceEntryPathQuerySchema.parse(request.query);
    const file = await dependencies.runtimeService.getWorkspaceFileDownload(params.workspaceId, query.path);

    reply.header("Content-Type", file.mimeType ?? "application/octet-stream");
    reply.header("Content-Length", String(file.sizeBytes));
    reply.header("ETag", file.etag);
    reply.header("Last-Modified", file.updatedAt);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.send(createReadStream(file.absolutePath));
  });

  app.post("/api/v1/workspaces/:workspaceId/directories", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = createWorkspaceDirectoryRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.createWorkspaceDirectory(params.workspaceId, input);
    return reply.status(201).send(workspaceEntrySchema.parse(entry));
  });

  app.delete("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceDeleteEntryQuerySchema.parse(request.query);
    const result = await dependencies.runtimeService.deleteWorkspaceEntry(params.workspaceId, query);
    return reply.send(workspaceDeleteResultSchema.parse(result));
  });

  app.patch("/api/v1/workspaces/:workspaceId/entries/move", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = moveWorkspaceEntryRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.moveWorkspaceEntry(params.workspaceId, input);
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.post("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = createSessionRequestSchema.parse(request.body);
    const session = await dependencies.runtimeService.createSession({
      workspaceId: params.workspaceId,
      caller: toCallerContext(request),
      input
    });

    return reply.status(201).send(session);
  });

  app.get("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaceSessions(params.workspaceId, query.pageSize, query.cursor);
    return reply.send(sessionPageSchema.parse(page));
  });

  app.post("/api/v1/workspaces/:workspaceId/actions/:actionName/runs", async (request, reply) => {
    const params = createParamsSchema("workspaceId", "actionName").parse(request.params);
    const input = createActionRunRequestSchema.parse(request.body);
    const accepted = await dependencies.runtimeService.triggerActionRun({
      workspaceId: params.workspaceId,
      actionName: params.actionName,
      caller: toCallerContext(request),
      sessionId: input.sessionId,
      agentName: input.agentName,
      input: input.input
    });
    return reply.status(202).send(accepted);
  });

  app.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const session = await dependencies.runtimeService.getSession(params.sessionId);
    return reply.send(session);
  });

  app.patch("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const input = updateSessionRequestSchema.parse(request.body);
    const session = await dependencies.runtimeService.updateSession({
      sessionId: params.sessionId,
      input
    });
    return reply.send(session);
  });

  app.delete("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    await dependencies.runtimeService.deleteSession(params.sessionId);
    return reply.status(204).send();
  });

  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionMessages(params.sessionId, query.pageSize, query.cursor);
    return reply.send(page);
  });

  app.get("/api/v1/sessions/:sessionId/runs", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionRuns(params.sessionId, query.pageSize, query.cursor);
    return reply.send(runPageSchema.parse(page));
  });

  app.post("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const input = createMessageRequestSchema.parse(request.body);
    const accepted = await dependencies.runtimeService.createSessionMessage({
      sessionId: params.sessionId,
      caller: toCallerContext(request),
      input
    });

    return reply.status(202).send(messageAcceptedSchema.parse(accepted));
  });

  app.get(
    "/api/v1/sessions/:sessionId/events",
    {
      // SSE connections can reconnect frequently, so keep this route out of routine request noise.
      logLevel: "warn"
    },
    async (request, reply) => {
      const params = createParamsSchema("sessionId").parse(request.params);
      const query = runEventsQuerySchema.parse(request.query);
      await dependencies.runtimeService.getSession(params.sessionId);

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(": connected\n\n");

      const backlog = await dependencies.runtimeService.listSessionEvents(params.sessionId, query.cursor, query.runId);
      for (const event of backlog) {
        writeSseEvent(reply, event.event, event.data, event.cursor);
      }

      const unsubscribe = dependencies.runtimeService.subscribeSessionEvents(params.sessionId, (event: SessionEvent) => {
        if (query.runId && event.runId !== query.runId) {
          return;
        }

        if (query.cursor && Number.parseInt(event.cursor, 10) <= Number.parseInt(query.cursor, 10)) {
          return;
        }

        writeSseEvent(reply, event.event, event.data, event.cursor);
      });

      request.raw.on("close", () => {
        unsubscribe();
        reply.raw.end();
      });
    }
  );

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const run = await dependencies.runtimeService.getRun(params.runId);
    return reply.send(run);
  });

  app.get("/api/v1/runs/:runId/steps", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listRunSteps(params.runId, query.pageSize, query.cursor);
    return reply.send(runStepPageSchema.parse(page));
  });

  app.post("/api/v1/runs/:runId/cancel", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const result = await dependencies.runtimeService.cancelRun(params.runId);
    return reply.status(202).send(cancelRunAcceptedSchema.parse(result));
  });

  app.post("/internal/v1/models/generate", async (request, reply) => {
    const input = modelGenerateRequestSchema.parse(request.body);
    const response = await dependencies.modelGateway.generate(
      {
        ...input,
        model: input.model ?? dependencies.defaultModel
      },
      request.raw.aborted ? { signal: AbortSignal.abort() } : undefined
    );

    return reply.send(modelGenerateResponseSchema.parse(response));
  });

  app.post("/internal/v1/models/stream", async (request, reply) => {
    const input = modelGenerateRequestSchema.parse(request.body);
    const abortController = new AbortController();
    request.raw.on("close", () => abortController.abort());

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    try {
      const response = await dependencies.modelGateway.stream(
        {
          ...input,
          model: input.model ?? dependencies.defaultModel
        },
        { signal: abortController.signal }
      );

      writeSseEvent(reply, "response.started", {
        model: input.model ?? dependencies.defaultModel
      });

      for await (const chunk of response.chunks) {
        writeSseEvent(reply, "text.delta", {
          delta: chunk
        });
      }

      const completed = await response.completed;
      writeSseEvent(reply, "response.completed", {
        model: completed.model,
        finishReason: completed.finishReason ?? "stop"
      });
    } catch (error) {
      writeSseEvent(reply, "response.failed", {
        model: input.model ?? dependencies.defaultModel,
        message: error instanceof Error ? error.message : "Unknown stream error."
      });
    } finally {
      reply.raw.end();
    }
  });

  return app;
}

function createParamsSchema<T extends string>(...keys: T[]) {
  return {
    parse(input: unknown): Record<T, string> {
      if (!input || typeof input !== "object") {
        throw new AppError(400, "invalid_params", "Invalid route parameters.");
      }

      const parsed: Partial<Record<T, string>> = {};
      for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value !== "string" || value.length === 0) {
          throw new AppError(400, "invalid_params", `Invalid route parameter: ${key}.`);
        }

        parsed[key] = value;
      }

      return parsed as Record<T, string>;
    }
  };
}
