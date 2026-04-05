import { z } from "zod";

import { formatToolOutput } from "../tool-output.js";
import type { RuntimeToolSet } from "../types.js";
import { DEFAULT_BASH_TIMEOUT_MS } from "./constants.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";
import { fetchWithTimeout, filterSearchDomains, htmlToText } from "./web-utils.js";

const WEB_SEARCH_DESCRIPTION = `- Allows searching the web for current information
- Returns search result information with titles and URLs
- Domain filtering is supported through allowed_domains and blocked_domains
- Use this tool for up-to-date information beyond the model cutoff

CRITICAL REQUIREMENT:
- After using this tool, final user-facing answers should include a Sources section with the cited URLs`;

const WebSearchInputSchema = z
  .object({
    query: z.string().min(2).describe("The search query to use"),
    allowed_domains: z.array(z.string().min(1)).optional().describe("Only include search results from these domains"),
    blocked_domains: z.array(z.string().min(1)).optional().describe("Never include search results from these domains")
  })
  .strict();

export function createWebSearchTool(context: NativeToolFactoryContext): RuntimeToolSet {
  return {
    WebSearch: {
      description: WEB_SEARCH_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("WebSearch"),
      inputSchema: WebSearchInputSchema,
      async execute(rawInput, executionContext) {
        context.assertVisible("WebSearch");
        const input = WebSearchInputSchema.parse(rawInput);
        const startedAt = Date.now();
        const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
        const response = await fetchWithTimeout(searchUrl, DEFAULT_BASH_TIMEOUT_MS, executionContext.abortSignal);
        const html = await response.text();
        const results: Array<{ title: string; url: string }> = [];
        const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

        for (const match of html.matchAll(anchorPattern)) {
          const [, href, titleHtml] = match;
          if (!href || !titleHtml) {
            continue;
          }

          let parsedUrl: URL;
          try {
            parsedUrl = new URL(href.replaceAll("&amp;", "&"));
          } catch {
            continue;
          }

          if (!filterSearchDomains(parsedUrl.hostname, input.allowed_domains ?? [], input.blocked_domains ?? [])) {
            continue;
          }

          results.push({
            title: htmlToText(titleHtml),
            url: parsedUrl.toString()
          });

          if (results.length >= 8) {
            break;
          }
        }

        return formatToolOutput(
          [
            ["query", input.query],
            ["duration_ms", Date.now() - startedAt],
            ["results", results.length]
          ],
          [
            {
              title: "matches",
              lines: results.flatMap((result, index) => [`${index + 1}. ${result.title}`, `   ${result.url}`]),
              emptyText: "(no results)"
            }
          ]
        );
      }
    }
  };
}
