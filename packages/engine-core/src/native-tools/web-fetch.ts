import { z } from "zod";

import { formatToolOutput } from "../capabilities/tool-output.js";
import type { EngineToolSet } from "../types.js";
import { DEFAULT_BASH_TIMEOUT_MS } from "./constants.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";
import { answerWebFetchPrompt, fetchWithTimeout, htmlToText, isLikelyBinaryContent, normalizeUrl, splitOutputLines } from "./web-utils.js";

const WEB_FETCH_DESCRIPTION = `- Fetches content from a specified URL and processes it using a prompt
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to plain text
- Processes the content with the prompt using the configured model when available
- Returns the prompt result about the content

Usage notes:
- The URL must be a fully-formed valid URL
- HTTP URLs are automatically upgraded to HTTPS
- Results may be summarized if the content is very large
- If a URL redirects to a different host, the tool returns the redirect URL so you can fetch it explicitly`;

const WebFetchInputSchema = z
  .object({
    url: z.string().url().describe("The URL to fetch"),
    prompt: z.string().min(1).describe("What information to extract from the page")
  })
  .strict();

export function createWebFetchTool(context: NativeToolFactoryContext): EngineToolSet {
  return {
    WebFetch: {
      description: WEB_FETCH_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("WebFetch"),
      inputSchema: WebFetchInputSchema,
      async execute(rawInput, executionContext) {
        context.assertVisible("WebFetch");
        const input = WebFetchInputSchema.parse(rawInput);
        const startedAt = Date.now();
        const normalizedUrl = normalizeUrl(input.url);
        const response = await fetchWithTimeout(normalizedUrl, DEFAULT_BASH_TIMEOUT_MS, executionContext.abortSignal);
        const contentType = response.headers.get("content-type") ?? "text/plain";
        const finalUrl = response.url || normalizedUrl;

        if (response.redirected) {
          const requestedHost = new URL(normalizedUrl).host;
          const finalHost = new URL(finalUrl).host;
          if (requestedHost !== finalHost) {
            return formatToolOutput(
              [
                ["url", normalizedUrl],
                ["status_code", response.status],
                ["status_text", response.statusText],
                ["redirect_url", finalUrl],
                ["duration_ms", Date.now() - startedAt]
              ],
              [
                {
                  title: "message",
                  lines: ["The URL redirected to a different host. Make a new WebFetch request with the redirect URL."]
                }
              ]
            );
          }
        }

        const body = await response.text();
        const renderedContent = isLikelyBinaryContent(contentType)
          ? "[binary content omitted]"
          : contentType.includes("html")
            ? htmlToText(body)
            : body;
        const result = await answerWebFetchPrompt(
          context.options,
          renderedContent,
          input.prompt,
          executionContext.abortSignal
        );

        return formatToolOutput(
          [
            ["url", finalUrl],
            ["status_code", response.status],
            ["status_text", response.statusText],
            ["bytes", Buffer.byteLength(body, "utf8")],
            ["duration_ms", Date.now() - startedAt]
          ],
          [
            {
              title: "result",
              lines: splitOutputLines(result),
              emptyText: "(empty result)"
            }
          ]
        );
      }
    }
  };
}
