// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Web search tool — Brave's LLM context endpoint.
 *
 * The endpoint returns extracted page text per source rather than the short
 * blurbs a result listing carries, which is what lets one call answer a
 * question that used to take a search followed by a fetch.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { env, getAgentConfig } from "@breatic/core";
import { FAILURE_LINES, httpRequest, toolFailureOf } from "@breatic/shared";
import { isStop, reasonOf, stoppedByUser, toolFailed } from "@domain/agent/tools/failure.js";

/**
 * What the model may ask this tool to search for.
 *
 * The query has a lower bound and no upper one because that is what the
 * service enforces: it answers 422 `too_short` for an empty `q`, while a query
 * past its documented length limits comes back 200. A bound we invented would
 * only turn working calls away; the one below turns an answerless round trip
 * into the SDK's own input error, which is the signal that says: write a query.
 */
const inputSchema = z.object({
  query: z.string().trim().min(1).describe("Search query"),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Number of sources to spread the answer over (1-10)"),
});

/** One source as the endpoint hands it over. */
interface Source {
  url?: string;
  title?: string;
  snippets?: unknown[];
}

/**
 * What to tell the model about a status the search service refused with.
 *
 * Four different next moves hide behind "not 2xx", and the model takes the one
 * this sentence points at. A 5xx or a 429 is the service having a bad time and
 * says nothing about the query. A 401, 403 or 422 is what this side sent being
 * turned down -- credentials or a parameter out of range, neither of which any
 * rewording reaches. A 3xx reaches this function at all because the redirect is
 * not followed (see the call below), and means the address held here has moved.
 * What is left is this request being one the service would not take, which the
 * model wrote and can rewrite.
 * @param query - What was searched for.
 * @param status - The status the service answered with.
 * @returns The reason, ending in what the model may do instead.
 */
