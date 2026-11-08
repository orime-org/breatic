// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `web_fetch` (inner#1664): reads the pages behind links the conversation
 * holds, through the `readPages` the server hands the turn.
 *
 * Every row of the plan's tool table is pinned here: what the model may ask
 * for, which links never leave this side, what the server is asked, the
 * turn's cache of full texts, how a call's text budget is shared, the one run
 * of citation numbers, the source row, the links a page carries, every way a
 * call can fail and what each call costs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Tool } from "ai";
import type { z } from "zod";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type { ReadPageResult, ReadPagesAnswer, ReadPagesRequest, ToolFailure } from "@breatic/shared";
import type * as coreModule from "@breatic/core";

/** What the deployment has each `web_fetch_*` key set to, per test. */
const fetchConfig = {
  web_fetch_max_urls: 20,
  web_fetch_timeout_ms: 90_000,
  web_fetch_page_timeout_ms: 30_000,
  web_fetch_settle_ms: 8_000,
  web_fetch_concurrency: 6,
  web_fetch_max_chars: 100,
  web_fetch_max_bytes: 20_971_520,
};

/**
 * Prices and a size chosen so every cost below is an exact binary fraction:
 * one wall second costs 4 * 0.25 + 8 * 0.125 = 2, one CPU second 0.5.
 */
const PRICES = { vcpu_second_usd: 0.5, memory_gib_second_usd: 0.25, disk_gb_second_usd: 0.125 };
const READER_SIZE = { instance_type: "standard-2", vcpu: 1, memory_gib: 4, disk_gb: 8 };

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({ ...actual.getAgentConfig(), ...fetchConfig }),
    getMiniToolsConfig: () => {
      const real = actual.getMiniToolsConfig();
      return { ...real, prices: PRICES, classes: { ...real.classes, WebReaderContainer: READER_SIZE } };
    },
  };
});

// Nothing in web_fetch reaches the network itself: the server's readPages does.
vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: web_fetch must read through readPages");
});

