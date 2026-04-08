import { createMCPClient, type ListToolsResult } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { dynamicTool, jsonSchema, type JSONValue, type ToolSet } from "ai";

import type { RuntimeLogger, ToolServerDefinition } from "@oah/runtime-core";
import { AppError } from "@oah/runtime-core";

export interface PreparedToolServers {
  tools: ToolSet;
  close(): Promise<void>;
}

export interface PrepareToolServersOptions {
  logger?: RuntimeLogger | undefined;
}

interface ToolServerClient {
  listTools(): Promise<ListToolsResult>;
  toolsFromDefinitions(definitions: ListToolsResult): ToolSet;
  close(): Promise<void>;
}

type CompatibilityCallToolResult = Record<string, unknown> & {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
};

const HTTP_MCP_COMPATIBLE_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

function createShellWrappedCommand(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", command]
  };
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix || prefix.trim().length === 0) {
    return undefined;
  }

  return prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
}

function shouldIncludeTool(toolName: string, include: string[] | undefined, exclude: string[] | undefined): boolean {
  if (include && include.length > 0 && !include.includes(toolName)) {
    return false;
  }

  if (exclude && exclude.includes(toolName)) {
    return false;
  }

  return true;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

async function createClient(server: ToolServerDefinition): Promise<ToolServerClient> {
  if (server.oauth) {
    throw new AppError(
      501,
      "mcp_oauth_not_implemented",
      `Tool server ${server.name} requests OAuth over MCP, which is not implemented yet.`
    );
  }

  if (server.transportType === "stdio") {
    if (!server.command) {
      throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing command.`);
    }

    const wrapped = createShellWrappedCommand(server.command);
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: wrapped.command,
        args: wrapped.args,
        ...(server.workingDirectory ? { cwd: server.workingDirectory } : {}),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          ),
          ...(server.environment ?? {})
        }
      })
    });
  }

  if (!server.url) {
    throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing url.`);
  }

  return createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {})
    }
  });
}

function parseSupportedProtocolVersions(message: string): string[] {
  const match = message.match(/supported versions:\s*([^)]+)/iu);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function resolveCompatibleProtocolVersion(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unsupported protocol version/iu.test(message)) {
    return undefined;
  }

  const supportedVersions = parseSupportedProtocolVersions(message);
  return HTTP_MCP_COMPATIBLE_PROTOCOL_VERSIONS.find((version) => supportedVersions.includes(version));
}

function toFetchHeaders(
  server: ToolServerDefinition,
  protocolVersion: string,
  sessionId?: string
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(server.headers ?? {})
  };
}

async function parseJsonRpcResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  const chunks = text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  for (const chunk of chunks) {
    const dataLine = chunk
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }

    const payload = dataLine.slice(5).trim();
    if (payload.length === 0) {
      continue;
    }

    return JSON.parse(payload);
  }

  throw new Error("MCP HTTP compatibility client received no JSON-RPC payload.");
}