function refusalReason(query: string, status: number): string {
  const opening = `Searching for "${query}" failed: the search service answered HTTP ${status}.`;
  if (status >= 500 || status === 429) {
    return (
      `${opening} That is a fault on their side, not a problem with the query, so no ` +
      "wording of it reaches past this. Do not repeat this search; continue without " +
      "search results and tell the user search is unavailable."
    );
  }
  if (status === 401 || status === 403) {
    return (
      `${opening} It turned down the credentials this side sent, which is a fault in our ` +
      "configuration that no wording of the query reaches. Do not repeat this call; " +
      "continue without search results and tell the user search is unavailable."
    );
  }
  if (status === 422) {
    // The service answers 422 both for a subscription token it will not accept
    // and for a parameter outside its range, and its `detail` text is the same
    // either way -- so this says what is true of both rather than guessing.
    return (
      `${opening} It refused what this side sent it, which is a fault in our configuration ` +
      "that no wording of the query reaches. Do not repeat this call; continue without " +
      "search results and tell the user search is unavailable."
    );
  }
  if (status >= 300 && status < 400) {
    return (
      `${opening} It answered with a redirect this side does not follow, so the address ` +
      "configured here has moved. That is a fault in our configuration that no wording of " +
      "the query reaches. Do not repeat this call; continue without search results and " +
      "tell the user search is unavailable."
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
 * For an answer that came back complete and parsed, and is still not the shape
 * this tool reads. An answer that stopped arriving partway is a different fact
 * and says so where it is caught: this side never saw what the service meant to
 * send, and asking again may well get it.
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
 * What to tell the model when the search ran and found nothing.
 *
 * This is a state a model reaches on its own: a `site:` query aimed at a domain
 * with nothing on it answers 200 with an empty list. The next move is not the
 * obvious one -- rewording is what a model reaches for after an empty search,
 * and it changes nothing when the corpus simply has no such page.
 * @param query - What was searched for.
 * @returns The answer, ending in what the model may do instead.
 */
function noResultsAnswer(query: string): string {
  return (
    `No results for: ${query}. The search ran and came back with nothing. Rewording is ` +
    "unlikely to help; search for something else if there is another angle, otherwise " +
    "answer from what you already know and tell the user the search came back empty."
  );
}

/**
 * Render one source as the block the model reads.
 * @param item - The source as the endpoint sent it.
 * @param position - Its one-based place in the answer.
 * @returns The block, without a trailing separator.
 */
function renderSource(item: Source, position: number): string {
  const lines = [`${String(position)}. ${item.title ?? ""}`, `   ${item.url ?? ""}`];
  for (const snippet of item.snippets ?? []) {
    // Brave documents a snippet as page text or as serialised structured data,
    // so a non-string is within contract rather than a surprise.
    lines.push(`   ${typeof snippet === "string" ? snippet : JSON.stringify(snippet)}`);
  }
  return lines.join("\n");
}

/**
 * Assemble the answer, dropping whole sources until it fits.
 *
 * The ceiling follows the configured token budget rather than sitting at a
 * fixed figure: a legal answer scales with that budget (measured at 3.2 to 3.7
 * characters per token), so a fixed number would cut into what operations
 * themselves asked for. At four characters per token every answer that respects
 * the parameter stays under it, and only one that ignores it arrives here.
 *
 * Sources go whole or not at all, and the count of the dropped ones is stated.
 * A cut in the middle of a source hands the model half a sentence as if it were
 * what that page said; a silent drop makes "nothing I found mentions X" a wrong
 * answer when X was in the part that never arrived.
 * @param query - What was searched for.
 * @param sources - The sources the endpoint returned, in its own order.
 * @returns The text handed to the model.
 */
function assembleAnswer(query: string, sources: Source[]): string {
  const ceiling = getAgentConfig().web_search_max_tokens * 4;
  const header = `Results for: ${query}\n`;
  const blocks = sources.map((item, i) => renderSource(item, i + 1));

  let kept = blocks.length;
  // One source always survives: an answer that carries nothing is worse than
  // one over the ceiling, and reaching that point already means the service
  // ignored the size asked of it.
  while (kept > 1 && [header, ...blocks.slice(0, kept)].join("\n").length > ceiling) {
    kept -= 1;
  }

  const parts = [header, ...blocks.slice(0, kept)];
  if (kept < blocks.length) {
    parts.push(
      `\n(${String(blocks.length - kept)} of ${String(blocks.length)} sources were dropped: ` +
        "the answer was larger than this tool passes on. Search again with a narrower query " +
        "if what you need is missing.)",
    );
  }
  return parts.join("\n");
}

/**
 * Search the web using Brave's LLM context endpoint.
 *
 * Returns each source's own page text, which is what the model reads.
 * Requires the `BRAVE_SEARCH_API_KEY` environment variable.
 */
export const webSearch: Tool<z.infer<typeof inputSchema>, string> = tool({
  description: "Search the web. Returns the text of the pages that answer the query.",
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
          "Do not repeat this call. Answer from what you already know, and tell the user " +
          "you could not search.",
        FAILURE_LINES.generic,
      );
    }

    const n = Math.min(Math.max(count ?? 5, 1), 10);

    try {
      const url = new URL("https://api.search.brave.com/res/v1/llm/context");
      url.searchParams.set("q", query);
      // How many sources the same volume of text is spread over.
      url.searchParams.set("maximum_number_of_urls", String(n));
      // How much text comes back. Both ends of this key's range are the
      // service's own (it rejects below 1024 and states 32768 as its ceiling),
      // so a figure that reaches here is one it will take.
      url.searchParams.set(
        "maximum_number_of_tokens",
        String(getAgentConfig().web_search_max_tokens),
      );

      // Through the shared transport, which owns the retrying. A search is a
      // read: its only effect is the response, so a delivery that produced
      // none produced no effect to repeat — which is what `replaySafe` states.
      //
      // The budget goes in as `timeoutMs` rather than as a signal on the init:
      // the transport replaces the caller's signal, so one left there would be
      // a no-op and this search would silently get the transport's default
      // instead of the figure below. That figure bounds ONE DELIVERY, not the
      // whole search — the transport may deliver this request more than once
      // and gives each of them the full budget.
      //
      // `redirect: "manual"` is not a detail of this endpoint. The Fetch
      // specification strips only Authorization, Cookie and Proxy-Authorization
      // across origins, so a custom header travels: following a 301 would carry
      // the subscription token to whatever host the redirect names. We never
      // intend to leave this host, so a 3xx is a refusal (see refusalReason).
      const res = await httpRequest(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          redirect: "manual",
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
        // service answered and the answer did not finish.
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
      // A search that found nothing has one observed shape: `generic` present
      // and empty. A body without it is the service answering something other
      // than this endpoint's payload -- a moved schema, or something else in
      // its place. Calling that "found nothing" would report an absence of
      // pages when what happened is an answer this side could not read.
      const found: unknown = (data as { grounding?: { generic?: unknown } }).grounding?.generic;
      if (!Array.isArray(found)) {
        throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);
      }
      if (found.length === 0) return noResultsAnswer(query);

      return assembleAnswer(query, found as Source[]);
    } catch (err: unknown) {
      // Every throw above passes straight through: each already says what
      // happened, and rewriting one here would replace a specific reason with
      // this general one.
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