import { makeWebTools } from "@domain/agent/tools/web-tools.js";
import {
  ReadPagesRefused,
  renderFetchForModel,
  type FetchAnswer,
  type FetchedPage,
  type ReadPages,
} from "@domain/agent/tools/web-fetch.js";
import { STOPPED_BY_USER } from "@domain/agent/tools/failure.js";
import { usageSpy, type UsageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";

const A = "https://example.com/article";
const B = "https://news.example/b";
const C = "https://docs.example/c";

/** The usage the reader reports on a call that went through: 10 wall s, 4 CPU s. */
const REPORTED = { wallMs: 10_000, cpuUsec: 4_000_000 };
/** What REPORTED costs: 10 * 2 + 4 * 0.5. */
const REPORTED_COST = 22;

/** One call's input, as the model writes it. */
interface FetchInput {
  pages: Array<{ url: string; start?: number }>;
}

/** This turn's two web tools. */
type WebTools = { web_search: Tool; web_fetch: Tool };

/**
 * A turn's web tools, with the conversation holding whatever `allowed` says.
 * @param allowed - Whether a link is one the conversation holds.
 * @returns The tools.
 */
function turn(allowed: (url: string) => boolean = () => true): WebTools {
  return makeWebTools({ mediaUrlAllowed: () => false, pageUrlAllowed: allowed });
}

/**
 * Parse an input through the tool's own schema, the way the SDK does.
 * @param tools - The turn's tools.
 * @param input - What the model wrote.
 * @returns The parse result.
 */
function parseInput(tools: WebTools, input: unknown): { success: boolean; data?: unknown } {
  return (tools.web_fetch.inputSchema as unknown as z.ZodType).safeParse(input);
}

/**
 * Run one web_fetch call the way the model runtime does.
 * @param tools - The turn's tools.
 * @param input - The call's input.
 * @param readPages - The server's page reader.
 * @param extra - The usage spy and abort signal, when a case needs them.
 * @returns What the tool answered.
 */
async function fetchWith(
  tools: WebTools,
  input: FetchInput,
  readPages: ReadPages,
  extra: { spy?: UsageSpy; abortSignal?: AbortSignal } = {},
): Promise<FetchAnswer> {
  const execute = tools.web_fetch.execute;
  if (execute === undefined) throw new Error("web_fetch has no execute");
  const parsed = (tools.web_fetch.inputSchema as unknown as z.ZodType<FetchInput>).parse(input);
  const usage = (extra.spy ?? usageSpy()).recorder;
  return (await execute(parsed, {
    toolCallId: "t1",
    messages: [],
    context: { usage, readPages },
    ...(extra.abortSignal ? { abortSignal: extra.abortSignal } : {}),
  } as never)) as FetchAnswer;
}

/**
 * Run something that must fail, and read the failure it carried.
 * @param pending - The call.
 * @returns The failure on the thrown error.
 * @throws {Error} When the call returned, or threw without a failure.
 */
async function failureOf(pending: Promise<unknown>): Promise<ToolFailure> {
  const err = await pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e,
  );
  const failure = toolFailureOf(err);
  if (failure === undefined) {
    throw new Error(`threw without a failure: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failure;
}

/** What the reader answers for one page, without its address. */
type PageOutcome = Omit<ReadPageResult, "url">;

/**
 * A page the reader read, as HTML.
 * @param text - Its full text.
 * @param extra - Fields a case overrides.
 * @returns The outcome.
 */
function okPage(text: string, extra: Partial<PageOutcome> = {}): PageOutcome {
  return { status: "ok", httpStatus: 200, title: "A page", kind: "html", text, ...extra };
}

/**
 * A reader that answers each address it is asked for from a table, in the
 * order asked.
 * @param outcomes - What each address reads as.
 * @param usage - The usage it reports.
 * @returns The reader, as a mock.
 */
function reader(
  outcomes: Record<string, PageOutcome>,
  usage: ReadPagesAnswer["usage"] = REPORTED,
): ReturnType<typeof vi.fn<ReadPages>> {
  return vi.fn<ReadPages>(async (request: ReadPagesRequest) => ({
    pages: request.urls.map((url) => {
      const outcome = outcomes[url];
      if (outcome === undefined) throw new Error(`the reader was asked for ${url}, which this case never set up`);
      return { url, ...outcome };
    }),
    usage,
  }));
}

/**
 * A text of a given length with no links in it.
 * @param length - How many characters.
 * @returns The text.
 */
function filler(length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
}

beforeEach(() => {
  fetchConfig.web_fetch_max_chars = 100;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("web_fetch input", () => {
  it("takes one page and as many as web_fetch_max_urls", () => {
    const tools = turn();
    expect(parseInput(tools, { pages: [{ url: A }] }).success).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${String(i)}` }));
    expect(parseInput(tools, { pages: twenty }).success).toBe(true);
  });

  it("refuses no pages, and one past web_fetch_max_urls", () => {
    const tools = turn();
    expect(parseInput(tools, { pages: [] }).success).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${String(i)}` }));
    expect(parseInput(tools, { pages: twentyOne }).success).toBe(false);
  });

  it("starts a page at its first character when no start is given", () => {
    expect(parseInput(turn(), { pages: [{ url: A }] }).data).toEqual({ pages: [{ url: A, start: 0 }] });
  });

  it.each(["ftp://example.com/file", "javascript:alert(1)", "file:///etc/passwd", "example.com/page", "not a link"])(
    "refuses %s, which is not an http or https address",
    (url) => {
      expect(parseInput(turn(), { pages: [{ url }] }).success).toBe(false);
    },
  );

  it("takes an address of 2048 characters and refuses one of 2049", () => {
    const head = "https://example.com/";
    const at2048 = head + "a".repeat(2048 - head.length);
    expect(at2048).toHaveLength(2048);
    expect(parseInput(turn(), { pages: [{ url: at2048 }] }).success).toBe(true);
    expect(parseInput(turn(), { pages: [{ url: `${at2048}a` }] }).success).toBe(false);
  });

  it.each([-1, 1.5])("refuses a start of %d, which is not a non-negative whole number", (start) => {
    expect(parseInput(turn(), { pages: [{ url: A, start }] }).success).toBe(false);
  });
});

describe("a link the conversation does not hold", () => {
  it("is answered not_in_conversation and never sent to the reader", async () => {
    const allowed = vi.fn((url: string) => url !== B);
    const readPages = reader({ [A]: okPage("Body of A.") });

    const answer = await fetchWith(turn(allowed), { pages: [{ url: A }, { url: B }] }, readPages);

    expect(allowed).toHaveBeenCalledWith(B);
    expect(readPages).toHaveBeenCalledTimes(1);
    expect(readPages.mock.calls[0]![0].urls).toEqual([A]);
    expect(answer.pages[1]).toEqual({ url: B, status: "not_in_conversation", links: [] });
  });

  it("is every link when the tools were built without knowing the conversation", async () => {
    const readPages = reader({});
    const spy = usageSpy();
    const failure = await failureOf(
      fetchWith(makeWebTools(), { pages: [{ url: A }] }, readPages, { spy }),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.linkNotInConversation });
    expect(readPages).not.toHaveBeenCalled();
    expect(spy.serviceCalls).toEqual([]);
  });
});

describe("what the reader is asked", () => {
  it("is the allowed pages with the configured limits, a deadline from now, and the call's abort signal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const readPages = reader({ [A]: okPage("Body of A."), [B]: okPage("Body of B.") });
    const stop = new AbortController();

    await fetchWith(turn(), { pages: [{ url: A }, { url: B }] }, readPages, { abortSignal: stop.signal });

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(readPages.mock.calls[0]![0]).toEqual({
      urls: [A, B],
      deadlineAt: 1_800_000_000_000 + 90_000,
      pageTimeoutMs: 30_000,
      settleMs: 8_000,
      concurrency: 6,
      maxBytes: 20_971_520,
    });
    expect(readPages.mock.calls[0]![1]).toBe(stop.signal);
  });
});

describe("the turn's cache of pages read", () => {
  const full = filler(250);

  it("continues a page from start without reading it again", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(full) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const second = await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(second.pages[0]).toMatchObject({ start: 100, end: 200, next_start: 200, text: full.slice(100, 200) });
  });

  it("answers the same page asked again from what it read", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(full) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const again = await fetchWith(tools, { pages: [{ url: A }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(again.pages[0]).toMatchObject({ status: "ok", chars_total: 250, start: 0, end: 100, text: full.slice(0, 100) });
  });

  it("answers another spelling of the same page from what it read", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(full) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const respelled = await fetchWith(tools, { pages: [{ url: "http://EXAMPLE.com/article/#top", start: 200 }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(respelled.pages[0]).toMatchObject({ status: "ok", start: 200, end: 250, next_start: null, text: full.slice(200) });
  });

  it("sends the reader only the pages it has not read", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(full), [B]: okPage("Body of B.") });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    await fetchWith(tools, { pages: [{ url: A, start: 100 }, { url: B }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(2);
    expect(readPages.mock.calls[1]![0].urls).toEqual([B]);
  });

  it("does not keep a page that failed, so asking again reads it again", async () => {
    const tools = turn();
    const readPages = reader({ [A]: { status: "busy", httpStatus: 503 }, [B]: okPage("Body of B.") });

    await fetchWith(tools, { pages: [{ url: A }, { url: B }] }, readPages);
    await fetchWith(tools, { pages: [{ url: A }, { url: B }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(2);
    expect(readPages.mock.calls[1]![0].urls).toEqual([A]);
  });

  it("belongs to one turn: a fresh set of tools reads the page again", async () => {
    const readPages = reader({ [A]: okPage(full) });

    await fetchWith(turn(), { pages: [{ url: A }] }, readPages);
    await fetchWith(turn(), { pages: [{ url: A }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(2);
  });
});

describe("how much of each page the model is handed", () => {
  it("is web_fetch_max_chars for a call's one page, with where it stopped and where to go on from", async () => {
    const full = filler(250);
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }] },
      reader({ [A]: okPage(full, { finalUrl: `${A}?ref=1`, title: "Article" }) }),
    );

    expect(answer.pages).toEqual([
      {
        url: A,
        status: "ok",
        final_url: `${A}?ref=1`,
        title: "Article",
        kind: "html",
        chars_total: 250,
        start: 0,
        end: 100,
        next_start: 100,
        text: full.slice(0, 100),
        links: [],
        index: 1,
      },
    ]);
  });

  it("says there is nothing more once the slice reaches the end", async () => {
    const full = filler(250);
    const tools = turn();
    const readPages = reader({ [A]: okPage(full) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const last = await fetchWith(tools, { pages: [{ url: A, start: 200 }] }, readPages);

    expect(last.pages[0]).toMatchObject({ chars_total: 250, start: 200, end: 250, next_start: null, text: full.slice(200) });
  });

  it("hands a page shorter than its share over whole", async () => {
    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage("Short body.") }));

    expect(answer.pages[0]).toMatchObject({ chars_total: 11, start: 0, end: 11, next_start: null, text: "Short body." });
  });

  it("shares web_fetch_max_chars equally among the call's pages that were read", async () => {
    const first = filler(120);
    const second = filler(130).toUpperCase();
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }, { url: C }] },
      reader({ [A]: okPage(first), [B]: { status: "refused", httpStatus: 403 }, [C]: okPage(second) }),
    );

    expect(answer.pages[0]).toMatchObject({ start: 0, end: 50, next_start: 50, text: first.slice(0, 50) });
    expect(answer.pages[2]).toMatchObject({ start: 0, end: 50, next_start: 50, text: second.slice(0, 50) });
  });

  it("counts a page answered from the cache among the call's pages that share", async () => {
    const tools = turn();
    const first = filler(300);
    const second = filler(300).toUpperCase();
    const readPages = reader({ [A]: okPage(first), [B]: okPage(second) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const answer = await fetchWith(tools, { pages: [{ url: A, start: 100 }, { url: B }] }, readPages);

    expect(answer.pages[0]).toMatchObject({ start: 100, end: 150, next_start: 150, text: first.slice(100, 150) });
    expect(answer.pages[1]).toMatchObject({ start: 0, end: 50, next_start: 50, text: second.slice(0, 50) });
  });

  it("says how many pages a PDF has", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }] },
      reader({ [A]: okPage("Abstract.", { kind: "pdf", pages: 15, title: "Paper" }) }),
    );

    expect(answer.pages[0]).toMatchObject({ status: "ok", kind: "pdf", pages: 15, title: "Paper" });
  });

  it("reads any text back whole by following next_start, with no overlap and no gap", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "binary", minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 60 }),
        async (full, share) => {
          fetchConfig.web_fetch_max_chars = share;
          const tools = turn();
          const readPages = reader({ [A]: okPage(full) });

          const slices: FetchedPage[] = [];
          let start: number | null = 0;
          while (start !== null) {
            const answer = await fetchWith(tools, { pages: [{ url: A, start }] }, readPages);
            const page = answer.pages[0]!;
            slices.push(page);
            if (slices.length > full.length + 1) throw new Error("next_start never reached null");
            start = page.next_start ?? null;
          }

          expect(readPages).toHaveBeenCalledTimes(1);
          expect(slices.map((s) => s.text).join("")).toBe(full);
          expect(slices[0]!.start).toBe(0);
          for (let i = 1; i < slices.length; i += 1) {
            expect(slices[i]!.start).toBe(slices[i - 1]!.end);
            expect(slices[i - 1]!.next_start).toBe(slices[i - 1]!.end);
          }
          expect(slices.at(-1)!.next_start).toBeNull();
          expect(slices.at(-1)!.end).toBe(slices.at(-1)!.chars_total);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("citation numbers", () => {
  it("gives each page read a fresh number, carrying on across calls in one turn", async () => {
    const tools = turn();
    const full = filler(250);
    const readPages = reader({ [A]: okPage(full), [B]: okPage("Body of B.") });

    const first = await fetchWith(tools, { pages: [{ url: A }, { url: B }] }, readPages);
    const second = await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages);

    expect(first.pages.map((p) => p.index)).toEqual([1, 2]);
    expect(second.pages.map((p) => p.index)).toEqual([3]);
  });

  it("gives a page that failed no number", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }] },
      reader({ [A]: { status: "unreachable", httpStatus: 404 }, [B]: okPage("Body of B.") }),
    );

    expect(answer.pages.map((p) => p.index)).toEqual([undefined, 1]);
  });

  it("never hands out one number twice to calls running together", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage("A."), [B]: okPage("B."), [C]: okPage("C.") });

    const answers = await Promise.all([
      fetchWith(tools, { pages: [{ url: A }, { url: B }] }, readPages),
      fetchWith(tools, { pages: [{ url: C }] }, readPages),
    ]);

    const numbers = answers.flatMap((a) => a.pages.map((p) => p.index));
    expect([...numbers].sort()).toEqual([1, 2, 3]);
  });

  it("starts at one in a fresh set of tools", async () => {
    const readPages = reader({ [A]: okPage("A.") });
    const tools = turn();
    await fetchWith(tools, { pages: [{ url: A }] }, readPages);

    const fresh = await fetchWith(turn(), { pages: [{ url: A }] }, readPages);

    expect(fresh.pages[0]!.index).toBe(1);
  });
});

describe("the source row", () => {
  it("lists each page read under the address asked for, its title, publisher and number", async () => {
    const vogue = "https://www.vogue.co.uk/fashion";
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: vogue }, { url: B }, { url: C }] },
      reader({
        [vogue]: okPage("Runway.", { finalUrl: "https://www.vogue.co.uk/fashion/article-x", title: "Runway report" }),
        [B]: { status: "needs_login", httpStatus: 401 },
        [C]: okPage("Docs.", { title: "Docs page" }),
      }),
    );

    expect(answer.sources).toEqual([
      { url: vogue, title: "Runway report", publisher: "Vogue", index: 1 },
      { url: C, title: "Docs page", publisher: "Docs", index: 2 },
    ]);
  });
});

describe("the links a page carries", () => {
  it("are every link in the page's full text, not only in the slice handed over", async () => {
    const full = `Intro https://a.example/one then ${filler(200)} later https://b.example/two.`;
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }] },
      reader({ [A]: okPage(full), [B]: { status: "refused", httpStatus: 403 } }),
    );

    expect(answer.pages[0]!.links).toEqual(["https://a.example/one", "https://b.example/two"]);
    expect(answer.pages[1]!.links).toEqual([]);
  });
});

