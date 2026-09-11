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
import { FAILURE_LINES, reasonOf, toolFailureOf } from "@breatic/shared";

import { braveJson } from "@domain/agent/tools/brave.js";
import {
  isStop,
  keepInside,
  nextMovesFor,
  notOurPayloadReason,
  onOneLine,
  reason,
  unreachableReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";
import type { FailureVoice } from "@domain/agent/tools/failure.js";

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
    .describe("How many sources to ask for (1-10)"),
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

/** One page this search found, as both consumers read it. */
export interface SearchSource {
  /** Where the page is. */
  url: string;
  /** What the page calls itself. */
  title: string;
  /** Who published it, for a row that names a publisher rather than a host. */
  publisher: string;
  /** Passages of the page's own text. Read by the model, never by the panel. */
  excerpts: string[];
  /**
   * Where this page sits in the turn's one space of numbers.
   *
   * The model writes `[N]` against what it was shown, and it is shown each
   * search as it comes back -- so a second search numbered from one would
   * hand it two sources called `1`, and the marker it wrote then would point
   * at two pages. Decided once, here, and read by everything downstream: the
   * rendering the model sees, and the chips the panel draws.
   */
  index: number;
}

/**
 * What one search answers with.
 *
 * Two consumers read this and they read different parts of it. The panel takes
 * the sources to draw the citation chips and the source row; the model reads
 * `renderSearchForModel`, which is the only place page text is turned into
 * markup. Neither consumer parses the other's form, which is what keeps the
 * rendering below free to change.
 *
 * `sent` counts what the service returned, readable or not: a set the model
 * reads as complete is what makes "nothing I found mentions X" a wrong answer.
 */
export interface SearchAnswer {
  /** What was searched for, on one line. */
  query: string;
  /** The pages this tool could read, in the service's order. */
  sources: SearchSource[];
  /** How many entries the service sent. */
  sent: number;
}

/**
 * The most text the endpoint will return for one source.
 *
 * Its own ceiling, measured: 8192 is taken and 8193 comes back 422. The
 * whole-search key runs four times higher, so a configured figure is held to
 * this one before it goes out as the per-source request.
 */
const MAX_TOKENS_PER_SOURCE = 8192;

/**
 * What stands between two excerpts of one page.
 *
 * The service returns a page as separate passages -- measured live, 6, 7, 25
 * and 40 of them for single sources -- and they are not adjacent in the page.
 * Joined by the separator that also divides the lines of one passage, they
 * read as continuous prose, which carries a claim neither passage made.
 */
const BETWEEN_EXCERPTS = "\n[...]\n";

/**
 * How this tool names what it does, in the sentences it fails with.
 *
 * Every one of these words was written into the failure text itself before a
 * second tool wanted the same sentences. They read the same as they did then;
 * what changed is that the phrasing is now stated once, here, rather than
 * being the only phrasing the shared text could have.
 */
const VOICE: FailureVoice = {
  act: "search",
  results: "search results",
  retrying: "Searching once more",
  elsewhere: "search for something else",
  attempting: "Searching for",
};

/** What the model may do once one of this tool's calls has failed. */
const MOVES = nextMovesFor(VOICE);

/**
 * Read one source out of the endpoint's payload, or nothing.
 *
 * What arrives inside `grounding.generic` is the service's word, and reading a
 * field off an entry that is not an object throws -- which would land in the
 * branch for a service nothing reached and tell the model the network failed.
 * An entry this cannot read produces nothing, and the answer says how many
 * went missing. An entry carrying no page text is unreadable in the only sense
 * that matters: a source built from it says the service returned a page with
 * nothing in it, which is a claim about the corpus rather than about an answer
 * this side could not read.
 *
 * `snippets` sent as one string is taken for the text it is: iterating a string
 * yields characters, so the page would arrive one letter per line.
 *
 * Values come out as the service wrote them. What keeps page text from posing
 * as this tool's own markup belongs to the rendering below, which is the only
 * consumer that reads markup; the panel puts these into a DOM node, where a
 * line break is a line break.
 * @param item - The entry as the endpoint sent it.
 * @param index - Its place in this turn's one space of numbers.
 * @returns The source, or null for an entry this cannot read.
 */
function readSource(item: unknown, index: number): SearchSource | null {
  if (item === null || typeof item !== "object") return null;
  const { url, title, snippets } = item as Source;

  const list = typeof snippets === "string" ? [snippets] : snippets;
  if (!Array.isArray(list)) return null;

  // No address is unreadable in the sense that matters: what a reader does
  // with a source is follow it, and a chip with nowhere to go is worse than
  // one page fewer.
  if (typeof url !== "string" || url === "") return null;
  const address = url;
  const name = typeof title === "string" ? title : "";
  // Brave documents a snippet as page text or as serialised structured data,
  // so a non-string is within contract rather than a surprise.
  const excerpts = list.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  const written = excerpts.reduce((n, t) => n + t.length, 0);
  if (written === 0) return null;

  return { url: address, title: name, publisher: publisherOf(address), excerpts, index };
}

/**
 * Name the publisher a page belongs to.
 *
 * A source row reading `vitest.dev` names a domain; one reading `Vitest` names
 * whoever wrote the page, which is what a reader weighs a claim by. The
 * registrable name is the first label after any `www.`, so `www.vogue.co.uk`
 * is Vogue rather than Co or Uk.
 *
 * An address this cannot parse keeps its own text: the row still has to say
 * something, and what the service sent is the closest thing to a name there
 * is.
 * @param url - The page's address.
 * @returns The publisher's name.
 */
function publisherOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  const name = host.replace(/^www\./, "").split(".")[0] ?? host;
  if (name === "") return host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Render one source as the block the model reads.
 *
 * The page's text sits in a region of its own, inside the block rather than
 * beside the two label lines. Those labels are what the answer attributes a
 * page by, and a page whose own text carries a `url:` line would otherwise
 * write a second one indistinguishable from the tool's -- cited back to the
 * reader under the address that page chose.
 * @param source - The source, as read off the payload.
 * @returns The block.
 */
function renderSource(source: SearchSource): string {
  return [
    `<source index="${String(source.index)}">`,
    `url: ${onOneLine(keepInside(source.url))}`,
    `title: ${onOneLine(keepInside(source.title))}`,
    "<text>",
    source.excerpts.map(keepInside).join(BETWEEN_EXCERPTS),
    "</text>",
    "</source>",
  ].join("\n");
}


/**
 * Render a search for the model to read.
 *
 * Every source the service sent and this tool could read goes to the model
 * whole. How much comes back is settled in the request, by the three figures
 * this request states: how many sources, how many tokens of text across all of
 * them, and how many from any one of them.
 *
 * The count of unreadable entries is stated, because a set the model reads as
 * complete is what makes "nothing I found mentions X" a wrong answer.
 *
 * Each source carries the number it was given when the search ran, so this
 * says the same thing however it is reached -- the SDK's own conversion mid
 * turn, or the request assembler replaying stored history.
 * @param answer - What the search found.
 * @returns The text handed to the model.
 */
export function renderSearchForModel(answer: SearchAnswer): string {
  const query = keepInside(answer.query);
  // A state a model reaches on its own: a `site:` query aimed at a domain with
  // nothing on it answers 200 with an empty list. The next move is not the
  // obvious one -- rewording is what a model reaches for after an empty
  // search, and it changes nothing when the corpus simply has no such page.
  if (answer.sources.length === 0) {
    return reason(
      `No results for: ${query}. The search ran and came back with nothing.`,
      MOVES.searchElsewhere,
    );
  }

  const header =
    `Results for: ${query}\n` +
    "Everything between a text marker and its close is an extract of that page, and " +
    `${BETWEEN_EXCERPTS.trim()} separates passages taken from different parts of it.\n`;

  const blocks = answer.sources.map((s) => renderSource(s));
  const parts = [header, ...blocks];
  if (blocks.length < answer.sent) {
    parts.push(
      `\n(Showing ${String(blocks.length)} of ${String(answer.sent)} sources. The rest arrived in a ` +
        "shape this tool could not read.)",
    );
  }
  return parts.join("\n");
}

/**
 * Search the web using Brave's LLM context endpoint.
 *
 * Returns extracts of each source's own page text, which is what the model
 * reads. Requires the `BRAVE_SEARCH_API_KEY` environment variable.
 */
/**
 * The tools one turn searches with.
 *
 * A turn's sources share one space of numbers, and that number has to be
 * settled where the search runs, because it is what the model is shown.
 * Nothing in the history a call is handed can supply it: `ai@7.0.68` runs
 * every tool call of a step through one `Promise.all` and gives them all the
 * same `messages` (`dist/index.js:8171-8180`), so a sibling search's result
 * is never in what this one reads. Two searches in a step would take the
 * same numbers, and a number standing for two pages sends the reader to the
 * wrong one.
 *
 * The turn keeps the count and each call reserves its block from it. The
 * reservation is one synchronous statement, which JavaScript runs to
 * completion, so calls running together cannot interleave inside it.
 *
 * The count starts at zero every turn, so a reply's sources read `1` upward
 * however long the conversation before it was, and each reply's row stands on
 * its own.
 * @returns This turn's search tools, keyed as the model names them.
 */
export function makeSearchTools(): {
  web_search: Tool<z.infer<typeof inputSchema>, SearchAnswer>;
} {
  let handedOut = 0;

  const webSearch: Tool<z.infer<typeof inputSchema>, SearchAnswer> = tool({
    description:
      "Search the web. Returns extracts of the pages that answer the query, drawn from parts " +
      "of each page. Something absent from an extract may still be on the page. `count` asks " +
      "for that many sources; the search returns what it finds.",
    inputSchema,
    // What the panel reads about a running call. The key is resolved by the web
    // package, which cannot import this one -- the SDK carries this field onto
    // the UI message part, so the name of the line and the tool that shows it
    // stay in one place.
    metadata: { runningLine: "chat.tool.searching" },
    // The SDK's own conversion, which is what a running turn reaches
    // (`ai@7.0.68` dist/index.js:4868 builds each step's tool result through it).
    // The numbers are already on the sources, so this and the request assembler
    // produce the same text.
    toModelOutput: ({ output }) => ({ type: "text", value: renderSearchForModel(output) }),
    execute: async (
      { query: asked, count },
      { abortSignal }: { abortSignal?: AbortSignal },
    ): Promise<SearchAnswer> => {
      // Two forms, settled here so no site downstream chooses between them. The
      // request carries the words as asked, on one line; every sentence printed
      // back to the model carries `shown`, which can no longer open a region of
      // this tool's own -- a query is the model's to write, and a page that asks
      // the model to search for a marker would otherwise reach the answer
      // through it.
      const query = onOneLine(asked);
      const shown = keepInside(query);
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
            MOVES.stop,
          ),
          FAILURE_LINES.generic,
        );
      }

      const { web_search_max_tokens: maxTokens, web_search_timeout_ms: budgetMs } =
        getAgentConfig();

      try {
        const url = new URL("https://api.search.brave.com/res/v1/llm/context");
        url.searchParams.set("q", query);
        // How many sources to ask for. What comes back is what the search found.
        url.searchParams.set("maximum_number_of_urls", String(count));
        // How much text comes back. Both ends of this key's range are the
        // service's own (it rejects below 1024 and states 32768 as its ceiling),
        // so a figure that reaches here is one it will take.
        url.searchParams.set("maximum_number_of_tokens", String(maxTokens));
        // The same amount again, per source. Left unstated this sits at the
        // service's own 4096 tokens, while the whole-search figure goes as high
        // as 32768 -- so a single page that answers the question cannot fill
        // what the search was given. Stating it lets the service spend the
        // budget where the text is: measured across two queries and seven of
        // the counts the schema allows, four of fourteen cells moved, by 32%,
        // 11%, 4% and -2%. The budget is shared, which is where that last one
        // comes from.
        //
        // The key's own ceiling is 8192, measured: 8193 comes back 422, while
        // the whole-search key runs to 32768. So the configured figure is held
        // to the range this one takes.
        url.searchParams.set(
          "maximum_number_of_tokens_per_url",
          String(Math.min(maxTokens, MAX_TOKENS_PER_SOURCE)),
        );

        const data = await braveJson({
          url,
          apiKey,
          voice: VOICE,
          query: shown,
          budgetMs,
          ...(abortSignal ? { abortSignal } : {}),
        });

        // A search that found nothing has one observed shape: `generic` present
        // and empty. A body without it is the service answering something other
        // than this endpoint's payload -- a moved schema, or something else in
        // its place. Calling that "found nothing" would report an absence of
        // pages when what happened is an answer this side could not read.
        const found: unknown = (data as { grounding?: { generic?: unknown } } | null)?.grounding?.generic;
        if (!Array.isArray(found)) {
          throw toolFailed(notOurPayloadReason(VOICE, shown), FAILURE_LINES.upstream);
        }
        if (found.length === 0) return { query, sources: [], sent: 0 };

        // Reserved before anything is read, so a search running beside this
        // one takes the block after rather than the same one.
        let numbered = handedOut;
        handedOut += found.length;
        const sources = found
          .map((item) => {
            const source = readSource(item, numbered + 1);
            if (source !== null) numbered += 1;
            return source;
          })
          .filter((source): source is SearchSource => source !== null);
        // Sources arrived and not one of them could be read: the answer is the
        // endpoint's payload in name only.
        if (sources.length === 0) {
          throw toolFailed(notOurPayloadReason(VOICE, shown), FAILURE_LINES.upstream);
        }

        return { query, sources, sent: found.length };
      } catch (err: unknown) {
        // Every throw above passes straight through: each already says what
        // happened, and rewriting one here would replace a specific reason with
        // this general one.
        if (toolFailureOf(err) !== undefined) throw err;
        if (isStop(err, abortSignal)) throw stoppedByUser();

        throw toolFailed(
          unreachableReason(VOICE, shown, reasonOf(err)),
          FAILURE_LINES.unreachable,
        );
      }
    },
  });

  return { web_search: webSearch };
}
