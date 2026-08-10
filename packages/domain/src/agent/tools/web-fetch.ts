// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Web fetch tool — retrieve URL content as text.
 *
 * Ported from backend/agent/tools/builtin/web.py (WebFetchTool).
 * Uses {@link safeFetch} to block SSRF against internal / metadata
 * endpoints on every hop (including redirects).
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { safeFetch, SsrfError } from "@domain/agent/tools/safe-fetch.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const DEFAULT_MAX_CHARS = 60_000;

/**
 * Remove HTML tags, scripts, and styles; unescape entities.
 * @param html - Raw HTML source to strip.
 * @returns The plain-text content with common entities unescaped and trimmed.
 */
function stripTags(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  // Basic HTML entity unescaping
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text.trim();
}

/**
 * Collapse excessive whitespace and blank lines.
 * @param text - The text to normalize.
 * @returns The text with runs of spaces/tabs collapsed and 3+ blank lines reduced to two, trimmed.
 */
function normalize(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Read a response body, giving up if the caller stops wanting it.
 *
 * The transport hands back a `Response` and is done: its deadline covered
 * getting the headers, and reading what follows is this layer's business —
 * the transport's own boundary says so outright, and names cancelling the body
 * as the way to stop it. Without that, a server that answers 200 and then
 * stalls holds the whole turn until the client underneath gives up on its own,
 * which it measures in minutes.
 *
 * The read is done through a reader taken here rather than through
 * `res.text()`, because `text()` locks the body for itself: cancelling it from
 * the outside throws "the stream is locked" and the read goes on waiting. The
 * decoding is unchanged by that — measured, `text()` decodes as UTF-8 whatever
 * charset the response declares, byte for byte what `TextDecoder` gives.
 * @param res - The response to read.
 * @param signal - The caller's, when it has one.
 * @returns The body as text.
 * @throws {Error} the reason the caller gave up, when it did.
 */
async function readBody(res: Response, signal?: AbortSignal): Promise<string> {
  if (!signal || !res.body) return res.text();
  signal.throwIfAborted();

  const reader = res.body.getReader();
  const stopReading = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", stopReading, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    // A cancel ends the read by resolving it as finished, not by rejecting, so
    // without this the caller would be handed however much had arrived as
    // though that were the whole page.
    signal.throwIfAborted();
    return new TextDecoder().decode(concatenate(chunks));
  } finally {
    signal.removeEventListener("abort", stopReading);
  }
}

/**
 * Join the chunks a body arrived in.
 * @param chunks - The pieces, in arrival order.
 * @returns One buffer holding all of them.
 */
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/** What the model may ask this tool to fetch. */
const inputSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  maxChars: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe("Max characters to return"),
});

/**
 * Fetch a URL and extract readable text content.
 *
 * Returns a JSON object with url, status, text length, and the
 * extracted content. HTML pages are stripped to plain text.
 *
 * The URL is validated and followed via {@link safeFetch}, which
 * blocks any hop resolving to a private / loopback / link-local /
 * reserved / metadata IP — closing SSRF against internal services.
 */
export const webFetch: Tool<z.infer<typeof inputSchema>, string> = tool({
  description:
    "Fetch a URL and extract readable content (HTML to plain text). " +
    "Only public (non-private, non-loopback) HTTP/HTTPS hosts are permitted.",
  inputSchema,
  execute: async (
    { url, maxChars },
    { abortSignal }: { abortSignal?: AbortSignal },
  ): Promise<string> => {
    const limit = maxChars ?? DEFAULT_MAX_CHARS;

    try {
      const res = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT },
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      if (!res.ok) {
        return JSON.stringify({
          error: `HTTP ${res.status}`,
          url,
        });
      }

      const contentType = res.headers.get("content-type") ?? "";
      const body = await readBody(res, abortSignal);

      let text: string;
      if (contentType.includes("application/json")) {
        text = body;
      } else {
        text = normalize(stripTags(body));
      }

      const truncated = text.length > limit;
      if (truncated) text = text.slice(0, limit);

      return JSON.stringify({
        url,
        status: res.status,
        truncated,
        length: text.length,
        text,
      });
    } catch (err: unknown) {
      if (err instanceof SsrfError) {
        return JSON.stringify({ error: `Blocked: ${err.message}`, url });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, url });
    }
  },
});