describe("a call where no page could be read", () => {
  it.each([
    ["unreachable", 404, FAILURE_LINES.linkUnreachable],
    ["needs_login", 401, FAILURE_LINES.pageNeedsLogin],
    ["refused", 403, FAILURE_LINES.pageRefused],
    ["busy", 503, FAILURE_LINES.busy],
    ["too_slow", undefined, FAILURE_LINES.pageTooSlow],
    ["unsupported_type", 200, FAILURE_LINES.unsupportedType],
    ["too_large", 200, FAILURE_LINES.fileTooLarge],
    ["empty", 200, FAILURE_LINES.pageEmpty],
  ] as const)("fails with the %s line when every page ended that way", async (status, httpStatus, userKey) => {
    const outcome: PageOutcome = httpStatus === undefined ? { status } : { status, httpStatus };
    const failure = await failureOf(
      fetchWith(turn(), { pages: [{ url: A }, { url: B }] }, reader({ [A]: outcome, [B]: outcome })),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey });
  });

  it("fails with linkNotInConversation when no link is one the conversation holds", async () => {
    const failure = await failureOf(fetchWith(turn(() => false), { pages: [{ url: A }, { url: B }] }, reader({})));

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.linkNotInConversation });
  });

  it("fails with pagesUnreadable when the pages failed for different reasons", async () => {
    const failure = await failureOf(
      fetchWith(
        turn(),
        { pages: [{ url: A }, { url: B }] },
        reader({ [A]: { status: "unreachable", httpStatus: 404 }, [B]: { status: "refused", httpStatus: 403 } }),
      ),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.pagesUnreadable });
  });

  it("counts a link the conversation does not hold as one of the different reasons", async () => {
    const failure = await failureOf(
      fetchWith(
        turn((url) => url !== A),
        { pages: [{ url: A }, { url: B }] },
        reader({ [B]: { status: "busy", httpStatus: 429 } }),
      ),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.pagesUnreadable });
  });
});

