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
import { FAILURE_LINES, HttpRetryError, toolFailureOf } from "@breatic/shared";
import { isStop, reasonOf, stoppedByUser, toolFailed } from "@domain/agent/tools/failure.js";
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
        // What the status says about the page, and what it says about the
        // server, are different facts and lead to different next moves. A 503
        // from a site that is down says nothing at all about whether the page
        // exists, and the model passes whatever it reads here on to the reader
        // in its own words.
        //
        // How many deliveries this status cost is left out, and for most of
        // them the answer is one: the transport replays only 429, 408 and
        // 5xx, so every other status here arrives from a single delivery.
        // The number is not visible from here in any case.
        const theirSide = res.status >= 500 || res.status === 429;
        throw toolFailed(
          theirSide
            ? `Fetching ${url} failed: the site answered HTTP ${res.status}, which is a fault ` +
                "on their side and says nothing about this page. Do not repeat this fetch; " +
                "tell the user the site is not answering, and that it may work later."
            : `Fetching ${url} failed: the site answered HTTP ${res.status}. The address is ` +
                "reachable, so it is this page that is not there or not open to us. Do not " +
                "fetch the same address again; try another source, or tell the user this " +
                "page could not be read.",
          FAILURE_LINES.upstream,
        );
      }

      // Read inside its own guard. It answered, so whatever goes wrong from
      // here is about what it said; the catch below describes an address that
      // could not be reached at all, which this one just was.
      //
      // The signal handed to `safeFetch` above is still attached to this
      // response's body — the transport composes it into the request and that
      // link outlives the call, which is a guarantee its own boundary doc
      // states. So a stop ends this read too, and it is told apart here from
      // the body simply dying.
      const contentType = res.headers.get("content-type") ?? "";
      let body: string;
      try {
        body = await res.text();
      } catch (err: unknown) {
        if (isStop(err, abortSignal)) throw stoppedByUser();
        throw toolFailed(
          `Fetching ${url} failed while reading the page: ${reasonOf(err)}. The site answered, ` +
            "so the address is good and it is the page body that did not arrive. Fetching it " +
            "once more may work; if it fails again, tell the user this page could not be read.",
          FAILURE_LINES.upstream,
        );
      }

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
      // The throw above already said what happened; restating it here as a
      // general failure would lose the status it carries.
      if (toolFailureOf(err) !== undefined) throw err;
      if (isStop(err, abortSignal)) throw stoppedByUser();

      if (err instanceof SsrfError && err.aboutTheAddress) {
        // Deliberately vague, and the one place where the model is told less
        // than we know. One of the refusals that lands here came from
        // resolving the name, so the error can name an address inside the
        // network -- handing that back would make this tool a way to read the
        // inside of it from outside. The other two (a hostname on the block
        // list, a literal address in the URL) name only what the model wrote,
        // and they take the same vague sentence so that which one it was
        // cannot be read off the wording.
        // Which address it was is dropped here rather than recorded: a tool
        // is library code and writes no logs, and nothing upstream is handed
        // the original error either.
        throw toolFailed(
          `Fetching ${url} was refused: this address is not one that may be fetched. ` +
            "Variations of it will be refused too. If the user needs this page, tell them " +
            "it cannot be read from here.",
          FAILURE_LINES.blocked,
        );
      }

      if (err instanceof SsrfError) {
        // The rest of what this guard rejects is a plain fact about the
        // request -- a name with no DNS records, a scheme it does not speak, a
        // redirect chain that never ends. Told plainly, because each one asks
        // for a different next move and only the model can make it.
        throw toolFailed(
          `Fetching ${url} failed: ${err.message}. Do not retry the same address; correct it ` +
            "if it was mistyped, otherwise try another source or tell the user this page " +
            "could not be read.",
          FAILURE_LINES.unreachable,
        );
      }

      if (err instanceof HttpRetryError) {
        // Deliveries were made and none of them came back. The address is
        // where the problem is, and no rewording of the request reaches it.
        throw toolFailed(
          `Fetching ${url} failed: ${reasonOf(err)}. Do not retry it; try another source, or ` +
            "tell the user the page could not be read.",
          FAILURE_LINES.unreachable,
        );
      }

      // Left over, and it is two groups rather than one. What the transport
      // refuses before delivering anything -- a URL carrying credentials, a
      // deadline no timer can hold, named in its own boundary doc -- and
      // whatever the reading of an answer throws, since stripping, truncating
      // and re-encoding the body all sit inside this same `try`. Neither
      // group says the address is not there, which is what the model is told;
      // both are things the request or the answer did, and the model wrote
      // the request.
      throw toolFailed(
        `Fetching ${url} produced no page: ${reasonOf(err)}. This is about the request or ` +
          "about the shape of what came back, not about whether the address exists. If the " +
          "request can be corrected, correct it and fetch once more; otherwise tell the user " +
          "this page could not be read.",
        // Not `unreachable`: that line is for an address that was reached for
        // and did not answer. Nothing here was reached for at all, and a
        // reader told otherwise would have the wrong idea of what to retry.
        FAILURE_LINES.generic,
      );
    }
  },
});
