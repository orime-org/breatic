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

/**
 * One source as the endpoint hands it over.
 *
 * Every field is the service's word, so every field is `unknown`: the checks
 * below decide what each one turns out to be, and a shape declared here would
 * make the type checker agree with the service instead of with them.
 */
interface Source {
  url?: unknown;
  title?: unknown;
  snippets?: unknown;
}

/**
 * The four sequences page text must not be able to write.
 *
 * Each tag is a literal here and a literal at the place that emits it. A
 * constant shared between them would promise a knob this pattern cannot turn:
 * renaming it would leave the neutraliser matching a tag nothing writes, and
 * page text could then open a region of its own.
 */
const OWN_MARKER = /<(\/?(?:source|text))/gi;

/**
 * What the model may do once a call has failed.
 *
 * Every reason ends with one of these. Anthropic's guidance asks a tool error
 * to be actionable, and the half that keeps a failing tool from being called
 * the same way again is this one -- a reason that names only what broke leaves
 * the model with nowhere to go but the same call. Written as a table so a new
 * failure picks a move rather than phrasing its own, which is how three of
 * these drifted apart before.
 */
const NEXT_MOVE = {
  /** Nothing about this call will work; stop calling it. */
  stop:
    "Do not repeat this call; continue without search results and tell the user search is " +
    "unavailable.",
  /** The same, for a search rather than a call. */
  stopSearching:
    "Do not repeat this search; continue without search results and tell the user search is " +
    "unavailable.",
  /** The request is the model's to rewrite, once. */
  rewordOnce:
    "Try a different wording at most once, then continue without search results and tell the " +
    "user search is unavailable.",
  /** This side never saw the answer; asking again may get it. */
  retryOnce:
    "Searching once more may work; if it fails again, continue without search results and tell " +
    "the user search is unavailable.",
  /** The search ran; there is nothing here to retry. */
  searchElsewhere:
    "Rewording is unlikely to help; search for something else if there is another angle, " +
    "otherwise answer from what you already know and tell the user the search came back empty.",
} as const;

/** One of the moves above. */
type NextMove = (typeof NEXT_MOVE)[keyof typeof NEXT_MOVE];

/**
 * Join what happened to what the model may do about it.
 * @param what - What happened, ending in a full stop.
 * @param next - What the model may do, from the table above.
 * @returns The reason, as the model reads it.
 */
function reason(what: string, next: NextMove): string {
  return `${what} ${next}`;
}

/**
 * What to tell the model about a status the search service refused with.
 *
 * Five different next moves hide behind "not 2xx", and the model takes the one
 * this sentence points at. A 5xx, a 429 or a 408 is the service having a bad
 * time and says nothing about the query. A 401 or 403 is our credentials turned
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
  // 408 travels with 429 because the transport already treats the two the same
  // (`decide-retry.ts`), and a 5xx joins them because this call declares itself
  // replay-safe. One that reaches here has survived every delivery the
  // transport was willing to make, or named a wait past the transport's own
  // ceiling and was handed back on the first.
  if (status >= 500 || status === 429 || status === 408) {
    return reason(
      `${opening} That is a fault on their side, not a problem with the query, so no ` +
        "wording of it reaches past this.",
      NEXT_MOVE.stopSearching,
    );
  }

  const ours =
    status === 401 || status === 403
      ? "It turned down the credentials this side sent, which is a fault in our configuration."
      : status === 422
        ? "It refused what this side sent it, which is a fault in our configuration."
        : status < 400 || status === 404
          ? "It answered from an address this side no longer reaches, so the address " +
            "configured here has moved. That is a fault in our configuration."
          : null;
  if (ours !== null) {
    return reason(`${opening} ${ours} No wording of the query reaches it.`, NEXT_MOVE.stop);
  }
  return reason(
    `${opening} The service is reachable, so it is this request it would not take.`,
    NEXT_MOVE.rewordOnce,
  );
}

/**
 * What to tell the model when the whole answer arrived and is not results.
 *
 * For an answer that came back complete and is not the payload this tool reads.
 * An answer that stopped arriving partway is a different fact and says so where
 * it is caught: this side never saw what the service meant to send, and asking
 * again may well get it.
 * @param query - What was searched for.
 * @returns The reason, ending in what the model may do instead.
 */