async function sendCompatibilityRequest(
  server: ToolServerDefinition,
  protocolVersion: string,
  message: Record<string, unknown>,
  sessionId?: string
): Promise<{ payload?: Record<string, unknown>; sessionId?: string }> {
  if (!server.url) {
    throw new AppError(400, "invalid_mcp_server", `Tool server ${server.name} is missing url.`);
  }

  const response = await fetch(server.url, {
    method: "POST",
    headers: toFetchHeaders(server, protocolVersion, sessionId),
    body: JSON.stringify(message)
  });

  const responseSessionId = response.headers.get("mcp-session-id") ?? sessionId ?? undefined;
  if (response.status === 202) {
    return {
      ...(responseSessionId ? { sessionId: responseSessionId } : {})
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MCP HTTP compatibility client failed (HTTP ${response.status}): ${text}`);
  }

  const payload = await parseJsonRpcResponse(response);
  if (!payload || typeof payload !== "object") {
    throw new Error("MCP HTTP compatibility client received an invalid JSON-RPC response.");
  }

  if ("error" in payload && payload.error && typeof payload.error === "object") {
    const messageText =
      "message" in payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : JSON.stringify(payload.error);
    throw new Error(messageText);
  }

  return {
    payload: payload as Record<string, unknown>,
    ...(responseSessionId ? { sessionId: responseSessionId } : {})
  };
}

function compatibilityToolResultToModelOutput({
  output
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}) {
  const result = output as CompatibilityCallToolResult;
  if (!("content" in result) || !Array.isArray(result.content)) {
    return { type: "json" as const, value: toJsonValue(result) };
  }

  return {
    type: "content" as const,
    value: result.content.map((part: Record<string, unknown>) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return {
          type: "text" as const,
          text: String(part.text)
        };
      }

      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "image" &&
        "data" in part &&
        "mimeType" in part
      ) {
        return {
          type: "image-data" as const,
          data: String(part.data),
          mediaType: String(part.mimeType)
        };
      }

      return {
        type: "text" as const,
        text: JSON.stringify(part)
      };
    })
  };
}

async function createCompatibilityHttpClient(
  server: ToolServerDefinition,
  protocolVersion: string,
  options?: PrepareToolServersOptions
): Promise<ToolServerClient> {
  let sessionId: string | undefined;
  let nextRequestId = 0;

  const initializeResponse = await sendCompatibilityRequest(
    server,
    protocolVersion,
    {
      jsonrpc: "2.0",
      id: String(++nextRequestId),
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "oah-mcp-compat-client",
          version: "1.0.0"
        }
      }
    },
    sessionId
  );
  sessionId = initializeResponse.sessionId ?? sessionId;

  await sendCompatibilityRequest(
    server,
    protocolVersion,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    },
    sessionId
  );

  options?.logger?.warn?.("Falling back to legacy MCP HTTP protocol version.", {
    serverName: server.name,
    transportType: server.transportType,
    url: server.url,
    protocolVersion
  });

  return {
    async listTools() {
      const response = await sendCompatibilityRequest(
        server,
        protocolVersion,
        {
          jsonrpc: "2.0",
          id: String(++nextRequestId),
          method: "tools/list",
          params: {}
        },
        sessionId
      );
      sessionId = response.sessionId ?? sessionId;
      const result = response.payload?.result;
      if (!result || typeof result !== "object" || !Array.isArray((result as ListToolsResult).tools)) {
        throw new Error(`Legacy MCP HTTP server ${server.name} returned an invalid tools/list result.`);
      }

      return result as ListToolsResult;
    },
    toolsFromDefinitions(definitions: ListToolsResult) {
      return Object.fromEntries(
        definitions.tools.map((definition) => [
          definition.name,
          dynamicTool({
            ...(typeof definition.description === "string" ? { description: definition.description } : {}),
            ...(definition.title ? { title: definition.title } : {}),
            inputSchema: jsonSchema({
              ...definition.inputSchema,
              properties: definition.inputSchema.properties ?? {},
              additionalProperties: false
            }),
            execute: async (args, executeOptions) => {
              const response = await withServerTimeout(
                server,
                sendCompatibilityRequest(
                  server,
                  protocolVersion,
                  {
                    jsonrpc: "2.0",
                    id: String(++nextRequestId),
                    method: "tools/call",
                    params: {
                      name: definition.name,
                      arguments: args as Record<string, unknown>
                    }
                  },
                  sessionId
                ),
                "tool call"
              );
              sessionId = response.sessionId ?? sessionId;
              const result = response.payload?.result;
              if (!result || typeof result !== "object") {
                throw new Error(`Legacy MCP HTTP server ${server.name} returned an invalid tools/call result.`);
              }
              executeOptions?.abortSignal?.throwIfAborted();
              return result as CompatibilityCallToolResult;
            },
            toModelOutput: compatibilityToolResultToModelOutput
          })
        ])
      );
    },
    async close() {
      if (!sessionId || !server.url) {
        return;
      }

      await fetch(server.url, {
        method: "DELETE",
        headers: {
          "mcp-protocol-version": protocolVersion,
          "mcp-session-id": sessionId,
          ...(server.headers ?? {})
        }
      }).catch(() => undefined);
    }
  };
}

function logToolServerFailure(
  server: ToolServerDefinition,
  phase: string,
  error: unknown,
  logger: RuntimeLogger | undefined
): void {
  const details = {
    serverName: server.name,
    transportType: server.transportType,
    phase,
    ...(server.command ? { command: server.command } : {}),
    ...(server.workingDirectory ? { workingDirectory: server.workingDirectory } : {}),
    ...(server.url ? { url: server.url } : {}),
    error: error instanceof Error ? error.message : String(error)
  };

  if (server.transportType === "stdio") {
    logger?.error?.("Local MCP server failed during initialization.", details);
    if (!logger?.error) {
      console.error("[oah-runtime] Local MCP server failed during initialization.", details);
    }
    return;
  }

  logger?.warn?.("Remote MCP server failed during initialization.", details);
  if (!logger?.warn) {
    console.warn("[oah-runtime] Remote MCP server failed during initialization.", details);
  }
}

async function withServerTimeout<T>(
  server: ToolServerDefinition,
  operation: Promise<T>,
  phase: string
): Promise<T> {
  if (server.timeout === undefined || !Number.isFinite(server.timeout) || server.timeout <= 0) {
    return operation;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`MCP server ${server.name} timed out during ${phase} after ${server.timeout}ms.`));
        }, server.timeout);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function shouldSkipRemoteServer(server: ToolServerDefinition, error: unknown): boolean {
  return server.transportType === "http" && !(error instanceof AppError);
}

function shortToolAlias(toolName: string): string | undefined {
  const separatorIndex = toolName.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === toolName.length - 1) {
    return undefined;
  }

  return toolName.slice(separatorIndex + 1);
}

function withUniqueShortAliases(toolEntries: Array<[string, ToolSet[string]]>): Array<[string, ToolSet[string]]> {
  const aliasCandidates = new Map<string, Array<[string, ToolSet[string]]>>();

  for (const entry of toolEntries) {
    const alias = shortToolAlias(entry[0]);
    if (!alias) {
      continue;
    }

    const existing = aliasCandidates.get(alias) ?? [];
    existing.push(entry);
    aliasCandidates.set(alias, existing);
  }

  const reservedNames = new Set(toolEntries.map(([name]) => name));
  const aliasedEntries = [...toolEntries];

  for (const [alias, entries] of aliasCandidates) {
    const [entry] = entries;
    if (entries.length !== 1 || !entry || reservedNames.has(alias)) {
      continue;
    }

    aliasedEntries.push([alias, entry[1]]);
    reservedNames.add(alias);
  }

  return aliasedEntries;
}

export async function prepareToolServers(
  toolServers: ToolServerDefinition[] | undefined,
  options?: PrepareToolServersOptions
): Promise<PreparedToolServers> {
  const enabledServers = (toolServers ?? []).filter((server) => server.enabled);
  if (enabledServers.length === 0) {
    return {
      tools: {},
      async close() {}
    };
  }

  const clients: ToolServerClient[] = [];
  const toolEntries: Array<[string, ToolSet[string]]> = [];

  try {
    for (const server of enabledServers) {
      let client: ToolServerClient | undefined;

      try {
        client = await withServerTimeout(server, createClient(server), "client creation");
        clients.push(client);

        const definitions = await withServerTimeout(server, client.listTools(), "tool listing");
        const filteredDefinitions = {
          ...definitions,
          tools: definitions.tools.filter((tool) => shouldIncludeTool(tool.name, server.include, server.exclude))
        };
        const serverTools = client.toolsFromDefinitions(filteredDefinitions);
        const prefix = normalizePrefix(server.toolPrefix);

        for (const [toolName, toolDefinition] of Object.entries(serverTools)) {
          const exposedToolName = prefix ? `${prefix}.${toolName}` : toolName;
          if (toolEntries.some(([existingName]) => existingName === exposedToolName)) {
            throw new AppError(
              409,
              "duplicate_mcp_tool_name",
              `Duplicate external tool name detected: ${exposedToolName}. Adjust tool_prefix/include/exclude settings.`
            );
          }

          toolEntries.push([exposedToolName, toolDefinition]);
        }
      } catch (error) {
        const compatibleProtocolVersion =
          server.transportType === "http" && !client ? resolveCompatibleProtocolVersion(error) : undefined;
        if (compatibleProtocolVersion) {
          try {
            client = await withServerTimeout(
              server,
              createCompatibilityHttpClient(server, compatibleProtocolVersion, options),
              "client creation"
            );
            clients.push(client);

            const definitions = await withServerTimeout(server, client.listTools(), "tool listing");
            const filteredDefinitions = {
              ...definitions,
              tools: definitions.tools.filter((tool) => shouldIncludeTool(tool.name, server.include, server.exclude))
            };
            const serverTools = client.toolsFromDefinitions(filteredDefinitions);
            const prefix = normalizePrefix(server.toolPrefix);

            for (const [toolName, toolDefinition] of Object.entries(serverTools)) {
              const exposedToolName = prefix ? `${prefix}.${toolName}` : toolName;
              if (toolEntries.some(([existingName]) => existingName === exposedToolName)) {
                throw new AppError(
                  409,
                  "duplicate_mcp_tool_name",
                  `Duplicate external tool name detected: ${exposedToolName}. Adjust tool_prefix/include/exclude settings.`
                );
              }

              toolEntries.push([exposedToolName, toolDefinition]);
            }
            continue;
          } catch (compatibilityError) {
            error = compatibilityError;
          }
        }

        if (server.transportType === "stdio" || !shouldSkipRemoteServer(server, error)) {
          logToolServerFailure(server, client ? "tool listing" : "client creation", error, options?.logger);
        }

        if (client) {
          await Promise.allSettled([client.close()]);
          const clientIndex = clients.indexOf(client);
          if (clientIndex >= 0) {
            clients.splice(clientIndex, 1);
          }
        }

        if (!shouldSkipRemoteServer(server, error)) {
          throw error;
        }

        options?.logger?.warn?.("Skipping unreachable remote MCP server.", {
          serverName: server.name,
          transportType: server.transportType,
          url: server.url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      tools: Object.fromEntries(withUniqueShortAliases(toolEntries)),
      async close() {
        await Promise.allSettled(clients.map((client) => client.close()));
      }
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}
