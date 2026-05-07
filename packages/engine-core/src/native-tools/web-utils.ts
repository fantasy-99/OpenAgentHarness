import { AppError } from "../errors.js";
import type { NativeToolSetOptions } from "./types.js";

const WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; OpenAgentHarness/0.1; +https://github.com/OpenAgentHarness/OpenAgentHarness)";
const WEB_FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const WEB_FETCH_MAX_CACHE_BYTES = 50 * 1024 * 1024;
const WEB_FETCH_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const WEB_FETCH_MAX_REDIRECTS = 10;
const WEB_FETCH_MAX_MODEL_CONTENT_CHARS = 100_000;

export type WebFetchRedirect = {
  type: "redirect";
  originalUrl: string;
  redirectUrl: string;
  status: number;
  statusText: string;
};

export type WebFetchResponse = {
  type: "response";
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
  bytes: number;
};

type CacheEntry = Omit<WebFetchResponse, "headers"> & {
  contentType: string;
  expiresAt: number;
  size: number;
};

const WEB_FETCH_CACHE = new Map<string, CacheEntry>();
let webFetchCacheSize = 0;

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export function normalizeUrl(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  return parsed.toString();
}

export function isLikelyBinaryContent(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length > 0 && !mime.startsWith("text/") && !mime.includes("json") && !mime.includes("xml") && !mime.includes("javascript");
}

export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);
    if (original.protocol !== redirect.protocol || original.port !== redirect.port) {
      return false;
    }
    if (redirect.username || redirect.password) {
      return false;
    }

    const stripWww = (hostname: string) => hostname.replace(/^www\./u, "");
    return stripWww(original.hostname) === stripWww(redirect.hostname);
  } catch {
    return false;
  }
}

function getCachedFetch(url: string): WebFetchResponse | undefined {
  const entry = WEB_FETCH_CACHE.get(url);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    WEB_FETCH_CACHE.delete(url);
    webFetchCacheSize -= entry.size;
    return undefined;
  }

  WEB_FETCH_CACHE.delete(url);
  WEB_FETCH_CACHE.set(url, entry);
  return {
    type: "response",
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    headers: new Headers(entry.contentType ? { "content-type": entry.contentType } : undefined),
    body: entry.body,
    bytes: entry.bytes
  };
}

function cacheFetch(url: string, response: WebFetchResponse): void {
  const contentType = response.headers.get("content-type") ?? "";
  const size = Math.max(1, Buffer.byteLength(response.body, "utf8"));
  if (size > WEB_FETCH_MAX_CACHE_BYTES) {
    return;
  }

  const existing = WEB_FETCH_CACHE.get(url);
  if (existing) {
    webFetchCacheSize -= existing.size;
  }

  WEB_FETCH_CACHE.set(url, {
    type: "response",
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    contentType,
    body: response.body,
    bytes: response.bytes,
    expiresAt: Date.now() + WEB_FETCH_CACHE_TTL_MS,
    size
  });
  webFetchCacheSize += size;

  while (webFetchCacheSize > WEB_FETCH_MAX_CACHE_BYTES) {
    const oldestKey = WEB_FETCH_CACHE.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldest = WEB_FETCH_CACHE.get(oldestKey);
    WEB_FETCH_CACHE.delete(oldestKey);
    if (oldest) {
      webFetchCacheSize -= oldest.size;
    }
  }
}

function resolveRedirectUrl(baseUrl: string, response: Response): string | undefined {
  const location = response.headers.get("location");
  if (!location) {
    return undefined;
  }
  return new URL(location, baseUrl).toString();
}

async function readResponseBody(response: Response, url: string): Promise<{ body: string; bytes: number }> {
  if (!response.body) {
    const body = await response.text();
    return { body, bytes: Buffer.byteLength(body, "utf8") };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > WEB_FETCH_MAX_RESPONSE_BYTES) {
        throw new AppError(
          413,
          "native_tool_web_fetch_too_large",
          `Fetching ${url} exceeded the ${WEB_FETCH_MAX_RESPONSE_BYTES} byte response limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { body: Buffer.concat(chunks, bytes).toString("utf8"), bytes };
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<WebFetchResponse | WebFetchRedirect> {
  const cached = getCachedFetch(url);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeoutHandle =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount < WEB_FETCH_MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          accept: "text/markdown, text/html, text/plain, application/json, application/xml, */*",
          "user-agent": WEB_FETCH_USER_AGENT
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const redirectUrl = resolveRedirectUrl(currentUrl, response);
        if (!redirectUrl) {
          throw new AppError(502, "native_tool_web_fetch_redirect_missing_location", `Redirect from ${currentUrl} was missing a Location header.`);
        }
        if (!isPermittedRedirect(currentUrl, redirectUrl)) {
          return {
            type: "redirect",
            originalUrl: currentUrl,
            redirectUrl,
            status: response.status,
            statusText: response.statusText
          };
        }

        currentUrl = redirectUrl;
        continue;
      }

      const body = await readResponseBody(response, currentUrl);
      const result: WebFetchResponse = {
        type: "response",
        url: response.url || currentUrl,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: body.body,
        bytes: body.bytes
      };
      cacheFetch(url, result);
      if (currentUrl !== url) {
        cacheFetch(currentUrl, result);
      }
      return result;
    }

    throw new AppError(508, "native_tool_web_fetch_too_many_redirects", `Fetching ${url} exceeded ${WEB_FETCH_MAX_REDIRECTS} redirects.`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(408, "native_tool_timeout", `Fetching ${url} timed out.`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function answerWebFetchPrompt(
  options: NativeToolSetOptions | undefined,
  markdownContent: string,
  prompt: string,
  signal?: AbortSignal | undefined
): Promise<string> {
  if (!options?.modelGateway || !options.webFetchModel) {
    const preview = markdownContent.slice(0, 4_000);
    return [
      "Prompt execution fallback:",
      prompt,
      "",
      "Fetched content preview:",
      preview.length > 0 ? preview : "(empty page)"
    ].join("\n");
  }

  const contentForPrompt =
    markdownContent.length > WEB_FETCH_MAX_MODEL_CONTENT_CHARS
      ? `${markdownContent.slice(0, WEB_FETCH_MAX_MODEL_CONTENT_CHARS)}\n\n[Content truncated due to length.]`
      : markdownContent;

  const response = await options.modelGateway.generate(
    {
      model: options.webFetchModel,
      messages: [
        {
          role: "user",
          content: [
            "Web page content:",
            "---",
            contentForPrompt,
            "---",
            "",
            prompt,
            "",
            "Provide a concise response based only on the content above."
          ].join("\n")
        }
      ]
    },
    signal ? { signal } : undefined
  );

  return response.text;
}

export function splitOutputLines(value: string): string[] {
  return value.length > 0 ? value.split(/\r?\n/) : [];
}
