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
 *
 * `count` carries its default here rather than in the tool body, so the range
 * and the value chosen inside it are one statement the SDK enforces.
 */
const inputSchema = z.object({
  query: z.string().trim().min(1).describe("Search query"),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("How many sources to spread the same amount of text over (1-10)"),
});

/** One source as the endpoint hands it over. */
interface Source {
  url?: string;
  title?: string;
  snippets?: unknown[];
}

/**
 * How many raw bytes of answer this tool will read.
 *
 * Per configured token, against a body measured at 3.7 to 7.5 bytes per token
 * across the whole legal range (the ratio is worst at the 1024 floor, where the
 * envelope dominates). Sixteen leaves better than twice the headroom over that
 * worst case at every setting, so only a body the service was never asked for
 * arrives here.
 *
 * Separate from the ceiling on the assembled answer, which bounds what the
 * model reads; this bounds what the process holds while parsing.
 */
const BYTES_READ_PER_TOKEN = 16;

/** Room kept for the line that says how many sources are missing. */
const MISSING_NOTE_RESERVE = 220;

/** The tag each source's own text is placed inside. */
const SOURCE_TAG = "source";

/**
 * What to tell the model about a status the search service refused with.
 *
 * Five different next moves hide behind "not 2xx", and the model takes the one
 * this sentence points at. A 5xx or a 429 is the service having a bad time and
 * says nothing about the query. A 401 or 403 is our credentials being turned
 * down; a 422 is what this side sent being refused, for a token it will not
 * accept or a parameter out of range, and its `detail` text is the same either
 * way. A 3xx reaches this function at all because the redirect is not followed
 * (see the call below), and means the address held here has moved. What is left
 * is this request being one the service would not take, which the model wrote
 * and can rewrite.
 * @param query - What was searched for.
 * @param status - The status the service answered with.
 * @returns The reason, ending in what the model may do instead.
 */
function refusalReason(query: string, status: number): string {
  const opening = `Searching for "${query}" failed: the search service answered HTTP ${status}.`;
  const ours =
    status === 401 || status === 403
      ? "It turned down the credentials this side sent, which is a fault in our configuration."
      : status === 422
        ? "It refused what this side sent it, which is a fault in our configuration."
        : status >= 300 && status < 400
          ? "It answered with a redirect this side does not follow, so the address configured " +
            "here has moved. That is a fault in our configuration."
          : null;

  if (status >= 500 || status === 429) {
    return (
      `${opening} That is a fault on their side, not a problem with the query, so no ` +
      "wording of it reaches past this. Do not repeat this search; continue without " +
      "search results and tell the user search is unavailable."
    );
  }
  if (ours !== null) {
    return (
      `${opening} ${ours} No wording of the query reaches it. Do not repeat this call; ` +
      "continue without search results and tell the user search is unavailable."
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
 * Read a response body under both a byte cap and a deadline.
 *
 * The transport's deadline is spent once it hands the response back, and its
 * retry budget covers deliveries rather than bytes -- so without this a body
 * fed one byte at a time holds the turn open for as long as the far side keeps
 * sending, and a body of any size is materialised whole.
 * @param res - The response whose body is being read.
 * @param query - What was searched for, for the reasons thrown from here.
 * @param maxBytes - How many bytes to accept before giving up.
 * @param budgetMs - How long the whole body may take to arrive.
 * @param abortSignal - The turn's signal, if the caller passed one.
 * @returns The body as text.
 * @throws {Error} Carrying tool-failure detail when the body is too large, or
 * did not finish inside the budget.
 */
async function readBoundedBody(
  res: Response,
  query: string,
  maxBytes: number,
  budgetMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const body = res.body;
  // Some responses carry no stream at all (a 204, or a test double built from
  // a string in an environment without one). Nothing to bound.
  if (!body) return res.text();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;

  const ranOut = new AbortController();
  const timer = setTimeout(() => {
    ranOut.abort(new Error(`the body did not finish inside ${String(budgetMs)}ms`));
  }, budgetMs);

  /**
   * Settle when the read should stop, whoever asked.
   * @returns A promise that only ever rejects.
   */
  const stopped = (): Promise<never> =>
    new Promise((_resolve, reject) => {
      /**
       * Reject with what the signal that fired carries.
       * @param signal - The one that aborted.
       */
      const quit = (signal: AbortSignal): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      for (const signal of [ranOut.signal, abortSignal]) {
        if (signal === undefined) continue;
        if (signal.aborted) quit(signal);
        else signal.addEventListener("abort", () => { quit(signal); }, { once: true });
      }
    });

  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stopped()]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw toolFailed(
          `Searching for "${query}" failed: the search service sent more than it was asked ` +
            `for (over ${String(maxBytes)} bytes). That is a fault on their side, and asking ` +
            "again gets the same answer. Do not repeat this call; continue without search " +
            "results and tell the user search is unavailable.",
          FAILURE_LINES.upstream,
        );
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // The stream is already gone, which is the state cancelling asks for.
    }
  }
}

/**
 * Render one source as the block the model reads, or nothing.
 *
 * What arrives inside `grounding.generic` is the service's word, and reading a
 * field off an entry that is not an object throws -- which would land in the
 * branch for a service nothing reached and tell the model the network failed.
 * An entry this cannot read produces no block, and the caller says how many
 * went missing.
 *
 * `snippets` sent as one string is taken for the text it is: iterating a string
 * yields characters, so the page would arrive one letter per line.
 * @param item - The entry as the endpoint sent it.
 * @param position - Its one-based place in the answer.
 * @returns The block, or null when the entry is not one this can read.
 */
