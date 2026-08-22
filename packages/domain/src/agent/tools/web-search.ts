// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Web search tool — Brave Search API.
 *
 * Ported from backend/agent/tools/builtin/web.py (WebSearchTool).
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { env, getAgentConfig } from "@breatic/core";
import { FAILURE_LINES, httpRequest, toolFailureOf } from "@breatic/shared";
import { isStop, reasonOf, stoppedByUser, toolFailed } from "@domain/agent/tools/failure.js";

/** What the model may ask this tool to search for. */
const inputSchema = z.object({
  query: z.string().describe("Search query"),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Number of results (1-10)"),
});

/**
 * What to tell the model about a status the search service refused with.
 *
 * Three different next moves hide behind "not 2xx", and the model takes the
 * one this sentence points at. A 5xx or a 429 is the service having a bad
 * time and says nothing about the query. A 401 or a 403 is the key this side
 * sent being turned down, which no rewording reaches. What is left is this
 * request being one the service would not take, which the model wrote and can
 * rewrite.
 * @param query - What was searched for.
 * @param status - The status the service answered with.
 * @returns The reason, ending in what the model may do instead.
 */
function refusalReason(query: string, status: number): string {
  const opening = `Searching for "${query}" failed: the search service answered HTTP ${status}.`;
  if (status >= 500 || status === 429) {
    return (
      `${opening} That is a fault on their side, not a problem with the query, so no ` +
      "wording of it reaches past this. Do not search again on this turn; continue " +
      "without search results and tell the user search is unavailable."
    );
  }
  if (status === 401 || status === 403) {
    return (
      `${opening} It turned down the credentials this side sent, which is a fault in our ` +
      "configuration that no wording of the query reaches. Do not call this tool again on " +
      "this turn; continue without search results and tell the user search is unavailable."
    );
  }
  return (
    `${opening} The service is reachable, so it is this request it would not take. Try a ` +
    "different wording at most once, then continue without search results and tell the " +
    "user search is unavailable."
  );
}

/**
 * What to tell the model when the whole answer arrived and is not results.
 *
 * For an answer that came back complete and parsed, and is still not the
 * shape this tool reads. An answer that stopped arriving partway is a
 * different fact and says so where it is caught: this side never saw what the
 * service meant to send, and asking again may well get it.
 * @param query - What was searched for.
 * @returns The reason, ending in what the model may do instead.
 */
function notResultsReason(query: string): string {
  return (
    `Searching for "${query}" failed: the search service answered, but not with results. ` +
    "That is a fault on their side. Continue without search results and tell the user search " +
    "is unavailable."
  );
}

/**
 * Search the web using the Brave Search API.
 *
 * Returns formatted results containing titles, URLs, and descriptions.
 * Requires the `BRAVE_SEARCH_API_KEY` environment variable.
 */