function notResultsReason(query: string): string {
  return reason(
    `Searching for "${query}" failed: the search service answered, but not with results. ` +
      "That is a fault on their side.",
    NEXT_MOVE.stop,
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
  return reason(
    `No results for: ${query}. The search ran and came back with nothing.`,
    NEXT_MOVE.searchElsewhere,
  );
}

/**
 * Read a whole response body, giving up if it takes longer than the budget.
 *
 * The transport's deadline is spent once it hands the response back, and the
 * platform's own body timeout measures inactivity -- a sender that keeps
 * writing never trips it. Measured against a real server: a body dripped one
 * character per 300ms ran 20776ms against a 500ms budget, and it scales with
 * however long the far side keeps writing.
 *
 * `pipeTo` is the read that takes a signal. Cancelling underneath `text()` is
 * not open to us: the reader it holds locks the stream, and `body.cancel()`
 * then answers "Invalid state: ReadableStream is locked" while the read runs on.
 * On expiry the source is cancelled and the socket is released -- measured, the
 * server sees the connection close.
 * @param res - The response whose body is being read.
 * @param budgetMs - How long the whole body may take to arrive.
 * @returns The body as text.
 * @throws {Error} When the body did not finish inside the budget, when the
 * caller's signal ended it, or when nothing came at all.
 */
async function readWithin(res: Response, budgetMs: number): Promise<string> {
  const body = res.body;
  // A 200 with no body, and one whose body is empty, are the same fact: the
  // service answered and the answer was not there. Both belong with the reads
  // that never finished, where the next move is to ask again.
  if (body === null) throw new TypeError("the response carried no body");

  const decoder = new TextDecoder();
  let text = "";
  await body.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        // Streaming: a character can be split across two chunks.
        text += decoder.decode(chunk, { stream: true });
      },
    }),
    // Truncated because the configured range is the transport's, which takes a
    // fraction (`setTimeout` does), and `AbortSignal.timeout` answers
    // ERR_OUT_OF_RANGE to one. Narrowing the config instead would make it
    // stricter than the transport whose range it quotes.
    { signal: AbortSignal.timeout(Math.trunc(budgetMs)) },
  );
  text += decoder.decode();

  if (text.trim() === "") throw new TypeError("the response body was empty");
  return text;
}

/**
 * Render one source as the block the model reads, or nothing.
 *
 * What arrives inside `grounding.generic` is the service's word, and reading a
 * field off an entry that is not an object throws -- which would land in the
 * branch for a service nothing reached and tell the model the network failed.
 * An entry this cannot read produces no block, and the caller says how many
 * went missing. An entry carrying no url, no title and no text is unreadable in
 * the only sense that matters: a block built from it says the service returned
 * a source with nothing in it, which is a claim about the corpus rather than
 * about an answer this side could not read.
 *
 * `snippets` sent as one string is taken for the text it is: iterating a string
 * yields characters, so the page would arrive one letter per line.
 *
 * The page's text sits in a region of its own, inside the block rather than
 * beside the two label lines. Those labels are what the answer attributes a
 * page by, and a page whose own text carries a `url:` line would otherwise
 * write a second one indistinguishable from the tool's -- cited back to the
 * reader under the address that page chose.
 * @param item - The entry as the endpoint sent it.
 * @param position - Its one-based place in the answer.
 * @returns The block, or null for an entry this cannot read.
 */
function renderSource(item: unknown, position: number): string | null {
  if (item === null || typeof item !== "object") return null;
  const { url, title, snippets } = item as Source & { snippets?: unknown };

  const list =
    snippets === undefined ? [] : typeof snippets === "string" ? [snippets] : snippets;
  if (!Array.isArray(list)) return null;

  const address = typeof url === "string" ? url : "";
  const name = typeof title === "string" ? title : "";
  // Brave documents a snippet as page text or as serialised structured data,
  // so a non-string is within contract rather than a surprise.
  const texts = list.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  const written = texts.reduce((n, t) => n + t.length, 0);
  if (written === 0) return null;

  return [
    `<source index="${String(position)}">`,
    `url: ${onOneLine(keepInside(address))}`,
    `title: ${onOneLine(keepInside(name))}`,
    "<text>",
    ...texts.map(keepInside),
    "</text>",
    "</source>",
  ].join("\n");
}