function renderSource(item: unknown, position: number): string | null {
  if (item === null || typeof item !== "object") return null;
  const { url, title, snippets } = item as Source & { snippets?: unknown };

  const list =
    snippets === undefined ? [] : typeof snippets === "string" ? [snippets] : snippets;
  if (!Array.isArray(list)) return null;

  const lines = [
    `<${SOURCE_TAG} index="${String(position)}">`,
    `url: ${keepInside(typeof url === "string" ? url : "")}`,
    `title: ${keepInside(typeof title === "string" ? title : "")}`,
  ];
  for (const snippet of list) {
    // Brave documents a snippet as page text or as serialised structured data,
    // so a non-string is within contract rather than a surprise.
    lines.push(keepInside(typeof snippet === "string" ? snippet : JSON.stringify(snippet)));
  }
  lines.push(`</${SOURCE_TAG}>`);
  return lines.join("\n");
}

/**
 * Keep text that came from a page from closing the block it sits in.
 *
 * The tool's own sentences are the ones outside these blocks, so a page that
 * writes them verbatim is read as a page saying them. That holds only while the
 * page cannot end its own block early, which is the one sequence neutralised
 * here -- the standard practice for delimiting retrieved content, and the whole
 * of it: nothing else a page can write reaches past the closing tag.
 * @param text - Text that came from the page.
 * @returns The same text, unable to close the block.
 */
function keepInside(text: string): string {
  return text.replace(new RegExp(`</${SOURCE_TAG}`, "gi"), `<\\/${SOURCE_TAG}`);
}

/**
 * Assemble the answer, keeping whole sources until it fits.
 *
 * The ceiling follows the configured token budget rather than sitting at a
 * fixed figure: a legal answer scales with that budget (measured at 3.2 to 3.7
 * characters per token), so a fixed number would cut into what operations
 * themselves asked for. At four characters per token every answer that respects
 * the parameter stays under it, and only one that ignores it arrives here.
 *
 * Sources go whole or not at all, and the count of the missing ones is stated.
 * A cut in the middle of a source hands the model half a sentence as if it were
 * what that page said; a silent drop makes "nothing I found mentions X" a wrong
 * answer when X was in the part that never arrived. Both a source left out for
 * size and one the service sent in an unreadable shape are missing in the only
 * sense the model can act on, so one line covers them.
 * @param query - What was searched for.
 * @param blocks - The sources this tool could read, in the service's order.
 * @param sent - How many sources the service sent, readable or not.
 * @param ceiling - How many characters the assembled answer may take.
 * @returns The text handed to the model.
 */
function assembleAnswer(
  query: string,
  blocks: string[],
  sent: number,
  ceiling: number,
): string {
  const header =
    `Results for: ${query}\n` +
    "Everything between a source marker and its close is text from that page.\n";

  // One pass, and the room the missing-sources line needs is counted before
  // the line exists, so the assembled answer stays under the ceiling in the
  // one case the ceiling is there for.
  let used = header.length;
  let kept = 0;
  for (const block of blocks) {
    used += block.length + 1;
    // One source always survives: an answer carrying nothing is worse than one
    // over the ceiling, and reaching that point already means the service
    // ignored the size it was asked for.
    if (kept > 0 && used > ceiling - MISSING_NOTE_RESERVE) break;
    kept += 1;
  }

  const parts = [header, ...blocks.slice(0, kept)];
  if (kept < sent) {
    parts.push(
      `\n(Showing ${String(kept)} of ${String(sent)} sources. The rest were left out because ` +
        "the answer was larger than this tool passes on, or arrived in a shape it could not " +
        "read. Search again with a narrower query if what you need is missing.)",
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
  description:
    "Search the web. Returns the text of the pages that answer the query. `count` spreads " +
    "that text over more sources; it does not get more of it.",
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

    const { web_search_max_tokens: maxTokens, web_search_timeout_ms: budgetMs } =
      getAgentConfig();

    try {
      const url = new URL("https://api.search.brave.com/res/v1/llm/context");
      url.searchParams.set("q", query);
      // How many sources the same volume of text is spread over.
      url.searchParams.set("maximum_number_of_urls", String(count));
      // How much text comes back. Both ends of this key's range are the
      // service's own (it rejects below 1024 and states 32768 as its ceiling),
      // so a figure that reaches here is one it will take.
      url.searchParams.set("maximum_number_of_tokens", String(maxTokens));

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
          timeoutMs: budgetMs,
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
        const text = await readBoundedBody(
          res,
          query,
          maxTokens * BYTES_READ_PER_TOKEN,
          budgetMs,
          abortSignal,
        );
        data = JSON.parse(text);
      } catch (err: unknown) {
        // Asked here rather than left to the guard below, which never sees
        // this: what is thrown from inside this block already carries failure
        // detail, and the outer guard passes anything carrying detail straight
        // through -- past the question of whether the user stopped.
        if (toolFailureOf(err) !== undefined) throw err;
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

      const blocks = found
        .map((item, i) => renderSource(item, i + 1))
        .filter((block): block is string => block !== null);
      // Sources arrived and not one of them could be read: the answer is the
      // endpoint's payload in name only.
      if (blocks.length === 0) {
        throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);
      }

      return assembleAnswer(query, blocks, found.length, maxTokens * 4);
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
