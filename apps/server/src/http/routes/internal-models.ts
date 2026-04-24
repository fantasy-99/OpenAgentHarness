import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { modelGenerateRequestSchema, modelGenerateResponseSchema, platformModelSnapshotSchema } from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";

import { writeSseEvent } from "../context.js";
import type { AppDependencies } from "../types.js";

function readRegisteredRouteUrl(request: FastifyRequest): string {
  return typeof request.routeOptions.url === "string" ? request.routeOptions.url : request.url.split("?")[0] ?? request.url;
}

export async function dispatchRegisteredInternalModelRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const modelGateway = dependencies.modelGateway;
  if (!modelGateway) {
    return;
  }

  const routeUrl = readRegisteredRouteUrl(request);

  switch (`${request.method} ${routeUrl}`) {
    case "POST /internal/v1/platform-models/refresh": {
      if (!dependencies.refreshPlatformModels) {
        throw new AppError(404, "platform_models_unavailable", "Platform model refresh is not available.");
      }

      return reply.send(platformModelSnapshotSchema.parse(await dependencies.refreshPlatformModels()));
    }
    case "POST /internal/v1/models/generate": {
      const input = modelGenerateRequestSchema.parse(request.body);
      const response = await modelGateway.generate(
        {
          ...input,
          model: input.model ?? dependencies.defaultModel
        },
        request.raw.aborted ? { signal: AbortSignal.abort() } : undefined
      );

      return reply.send(modelGenerateResponseSchema.parse(response));
    }
    case "POST /internal/v1/models/stream": {
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
        const response = await modelGateway.stream(
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
      return reply;
    }
    default:
      throw new AppError(404, "route_not_found", `Unsupported internal model route: ${request.method} ${routeUrl}`);
  }
}

export function registerInternalModelRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  if (!dependencies.modelGateway) {
    return;
  }

  app.post("/internal/v1/platform-models/refresh", async (request, reply) =>
    dispatchRegisteredInternalModelRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/models/generate", async (request, reply) =>
    dispatchRegisteredInternalModelRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/models/stream", async (request, reply) =>
    dispatchRegisteredInternalModelRoute(request, reply, dependencies)
  );
}