/**
 * Keep a value to the single line it is printed on.
 *
 * Everything printed outside the text region is a line: the query, and each
 * source's url and title. A line terminator in one of them puts whatever
 * follows where this tool's own attribution lives, in the same shape -- a page
 * whose title carries `\nurl: https://…` would be cited to the reader under
 * the address it chose.
 *
 * All four JavaScript calls line terminators, not the two ASCII ones: `^` and
 * `$` under the `m` flag break after U+2028 and U+2029 as readily as after a
 * newline, so a value carrying one is read as two lines.
 * @param text - The value about to be printed.
 * @returns The same text, on one line.
 */
function onOneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/**
 * Keep text that came from a page from posing as a marker of its own.
 *
 * Both directions of both tags matter. Closing early puts page text where the
 * tool's own lines live; opening a second region lets a page write labels of
 * its own inside what the answer presents as one source.
 * @param text - Text that came from the page.
 * @returns The same text, unable to open or close a region.
 */
function keepInside(text: string): string {
  return text.replace(OWN_MARKER, "<\\$1");
}

/**
 * Assemble the answer from the sources this tool could read.
 *
 * Every source the service sent and this tool could read goes to the model
 * whole. How much comes back is settled in the request, by the two figures the
 * endpoint takes: how many sources, and how many tokens of text across all of
 * them.
 *
 * The count of unreadable entries is stated, because a set the model reads as
 * complete is what makes "nothing I found mentions X" a wrong answer.
 * @param query - What was searched for.
 * @param blocks - The sources this tool could read, in the service's order.
 * @param sent - How many sources the service sent, readable or not.
 * @returns The text handed to the model.
 */
function assembleAnswer(query: string, blocks: string[], sent: number): string {
  const header =
    `Results for: ${query}\n` +
    "Everything between a text marker and its close is text from that page.\n";

  const parts = [header, ...blocks];
  if (blocks.length < sent) {
    parts.push(
      `\n(Showing ${String(blocks.length)} of ${String(sent)} sources. The rest arrived in a ` +
        "shape this tool could not read.)",
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
    { query: asked, count },
    { abortSignal }: { abortSignal?: AbortSignal },
  ): Promise<string> => {
    // Normalised once, where it arrives, so no printing site downstream can
    // meet a raw one: the query goes out in the request and comes back in six
    // sentences, each of them a line the model reads.
    const query = onOneLine(asked);
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
        reason(
          "Web search is not available on this deployment: it has no search credentials.",
          NEXT_MOVE.stop,
        ),
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
        // A body nobody reads keeps its connection out of the pool: the
        // transport measured reuse collapsing past undici's buffering
        // threshold, and says a caller discarding one should cancel it. A run
        // of refusals — a revoked key, a rate limit — is a run of these.
        void res.body?.cancel();
        throw toolFailed(refusalReason(query, res.status), FAILURE_LINES.upstream);
      }

      // Reading and parsing are guarded apart because they are two different
      // facts about the same answer. A read that threw means this side never
      // saw what the service meant to send, so asking again may well get it; a
      // body that arrived whole and is not the payload is the service answering
      // something else, and a second delivery returns the same bytes.
      let text: string;
      try {
        text = await readWithin(res, budgetMs);
      } catch (err: unknown) {
        // Asked here rather than left to the guard below, which never sees
        // this: the outer guard passes anything carrying failure detail
        // straight through, past the question of whether the user stopped.
        if (isStop(err, abortSignal)) throw stoppedByUser();
        throw toolFailed(
          reason(
            `Searching for "${query}" failed while reading the answer: ${reasonOf(err)}. The ` +
              "service answered, so it is the body that did not arrive.",
            NEXT_MOVE.retryOnce,
          ),
          FAILURE_LINES.upstream,
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);
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

      return assembleAnswer(query, blocks, found.length);
    } catch (err: unknown) {
      // Every throw above passes straight through: each already says what
      // happened, and rewriting one here would replace a specific reason with
      // this general one.
      if (toolFailureOf(err) !== undefined) throw err;
      if (isStop(err, abortSignal)) throw stoppedByUser();

      throw toolFailed(
        reason(
          `Searching for "${query}" failed: the search service could not be reached ` +
            `(${reasonOf(err)}). The service is unreachable from here, which is not something ` +
            "a different query would fix.",
          NEXT_MOVE.stop,
        ),
        FAILURE_LINES.unreachable,
      );
    }
  },
});