describe("a call where some pages could not be read", () => {
  it("answers normally, each failed page with how it ended", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }, { url: C }] },
      reader({ [A]: okPage("Body."), [B]: { status: "refused", httpStatus: 403 }, [C]: { status: "too_slow" } }),
    );

    expect(answer.pages.map((p) => p.status)).toEqual(["ok", "refused", "too_slow"]);
    expect(answer.pages[1]).toEqual({ url: B, status: "refused", links: [] });
    expect(answer.pages[2]).toEqual({ url: C, status: "too_slow", links: [] });
  });
});

describe("when the reader does not answer", () => {
  it("says too frequent when the server refused to read", async () => {
    const readPages = vi.fn<ReadPages>(async () => {
      throw new ReadPagesRefused("rate_limited");
    });

    const failure = await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages));

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.tooFrequent });
  });

  it("ends as stopped by the user when the turn is stopped", async () => {
    const stop = new AbortController();
    const readPages = vi.fn<ReadPages>(async () => {
      stop.abort();
      throw new DOMException("aborted", "AbortError");
    });

    const failure = await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages, { abortSignal: stop.signal }));

    expect(failure).toEqual(STOPPED_BY_USER);
  });

  it.each([
    ["a dropped connection", new Error("socket hang up")],
    ["the deadline passing", new DOMException("deadline passed", "TimeoutError")],
  ])("says unavailable on %s", async (_label, error) => {
    const readPages = vi.fn<ReadPages>(async () => {
      throw error;
    });

    const failure = await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages));

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.unavailable });
  });
});

