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

/** How many characters of page text one configured token may pay for. */
const CHARS_PER_TOKEN = 5;

/**
 * The two sequences page text must not be able to write.
 *
 * The tag is a literal here and a literal at the two places that emit it. A
 * constant shared between them would promise a knob this pattern cannot turn:
 * renaming it would leave the neutraliser matching a tag nothing writes, and
 * page text could then open a block of its own.
 */
const SOURCE_MARKER = /<(\/?source)/gi;

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
  if (status >= 500 || status === 429) {
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
 * For an answer that came back complete and parsed, and is still not the shape
 * this tool reads. An answer that stopped arriving partway is a different fact
 * and says so where it is caught: this side never saw what the service meant to
 * send, and asking again may well get it.
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
  // A 200 carrying no stream is an answer that never arrived, which is the
  // class the caller already reads a failed read as. Throwing here keeps it
  // out of a path of its own that neither the cap nor the deadline covers.
  if (body === null) throw new TypeError("the response carried no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;

  // Composed once for the whole read. How many chunks a body arrives in is the
  // sender's choice, so a listener registered per chunk would grow with what
  // this function exists to bound -- and it would grow on the turn's signal,
  // which outlives this call and carries every other tool use in the turn.
  // `AbortSignal.any` is what the shared transport composes with too.
  const deadline = AbortSignal.timeout(budgetMs);
  const givenUp = abortSignal ? AbortSignal.any([deadline, abortSignal]) : deadline;
  const stopped = new Promise<never>((_resolve, reject) => {
    /** Reject with whatever the composed signal carries. */
    const quit = (): void => {
      reject(
        givenUp.reason instanceof Error
          ? givenUp.reason
          : new Error(`the body did not finish inside ${String(budgetMs)}ms`),
      );
    };
    if (givenUp.aborted) quit();
    else givenUp.addEventListener("abort", quit, { once: true });
  });

  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stopped]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw toolFailed(
          reason(
            `Searching for "${query}" failed: the search service sent more than it was asked ` +
              `for (over ${String(maxBytes)} bytes). That is a fault on their side, and asking ` +
              "again gets the same answer.",
            NEXT_MOVE.stop,
          ),
          FAILURE_LINES.upstream,
        );
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already gone, which is the state cancelling asks for.
    }
  }
}

/** One source as the model reads it, and how much of it the page wrote. */
interface RenderedSource {
  block: string;
  fromPage: number;
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
 * `fromPage` counts the characters the page wrote -- the two label values and
 * the text. It is what the ceiling bounds; the tags and the label names are
 * this tool's own words and are not charged to a third party's budget.
 * @param item - The entry as the endpoint sent it.
 * @param position - Its one-based place in the answer.
 * @returns The block and its weight, or null for an entry this cannot read.
 */
function renderSource(item: unknown, position: number): RenderedSource | null {
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
  // The line each snippet occupies counts too: how many snippets a source
  // carries is the service's choice, so a body of many tiny ones would
  // otherwise grow the answer without spending any of the budget.
  const fromPage =
    address.length + name.length + texts.reduce((n, t) => n + t.length + 1, 0);
  if (fromPage === 0) return null;

  const lines = [
    `<source index="${String(position)}">`,
    `url: ${keepInside(address)}`,
    `title: ${keepInside(name)}`,
    ...texts.map(keepInside),
    "</source>",
  ];
  return { block: lines.join("\n"), fromPage };
}

/**
 * Keep text that came from a page from posing as a block of its own.
 *
 * Both directions matter. Closing early puts page text where the tool's own
 * sentences live; opening a second block needs no escape at all, because
 * `url:` and `title:` are the tool's own lines -- a page that writes them is
 * read as a source of its own choosing and cited back to the reader under that
 * name.
 * @param text - Text that came from the page.
 * @returns The same text, unable to open or close a block.
 */
function keepInside(text: string): string {
  return text.replace(SOURCE_MARKER, "<\\$1");
}

/**
 * Assemble the answer, keeping whole sources until the page text fits.
 *
 * The ceiling follows the configured token budget rather than sitting at a
 * fixed figure: a legal answer scales with that budget (measured at 3.2 to 3.7
 * characters per token), so a fixed number would cut into what operations
 * themselves asked for. It is charged against the characters the pages wrote,
 * which is what a third party controls; the tags, the label names and this
 * line are the tool's own and would otherwise eat the budget operations set --
 * measured at the 1024 floor, framing alone took two of ten sources out of an
 * answer the service had delivered exactly as asked.
 *
 * Sources go whole or not at all, and the count of the missing ones is stated.
 * A cut in the middle of a source hands the model half a sentence as if it were
 * what that page said; a silent drop makes "nothing I found mentions X" a wrong
 * answer when X was in the part that never arrived. Both a source left out for
 * size and one the service sent in an unreadable shape are missing in the only
 * sense the model can act on, so one line covers them.
 * @param query - What was searched for.
 * @param sources - The sources this tool could read, in the service's order.
 * @param sent - How many sources the service sent, readable or not.
 * @param maxTokens - The configured budget the ceiling is derived from.
 * @returns The text handed to the model.
 */
function assembleAnswer(
  query: string,
  sources: RenderedSource[],
  sent: number,
  maxTokens: number,
): string {
  // Measured against the live service: everything the pages write -- snippet
  // text, its line, and the url and title printed beside it -- runs 3.65 to
  // 4.10 characters per configured token across the legal range, worst at the
  // 1024 floor over five sources where the per-source identification
  // dominates. Five leaves a fifth more than that worst case, so an answer
  // that respects the budget never reaches the ceiling and only one that
  // ignores it does.
  const ceiling = maxTokens * CHARS_PER_TOKEN;
  const header =
    `Results for: ${query}\n` +
    "Everything between a source marker and its close is text from that page.\n";

  let used = 0;
  let kept = 0;
  for (const source of sources) {
    used += source.fromPage;
    // One source always survives: an answer carrying nothing is worse than one
    // over the ceiling, and reaching that point already means the service
    // ignored the size it was asked for.
    if (kept > 0 && used > ceiling) break;
    kept += 1;
  }

  const parts = [header, ...sources.slice(0, kept).map((s) => s.block)];
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
          reason(
            `Searching for "${query}" failed while reading the answer: ${reasonOf(err)}. The ` +
              "service answered, so it is the body that did not arrive.",
            NEXT_MOVE.retryOnce,
          ),
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
        .filter((source): source is RenderedSource => source !== null);
      // Sources arrived and not one of them could be read: the answer is the
      // endpoint's payload in name only.
      if (blocks.length === 0) {
        throw toolFailed(notResultsReason(query), FAILURE_LINES.upstream);
      }

      return assembleAnswer(query, blocks, found.length, maxTokens);
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