export const webSearch: Tool<z.infer<typeof inputSchema>, string> = tool({
  description: "Search the web. Returns titles, URLs, and snippets.",
  inputSchema,
  execute: async (
    { query, count },
    { abortSignal }: { abortSignal?: AbortSignal },
  ): Promise<string> => {
    // BRAVE_SEARCH_API_KEY is a typed config field (defaults to "");
    // read via the injected config Proxy, not process.env directly.
    const apiKey = env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      // Defensive: `buildToolSet` leaves this tool out of the set entirely
      // when the key is missing, so a turn should never reach here. The
      // reader's line is the one for a failure nothing described, because a
      // line of its own would exist for this branch alone -- five translations
      // of a sentence no reader is on a path to meet.
      throw toolFailed(
        "Web search is not available on this deployment: it has no search credentials. " +
          "Do not call this tool again on this turn. Answer from what you already know, " +
          "and tell the user you could not search.",
        FAILURE_LINES.generic,
      );
    }

    const n = Math.min(Math.max(count ?? 5, 1), 10);

    try {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(n));

      // Through the shared transport, which owns the retrying. A search is a
      // read: its only effect is the response, so a delivery that produced
      // none produced no effect to repeat — which is what `replaySafe` states.
      // That declaration is what buys the retry on a dropped connection, the
      // failure that used to fail this tool on the first try.
      //
      // The budget goes in as `timeoutMs` rather than as a signal on the init:
      // the transport replaces the caller's signal, so one left there would be
      // a no-op and this search would silently get the transport's default
      // instead of the figure below.
      //
      // That figure bounds ONE DELIVERY, not the whole search — the transport
      // may deliver this request more than once and gives each of them the
      // full budget. Same unit as safe-fetch.ts states for web_fetch; said
      // here too because a reader of this file meets the number here. It is
      // configuration rather than a literal because it is a knob operations
      // may want to turn without a deploy, and because how long a search may
      // take is not a fact about this code.
      //
      // The signal is separate from that budget and does not replace it: the
      // budget says how long one delivery may take, the signal says the answer
      // is no longer wanted at all.
      const res = await httpRequest(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        },
        {
          replaySafe: true,
          timeoutMs: getAgentConfig().web_search_timeout_ms,
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );

      if (!res.ok) {
        throw toolFailed(refusalReason(query, res.status), FAILURE_LINES.upstream);
      }

      // Read inside its own guard. It answered, so whatever goes wrong from
      // here is about what it said, and the catch below describes a service
      // that could not be reached at all.
      let data: unknown;
      try {
        data = await res.json();
      } catch (err: unknown) {
        // Asked here rather than left to the guard below, which never sees
        // this: what is thrown from inside this block already carries failure
        // detail, and the outer guard passes anything carrying detail straight
        // through -- past the question of whether the user stopped.
        if (isStop(err, abortSignal)) throw stoppedByUser();
        // The body stopped arriving partway. What it would have said is not
        // something this side ever saw, so it is put as what is known: the
        // service answered and the answer did not finish. Same reading the
        // fetch tool gives the same failure.
        throw toolFailed(
          `Searching for "${query}" failed while reading the answer: ${reasonOf(err)}. The ` +
            "service answered, so it is the body that did not arrive. Searching once more may " +
            "work; if it fails again, continue without search results and tell the user search " +
            "is unavailable.",
          FAILURE_LINES.upstream,
        );
      }

      if (data === null || typeof data !== "object") {
        throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);
      }
      // Brave declares the `web` section optional, and its reference says the
      // result types are "conditionally included based on data availability".
      // A query with no web results therefore comes back without the section
      // at all -- a search that succeeded and found nothing, which is what the
      // model is told. Present but not a list is a different thing: the schema
      // moved, or something else answered in its place.
      const found: unknown = (data as { web?: { results?: unknown } }).web?.results;
      if (found === undefined || found === null) return `No results found for: ${query}`;
      if (!Array.isArray(found)) throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);

      const results = (found as Array<{ title?: string; url?: string; description?: string }>).slice(
        0,
        n,
      );
      if (results.length === 0) return `No results found for: ${query}`;

      const lines = [`Results for: ${query}\n`];
      results.forEach((item, i) => {
        lines.push(`${i + 1}. ${item.title ?? ""}\n   ${item.url ?? ""}`);
        if (item.description) lines.push(`   ${item.description}`);
      });
      return lines.join("\n");
    } catch (err: unknown) {
      // The two throws above pass straight through: they already say what
      // happened, and rewriting them here would replace a specific reason
      // with this general one.
      if (toolFailureOf(err) !== undefined) throw err;
      if (isStop(err, abortSignal)) throw stoppedByUser();

      throw toolFailed(
        `Searching for "${query}" failed: the search service could not be reached ` +
          `(${reasonOf(err)}). ` +
          "The service is unreachable from here, which is not something a different query " +
          "would fix. Do not repeat this call; continue without search results and tell the " +
          "user search is unavailable.",
        FAILURE_LINES.unreachable,
      );
    }
  },
});