describe("what a call costs", () => {
  /**
   * The one row a call that reached the reader writes.
   * @param costUsd - What it cost.
   * @returns The row.
   */
  const row = (costUsd: number): Record<string, unknown> => ({
    source: "tool:web_fetch",
    service: "cloudflare-container:web_read",
    provider: "cloudflare",
    requests: 1,
    costUsd,
    costSource: "computed",
  });

  it("records one row priced from the usage the reader reported", async () => {
    const spy = usageSpy();
    await fetchWith(turn(), { pages: [{ url: A }, { url: B }] }, reader({ [A]: okPage("A."), [B]: okPage("B.") }), { spy });

    expect(spy.serviceCalls).toEqual([row(REPORTED_COST)]);
  });

  it("records the row when some pages failed", async () => {
    const spy = usageSpy();
    await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }] },
      reader({ [A]: okPage("A."), [B]: { status: "busy", httpStatus: 503 } }),
      { spy },
    );

    expect(spy.serviceCalls).toEqual([row(REPORTED_COST)]);
  });

  it("records the row when every page the reader was sent failed", async () => {
    const spy = usageSpy();
    await failureOf(
      fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: { status: "unreachable", httpStatus: 404 } }), { spy }),
    );

    expect(spy.serviceCalls).toEqual([row(REPORTED_COST)]);
  });

  it("prices a reported run with no CPU reading at the class's full vCPU for the wall time", async () => {
    const spy = usageSpy();
    await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage("A.") }, { wallMs: 6_000, cpuUsec: null }), { spy });

    // 6 * 2 for memory and disk, 6 * 1 * 0.5 for CPU.
    expect(spy.serviceCalls).toEqual([row(15)]);
  });

  it.each([
    ["the turn is stopped", "stop"],
    ["the connection drops", "drop"],
    ["the deadline passes", "timeout"],
  ] as const)("estimates from the time it took when %s", async (_label, ending) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(1_800_000_000_000);
    const stop = new AbortController();
    const readPages = vi.fn<ReadPages>(async () => {
      vi.advanceTimersByTime(4_000);
      if (ending === "stop") {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      }
      if (ending === "timeout") throw new DOMException("deadline passed", "TimeoutError");
      throw new Error("socket hang up");
    });
    const spy = usageSpy();

    await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages, { spy, abortSignal: stop.signal }));

    // 4 wall seconds * 2, plus 4 * 1 vCPU * 0.5.
    expect(spy.serviceCalls).toEqual([row(10)]);
  });

  it("records nothing when the server refused to read", async () => {
    const spy = usageSpy();
    const readPages = vi.fn<ReadPages>(async () => {
      throw new ReadPagesRefused("rate_limited");
    });

    await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages, { spy }));

    expect(spy.serviceCalls).toEqual([]);
  });

  it("records nothing for a call answered wholly from the turn's cache", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(filler(250)) });
    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const spy = usageSpy();

    await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages, { spy });

    expect(spy.serviceCalls).toEqual([]);
  });

  it("records nothing when no link was one the conversation holds", async () => {
    const spy = usageSpy();

    await failureOf(fetchWith(turn(() => false), { pages: [{ url: A }] }, reader({}), { spy }));

    expect(spy.serviceCalls).toEqual([]);
  });
});

