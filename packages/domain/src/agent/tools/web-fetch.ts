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
import { convert } from "html-to-text";
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

/*
 * There used to be a `DEFAULT_MAX_CHARS = 60_000` here, while
 * `config/agent.yaml` carried `web_fetch_max_chars: 50000` that nothing ever
 * read. Two numbers for one limit, disagreeing, and the one an operator could
 * actually change was the dead one.
 *
 * The yaml is now the only copy the TOOL reads. There is still a second
 * literal — the `.default()` in core's zod schema — and saying otherwise here
 * was wrong. That one is the schema's answer for a deployment whose yaml omits
 * the key, which is a different question from "what does the tool use", and
 * it is where every other knob in that file keeps its default too.
 */

/**
 * Per-attempt ceiling for one page fetch. Still a literal here; task #22
 * moves every tool's timeout into `config/agent.yaml` in one pass.
 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Turn a page into the readable text the model is meant to see.
 *
 * A real HTML parser, not a set of regular expressions, and that is the whole
 * point. The hand-written version used `/<script[\s\S]*?<\/script>/` — for
 * every `<script` with no closing tag the lazy scan runs to the end of the
 * input, so N such tags cost N × the document. Measured on 2.3 MiB of
 * `<script ` (comfortably under this tool's byte ceiling): over 120 seconds of
 * unbroken synchronous work, during which the process serves nobody. The URL
 * comes from the model, so those bytes come from whoever owns that host.
 *
 * `html-to-text` (MIT) was measured against the same inputs before being
 * chosen, and against `node-html-parser`, which looked faster on the first two
 * cases and then took 25 seconds on one pathological document and 24 on an
 * ordinary 4 MiB page — worse than what it would have replaced. The winner
 * bounds every case tried: 31ms, 19ms, 150ms, and 339ms on a 4 MiB page.
 * @param html - Raw HTML source.
 * @returns The readable text.
 */
function readableText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      // Neither is readable content, and both used to reach the model as if
      // they were whenever the regex failed to pair up a tag.
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      // The library uppercases headings by default, which is a plain-text
      // EMAIL convention. The consumer here is a model, and shouting the
      // heading destroys information rather than adding it: nothing downstream
      // can then tell a heading that was genuinely written in capitals from
      // one a formatter shouted.
      ...(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((tag) => ({
        selector: tag,
        options: { uppercase: false },
      })),
    ],
  }).trim();
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
      // The configured value is a CEILING, not a starting point. `maxChars ??
      // config` let the model name any figure it liked and win — so an operator
      // who set 50000 could be handed ten million, and CONFIGURATION.md said
      // the tool argument could only lower it. It narrows; it never widens.
      const limit = Math.min(
        maxChars ?? agentCfg.web_fetch_max_chars,
        agentCfg.web_fetch_max_chars,
      );
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
        text = readableText(body);
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
        // Deliberately NOT the guard's own message. It names the address the
        // hostname resolved to — "Blocked IP range 'linkLocal' for
        // 169.254.169.254" — and this string goes straight back to the model.
        // Handing that over turns the tool into an internal-address oracle:
        // ask for a name, learn where it points. The detailed message still
        // exists on the thrown error for whoever logs it.
        return JSON.stringify({
          error: "Blocked: this URL is not permitted",
          url,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, url });
    }
  },
});
