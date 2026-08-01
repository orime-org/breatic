// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Web fetch tool — retrieve URL content as text.
 *
 * Ported from backend/agent/tools/builtin/web.py (WebFetchTool).
 * Uses {@link guardedFetch} to block SSRF against internal / metadata
 * endpoints on every hop (including redirects).
 */
import { tool } from "ai";
import { z } from "zod";
import { httpRequest } from "@breatic/shared";
import { getAgentConfig } from "@breatic/core";

import {
  guardedFetch,
  UnsupportedRequestError,
} from "@domain/agent/tools/guarded-fetch.js";
import { SsrfError } from "@domain/agent/tools/safe-fetch.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const DEFAULT_MAX_CHARS = 60_000;

/**
 * Per-attempt ceiling for one page fetch. Still a literal here; task #22
 * moves every tool's timeout into `config/agent.yaml` in one pass.
 */
const FETCH_TIMEOUT_MS = 30_000;

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
 * Fetch a URL and extract readable text content.
 *
 * Returns a JSON object with url, status, text length, and the
 * extracted content. HTML pages are stripped to plain text.
 *
 * The URL is validated and followed via {@link guardedFetch}, which
 * blocks any hop resolving to a private / loopback / link-local /
 * reserved / metadata IP — closing SSRF against internal services.
 */
export const webFetch = tool({
  description:
    "Fetch a URL and extract readable content (HTML to plain text). " +
    "Only public (non-private, non-loopback) HTTP/HTTPS hosts are permitted.",
  inputSchema: z.object({
    url: z.string().url().describe("URL to fetch"),
    maxChars: z
      .number()
      .int()
      .min(100)
      .optional()
      .describe("Max characters to return"),
  }),
  execute: async ({ url, maxChars }): Promise<string> => {
    try {
      // Read inside the try with everything else. Outside it, a malformed
      // agent.yaml escaped this tool as a raw throw, while every other failure
      // came back as the JSON envelope the model is built to read.
      const agentCfg = getAgentConfig();
      const limit = maxChars ?? DEFAULT_MAX_CHARS;
      const res = await httpRequest(
        url,
        { headers: { "User-Agent": USER_AGENT } },
        {
          // Fetching a page only reads, so a flaky attempt is safe to replay.
          replaySafe: true,
          // Someone is watching a chat turn wait on this. Without it the tool
          // took the sixty-second background ceiling, which is the figure for
          // work nobody is sitting in front of.
          interactive: true,
          timeoutMs: FETCH_TIMEOUT_MS,
          // The one caller on this transport that does not choose its own
          // URL: the model names the host, so how many bytes come back is
          // decided by whoever owns it. `limit` above is applied to a string
          // that is already in memory, which is no defence — this refuses the
          // bytes as they arrive.
          maxBodyBytes: agentCfg.web_fetch_max_bytes,
          // Every replay goes back through the SSRF guard.
          fetchImpl: guardedFetch,
          // A blocked address is blocked on every attempt — replaying it
          // would only burn the budget before returning the same refusal.
          // Both refusals are deterministic: a blocked address is blocked on
          // every attempt, and a request shape this seam cannot carry is one
          // it cannot carry three times either. Without the second clause the
          // transport would spend its whole budget re-hitting the same wall.
          isFatal: (err) =>
            err instanceof SsrfError || err instanceof UnsupportedRequestError,
          label: "web_fetch",
        },
      );

      if (!res.ok) {
        // Read and discard so the connection is released. An unread body holds
        // it until the peer gives up, and the guarded handle has no "throw
        // this away" member by design — draining is how a caller lets go.
        await res.text().catch(() => "");
        return JSON.stringify({
          error: `HTTP ${res.status}`,
          url,
        });
      }

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

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