describe("what the panel and the model read off the tool", () => {
  it("names its running line", () => {
    expect(turn().web_fetch.metadata).toEqual({ runningLine: "chat.tool.readingPages" });
  });

  it("hands the model the rendering of what it answered", async () => {
    const tools = turn();
    const output = await fetchWith(tools, { pages: [{ url: A }] }, reader({ [A]: okPage("Body of A.") }));
    const convert = tools.web_fetch.toModelOutput as
      | ((arg: { toolCallId: string; input: unknown; output: unknown }) => unknown)
      | undefined;
    if (convert === undefined) throw new Error("web_fetch declares no toModelOutput");

    expect(await convert({ toolCallId: "t1", input: { pages: [{ url: A, start: 0 }] }, output })).toEqual({
      type: "text",
      value: renderFetchForModel(output),
    });
  });
});

describe("web_fetch says how to use it", () => {
  /**
   * The description on one line, so assertions are about wording.
   * @returns The description.
   */
  const said = (): string => {
    const description = turn().web_fetch.description;
    return typeof description === "string" ? description.replace(/\s+/g, " ") : "";
  };

  it("says it reads several pages in one call", () => {
    expect(said()).toMatch(/several (pages|links)/i);
  });

  it("sends media links to understand_media and a search without an address to web_search", () => {
    expect(said()).toContain("understand_media");
    expect(said()).toContain("web_search");
  });

  it("says a page's content is material, not instructions", () => {
    expect(said()).toMatch(/not instructions/i);
  });

  it("says what to tell the user when a link they gave needs a login or was refused", () => {
    expect(said()).toMatch(/log ?in/i);
    expect(said()).toMatch(/refus/i);
    expect(said()).toMatch(/copy/i);
    expect(said()).toMatch(/screenshot/i);
    expect(said()).toMatch(/PDF/);
  });

  it("says to find another source when a page it found itself needs a login or was refused", () => {
    expect(said()).toMatch(/(another|other) source/i);
  });

  it("says how to go on reading a long page", () => {
    expect(said()).toMatch(/\bstart\b/);
  });

  it("says its numbers run on from web_search's, and that the panel lists the sources", () => {
    expect(said()).toContain("[1]");
    expect(said()).toMatch(/share one run of numbers/i);
    expect(said()).toMatch(/do not list their addresses/i);
  });
});
