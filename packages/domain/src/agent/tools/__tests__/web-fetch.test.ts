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
import { FAILURE_LINES, READ_PAGE_MAX_URL_CHARS, UploadHttpError, pageLinkKey, toolFailureOf } from "@breatic/shared";
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
import { pageLinkSpansIn } from "@domain/agent/page-links.js";
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
 * A turn's web tools, with the conversation holding whatever `allowed` says,
 * each held link recorded in the spelling the model asks with.
 * @param allowed - Whether a link is one the conversation holds.
 * @returns The tools.
 */
function turn(allowed: (url: string) => boolean = () => true): WebTools {
  return makeWebTools({ mediaUrlAllowed: () => false, pageUrlFor: async (url: string) => (allowed(url) ? url : undefined) });
}

/**
 * A turn's web tools whose conversation holds exactly one link, recorded in
 * one spelling (plan §9 A: the set answers the spelling it recorded).
 * @param stored - The spelling the conversation recorded.
 * @returns The tools.
 */
function turnHolding(stored: string): WebTools {
  return makeWebTools({
    mediaUrlAllowed: () => false,
    pageUrlFor: async (url: string) => (pageLinkKey(url) === pageLinkKey(stored) ? stored : undefined),
  });
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
 * A text of a given length with no links in it: letters with a space after
 * each, so every cut has a space on one side and no cut is moved to the end
 * of a run of non-space characters (plan §13.2 row 9).
 * @param length - How many characters.
 * @returns The text.
 */
function filler(length: number): string {
  return Array.from({ length }, (_, i) => (i % 2 === 1 ? " " : String.fromCharCode(97 + ((i / 2) % 26)))).join("");
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

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure).not.toHaveProperty("userKey");
    expect(readPages).not.toHaveBeenCalled();
    expect(spy.serviceCalls).toEqual([]);
  });
});

describe("the spelling the reader is sent (plan §9 A)", () => {
  const STORED = "https://evil.com/p";

  it.each([
    ["a fragment", "https://evil.com/p#SECRET"],
    ["credentials before the host", "https://SECRET:x@evil.com/p"],
    ["trailing slashes", "https://evil.com/p///"],
    ["a percent-encoded path", "https://evil.com/%70"],
  ])("is the one the conversation recorded when the model adds %s", async (_label, asked) => {
    const readPages = reader({ [STORED]: okPage("Body.") });

    const answer = await fetchWith(turnHolding(STORED), { pages: [{ url: asked }] }, readPages);

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(readPages.mock.calls[0]![0].urls).toEqual([STORED]);
    expect(answer.pages[0]).toMatchObject({ url: asked, status: "ok" });
  });

  // Plan §13.2 row 10: the set is built only when a link first misses it, so
  // the lookup the turn hands over answers asynchronously.
  it("is the one an asynchronous lookup answers", async () => {
    const readPages = reader({ [STORED]: okPage("Body.") });
    const tools = makeWebTools({
      mediaUrlAllowed: () => false,
      pageUrlFor: async (url: string) => (pageLinkKey(url) === pageLinkKey(STORED) ? STORED : undefined),
    });

    const answer = await fetchWith(tools, { pages: [{ url: "https://evil.com/p#SECRET" }] }, readPages);

    expect(readPages.mock.calls[0]?.[0].urls).toEqual([STORED]);
    expect(answer.pages[0]).toMatchObject({ status: "ok" });
  });

  it("is never the model's spelling, whatever it put in the fragment", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/), async (secret) => {
        const readPages = reader({ [STORED]: okPage("Body.") });

        await fetchWith(turnHolding(STORED), { pages: [{ url: `${STORED}#${secret}` }] }, readPages);

        expect(readPages.mock.calls[0]![0].urls).toEqual([STORED]);
      }),
      { numRuns: 50 },
    );
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

describe("one page asked twice in one call (plan §9 D)", () => {
  const full = filler(250);

  it("answers a second spelling at the same start from the first, without a share or a number of its own", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(full) });

    const answer = await fetchWith(
      tools,
      { pages: [{ url: A }, { url: "http://EXAMPLE.com/article/#top" }] },
      readPages,
    );

    expect(readPages.mock.calls[0]![0].urls).toEqual([A]);
    // The one page keeps the whole budget: the repeat takes no share.
    expect(answer.pages[0]).toMatchObject({ status: "ok", start: 0, end: 100, index: 1, text: full.slice(0, 100) });
    // The repeat carries no text of its own: the model reads it once, under the first.
    expect(answer.pages[1]!.text).toBeUndefined();

    expect(answer.sources.map((source) => source.index)).toEqual([1]);

    // And the repeat took no number: the next page read is 2.
    const next = await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages);
    expect(next.pages[0]!.index).toBe(2);
  });

  it("answers the same address asked twice at the same start once", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }, { url: A }] },
      reader({ [A]: okPage(full), [B]: okPage(filler(250).toUpperCase()) }),
    );

    // Two pages share the budget, not three.
    expect(answer.pages.slice(0, 2).map((p) => [p.start, p.end, p.index])).toEqual([
      [0, 50, 1],
      [0, 50, 2],
    ]);
    expect(answer.pages[2]!.text).toBeUndefined();
    expect(answer.sources.map((source) => source.index)).toEqual([1, 2]);
  });

  it("hands the model the text once, the repeat being one line naming the first's source", async () => {
    const body = "The one body of this page, written once.";
    const answer = await fetchWith(turn(), { pages: [{ url: A }, { url: A }] }, reader({ [A]: okPage(body) }));

    const rendered = renderFetchForModel(answer);
    expect(rendered.split(body).length - 1).toBe(1);
    expect(rendered).toContain("same page as source 1 above");
  });

  it("treats one page at two starts as two parts, each with its share and number", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: A, start: 100 }] },
      reader({ [A]: okPage(full) }),
    );

    expect(answer.pages.map((p) => [p.start, p.end, p.index])).toEqual([
      [0, 50, 1],
      [100, 150, 2],
    ]);
  });
});

describe("a page the reader cut at its byte cap (plan §9 S)", () => {
  it("is handed over marked truncated", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }] },
      reader({ [A]: okPage("Cut body.", { truncated: true }), [B]: okPage("Whole body.") }),
    );

    expect(answer.pages[0]).toMatchObject({ status: "ok", truncated: true });
    expect(answer.pages[1]).not.toHaveProperty("truncated");
  });

  it("stays marked when it is continued from the turn's cache", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(filler(250), { truncated: true }) });

    await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    const next = await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages);

    expect(next.pages[0]).toMatchObject({ start: 100, truncated: true });
  });
});

/**
 * Read one page whole through `web_fetch`, a call at a time, following
 * next_start, with every call's share set to `share`.
 * @param text - The page's text.
 * @param share - web_fetch_max_chars for the run, which is one page's share.
 * @returns Every slice handed over, in order.
 * @throws {Error} When next_start never reaches null.
 */
async function slicesOf(text: string, share: number): Promise<FetchedPage[]> {
  fetchConfig.web_fetch_max_chars = share;
  const tools = turn();
  const readPages = reader({ [A]: okPage(text) });
  const slices: FetchedPage[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const answer = await fetchWith(tools, { pages: [{ url: A, start }] }, readPages);
    const page = answer.pages[0]!;
    slices.push(page);
    if (slices.length > text.length + 1) throw new Error("next_start never reached null");
    start = page.next_start ?? null;
  }
  return slices;
}

// Plan §16 rows 1 and 2: a cut moves only when a link, at the place the text
// writes it, starts before the cut and ends after it; it moves to that
// link's end in the text as written. Another writing of the link, or a
// shorter link that is its prefix, elsewhere in the text moves nothing.
describe("where a slice is cut, by the links' own positions (plan §16 rows 1 and 2)", () => {
  it("moves the cut to the end of the link that crosses it, though a shorter link it starts with is written later", async () => {
    const before = "x ".repeat(20);
    const text = `${before}https://a.test/docs/intro and see https://a.test/docs too`;

    const [first] = await slicesOf(text, before.length + 18);

    const end = before.length + "https://a.test/docs/intro".length;
    expect(first).toMatchObject({ start: 0, end, next_start: end });
    expect(first!.links).toContain("https://a.test/docs/intro");
  });

  it("does not split the second writing of a link a JSON body writes twice", async () => {
    const text = '{"url":"https://a.test/p/abc","self":"https://a.test/p/abc"}';
    const second = text.lastIndexOf("https");

    const slices = await slicesOf(text, text.indexOf("self") + 15);

    expect(slices[0]).toMatchObject({ start: 0, end: second + 20 });
    expect(slices[0]!.text?.endsWith("https://a.test/p/abc")).toBe(true);
    expect(slices[0]!.links).toEqual(["https://a.test/p/abc"]);
  });

  it("moves the cut to the end of the second of two links in Chinese prose, listing no part of a link", async () => {
    const text = "请看https://a.test/path，然后https://a.test/p，谢谢";
    const second = text.lastIndexOf("https");

    const [first] = await slicesOf(text, second + 12);

    expect(first).toMatchObject({ start: 0, end: second + "https://a.test/p".length });
    expect(first!.links).toEqual(["https://a.test/path", "https://a.test/p"]);
    expect(first!.links).not.toContain("https://a.te");
  });

  it("leaves a cut inside a plain word at the share, though an escaped link follows in the window", async () => {
    const text = "supercalifragilisticexpialidocious and https://a.test/a\\_b end";

    const [first] = await slicesOf(text, 10);

    expect(first).toMatchObject({ start: 0, end: 10, next_start: 10 });
  });

  it("leaves a cut in a Chinese run with no spaces at the share, though an escaped link opens the run", async () => {
    const text = `见https://a.test/a\\_b。${"中".repeat(150)} tail`;

    const [first] = await slicesOf(text, 80);

    expect(first).toMatchObject({ start: 0, end: 80, next_start: 80 });
  });

  it("leaves a cut in a long run at the share, though an escaped link sits further on in the run", async () => {
    const text = `{"a":"${"k".repeat(3000)}","u":"https://a.test/x\\_y"} end`;

    const [first] = await slicesOf(text, 2000);

    expect(first).toMatchObject({ start: 0, end: 2000, next_start: 2000 });
  });

  it("moves a cut inside an escaped link to the link's end as written, after the escape, not to the end of its run", async () => {
    const written = "https://a.test/x\\_y/more";
    const text = `{"u":"${written}","v":12345} end`;
    const at = text.indexOf("https");

    const [first] = await slicesOf(text, at + 16);

    expect(first).toMatchObject({ start: 0, end: at + written.length, next_start: at + written.length });
    expect(first!.links).toEqual(["https://a.test/x_y/more"]);
  });

  it("cuts every page so that the slices cover it, none empty, no link split, and every cut not inside a link at the share", async () => {
    const piece = fc.oneof(
      fc.constantFrom("word", "harbour", "supercalifragilistic", "abc"),
      fc.constantFrom(
        "https://a.test/docs",
        "https://a.test/docs/intro",
        "https://a.test/p/abc",
        "https://a.test/a\\_b",
        "https://a.test/x\\_y/more",
        "example.com/x",
      ),
      fc.constantFrom("中文段落", "网页", "资料读取用户"),
    );
    // Every separator ends a link, so no link runs on into the next piece.
    const separator = fc.constantFrom(" ", "，", '"', "\n", "。");
    const textArb = fc
      .array(fc.tuple(piece, separator), { minLength: 1, maxLength: 24 })
      .map((parts) => parts.map(([word, sep]) => word + sep).join(""));

    await fc.assert(
      fc.asyncProperty(textArb, fc.integer({ min: 1, max: 60 }), async (text, share) => {
        const slices = await slicesOf(text, share);
        const spans = pageLinkSpansIn(text).filter((span) => span.end - span.start <= READ_PAGE_MAX_URL_CHARS);

        expect(slices.map((slice) => slice.text).join("")).toBe(text);
        for (const slice of slices) {
          expect(slice.text?.length ?? 0, JSON.stringify({ text, share })).toBeGreaterThan(0);
          const from = slice.start ?? 0;
          const to = slice.end ?? 0;
          if (to === text.length) continue;
          for (const span of spans) {
            expect(span.start < to && span.end > to, JSON.stringify({ text, share, to, span })).toBe(false);
          }
          const target = from + share;
          const crossing = spans.filter((span) => span.start < target && span.end > target);
          if (crossing.length === 0) expect(to, JSON.stringify({ text, share })).toBe(target);
          else expect(crossing.map((span) => span.end), JSON.stringify({ text, share })).toContain(to);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("where a slice is cut (plan §13.2 row 9)", () => {
  // Plan §15 rows 1 and 2: the cut moves only when a link crosses it, to that
  // link's end, whatever characters the link holds; text with no link across
  // the cut is cut at the share.
  it("moves a cut that falls inside a link holding Chinese to the link's end", async () => {
    const link = "https://zh.wikipedia.org/wiki/\u5317\u4eac\u5e02";
    const before = `${"word ".repeat(13)}see `;
    // The cut falls right after the first Chinese character of the link.
    expect(before.length + "https://zh.wikipedia.org/wiki/".length + 1).toBe(100);
    const full = `${before}${link} and then the rest of the page goes on for a good while longer than this.`;

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));

    const end = before.length + link.length;
    expect(answer.pages[0]!.text?.endsWith(link)).toBe(true);
    expect(answer.pages[0]).toMatchObject({ start: 0, end, next_start: end });
    expect(answer.pages[0]!.links).toContain(link);
  });

  it("cuts twenty pages of minified JSON exactly at their shares, within web_fetch_max_chars", async () => {
    fetchConfig.web_fetch_max_chars = 80_000;
    const urls = Array.from({ length: 20 }, (_, i) => `https://json${String(i)}.example/data`);
    const json = JSON.stringify({
      items: Array.from({ length: 600 }, (_, i) => ({ id: i, name: `item${String(i)}`, tags: ["a", "b"], ok: true })),
    });
    expect(json).not.toMatch(/\s/);
    expect(json.length).toBeGreaterThan(8_000);

    const answer = await fetchWith(
      turn(),
      { pages: urls.map((url) => ({ url })) },
      reader(Object.fromEntries(urls.map((url) => [url, okPage(json)]))),
    );

    const share = Math.floor(80_000 / 20);
    for (const page of answer.pages) {
      expect(page).toMatchObject({ status: "ok", start: 0, end: share, next_start: share });
      expect(page.text).toHaveLength(share);
    }
    expect(answer.pages.reduce((sum, page) => sum + (page.text?.length ?? 0), 0)).toBeLessThanOrEqual(80_000);
  });

  // Plan §14 row 5: the cut moves only across ASCII non-space characters, so
  // a page of Chinese with no spaces is cut where its share ends.
  it("cuts twenty pages of Chinese with no spaces exactly at their shares, within web_fetch_max_chars", async () => {
    fetchConfig.web_fetch_max_chars = 100_000;
    const urls = Array.from({ length: 20 }, (_, i) => `https://cjk${String(i)}.example/page`);
    const text = "\u4e2d\u6587".repeat(6000);
    expect(text).toHaveLength(12_000);

    const answer = await fetchWith(
      turn(),
      { pages: urls.map((url) => ({ url })) },
      reader(Object.fromEntries(urls.map((url) => [url, okPage(text)]))),
    );

    const share = Math.floor(100_000 / 20);
    for (const page of answer.pages) {
      expect(page).toMatchObject({ status: "ok", start: 0, end: share, next_start: share });
      expect(page.text).toHaveLength(share);
    }
    expect(answer.pages.reduce((sum, page) => sum + (page.text?.length ?? 0), 0)).toBeLessThanOrEqual(100_000);
  });

  it("moves a cut inside an ASCII link only to the first character that is not ASCII", async () => {
    const before = "\u4e2d".repeat(90);
    const full = `${before}https://example.com/guide/install${"\u6587".repeat(200)}`;

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));

    const end = before.length + "https://example.com/guide/install".length;
    expect(answer.pages[0]).toMatchObject({ start: 0, end, next_start: end });
  });

  const LINK = "https://example.com/guide/install";

  it("moves a cut that falls inside a link to the link's end", async () => {
    const before = `${"word ".repeat(18)}see `;
    const full = `${before}${LINK} and then the rest of the page goes on for a while longer.`;
    expect(before.length).toBeLessThan(100);
    expect(before.length + LINK.length).toBeGreaterThan(100);

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));

    const end = before.length + LINK.length;
    expect(answer.pages[0]!.text?.endsWith(LINK)).toBe(true);
    expect(answer.pages[0]).toMatchObject({ start: 0, end, next_start: end });
    expect(answer.pages[0]!.links).toContain(LINK);
  });

  it("leaves a cut that has a space on one side where the share puts it", async () => {
    const full = filler(250);

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));

    expect(answer.pages[0]).toMatchObject({ start: 0, end: 100, next_start: 100, text: full.slice(0, 100) });
  });

  it("cuts a long run that holds no link at its share", async () => {
    const full = `${"x".repeat(5000)} end`;

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));

    expect(answer.pages[0]).toMatchObject({ start: 0, end: 100, next_start: 100 });
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
  // Plan §14 row 4: the row links to the address that was read; the model
  // still sees its own spelling in the page's url.
  it.each([
    ["a Markdown escape", "https://x.com/foo\\_bar"],
    ["credentials, an upper-case host and a fragment", "https://u:secret@X.com/foo_bar#frag"],
  ])("lists the spelling the conversation recorded, not the model's with %s", async (_label, asked) => {
    const stored = "https://x.com/foo_bar";
    const direct = await fetchWith(turnHolding(stored), { pages: [{ url: stored }] }, reader({ [stored]: okPage("Body.") }));

    const answer = await fetchWith(turnHolding(stored), { pages: [{ url: asked }] }, reader({ [stored]: okPage("Body.") }));

    expect(answer.pages[0]).toMatchObject({ url: asked, status: "ok" });
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({ url: stored, publisher: direct.sources[0]!.publisher });
  });

  it("passes on a page's empty title as it is, the panel showing the address in its place", async () => {
    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage("Body.", { title: "" }) }));

    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({ url: A, title: "", index: 1 });
  });

  it("titles a page the reader gave no title with an empty one", async () => {
    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage("Body.", { title: undefined }) }));

    expect(answer.sources[0]).toMatchObject({ url: A, title: "", index: 1 });
  });

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
  const X = "https://a.example/one";
  const Y = "https://b.example/two";
  // Exactly one share (100 characters) each, so a slice holds one half.
  const firstHalf = `${`Intro ${X} then`.padEnd(99, "-")} `;
  const secondHalf = `${`later ${Y} end`.padEnd(99, "-")} `;

  it("are only the links in the slice handed over, not the rest of the page", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }] },
      reader({ [A]: okPage(firstHalf + secondHalf), [B]: { status: "refused", httpStatus: 403 } }),
    );

    // Two pages share 100 characters: page A's slice is its first 50, which holds X only.
    expect(answer.pages[0]!.links).toEqual([X]);
    expect(answer.pages[1]!.links).toEqual([]);
  });

  it("are the links of its own text for each slice of one page read on with next_start", async () => {
    const tools = turn();
    const readPages = reader({ [A]: okPage(firstHalf + secondHalf) });

    const first = await fetchWith(tools, { pages: [{ url: A }] }, readPages);
    expect(first.pages[0]).toMatchObject({ start: 0, end: 100, next_start: 100 });
    const next = await fetchWith(tools, { pages: [{ url: A, start: 100 }] }, readPages);

    expect(first.pages[0]!.links).toEqual([X]);
    expect(next.pages[0]!.links).toEqual([Y]);
  });

  it("name one page once, in the spelling the slice first writes it", async () => {
    const text = `${X} and again http://A.example/one/ and ${X} once more`;

    const answer = await fetchWith(turn(), { pages: [{ url: A }] }, reader({ [A]: okPage(text) }));

    expect(answer.pages[0]!.links).toEqual([X]);
  });

  it("include a link written in the page's title", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }] },
      reader({ [A]: okPage("This page has moved.", { title: "Moved to example.org/new-docs" }) }),
    );

    expect(answer.pages[0]!.links).toContain("example.org/new-docs");
  });

  it("are none on a repeat of a page asked twice at one start", async () => {
    const answer = await fetchWith(turn(), { pages: [{ url: A }, { url: A }] }, reader({ [A]: okPage(`See ${X} now`) }));

    expect(answer.pages[0]!.links).toEqual([X]);
    expect(answer.pages[1]!.links).toEqual([]);
  });
});

describe("a call where no page could be read", () => {
  // Plan §13.2 row 6: a page, not a link the user gave, so two lines of its
  // own; written as the keys themselves until the table carries them.
  it.each([
    ["unreachable", 404, "chat.tool.failure.pageUnreachable"],
    ["unsupported_type", 200, "chat.tool.failure.pageUnsupportedType"],
  ] as const)("fails with the page's own %s line when every page ended that way", async (status, httpStatus, userKey) => {
    const failure = await failureOf(
      fetchWith(turn(), { pages: [{ url: A }, { url: B }] }, reader({ [A]: { status, httpStatus }, [B]: { status, httpStatus } })),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey });
  });

  it("names a page asked three times once among the pages not read", async () => {
    const failure = await failureOf(
      fetchWith(
        turn(),
        { pages: [{ url: B }, { url: B }, { url: B }] },
        reader({ [B]: { status: "refused", httpStatus: 403 } }),
      ),
    );

    expect(failure.forModel.split(`- ${B}:`).length - 1, failure.forModel).toBe(1);
  });

  it.each([
    ["needs_login", 401, FAILURE_LINES.pageNeedsLogin],
    ["refused", 403, FAILURE_LINES.pageRefused],
    ["busy", 503, FAILURE_LINES.busy],
    ["too_slow", undefined, FAILURE_LINES.pageTooSlow],
    ["too_large", 200, FAILURE_LINES.fileTooLarge],
    ["empty", 200, FAILURE_LINES.pageEmpty],
  ] as const)("fails with the %s line when every page ended that way", async (status, httpStatus, userKey) => {
    const outcome: PageOutcome = httpStatus === undefined ? { status } : { status, httpStatus };
    const failure = await failureOf(
      fetchWith(turn(), { pages: [{ url: A }, { url: B }] }, reader({ [A]: outcome, [B]: outcome })),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey });
  });

  it("turns the model away, showing the user nothing, when no link is one the conversation holds (plan §9 Y)", async () => {
    const failure = await failureOf(fetchWith(turn(() => false), { pages: [{ url: A }, { url: B }] }, reader({})));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure).not.toHaveProperty("userKey");
    expect(failure.forModel).toContain("web_search");
    expect(failure.forModel).toContain(A);
    expect(failure.forModel).toContain(B);
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

  it("shows the user the reason the other pages failed when some links are not the conversation's (plan §9 Y)", async () => {
    const failure = await failureOf(
      fetchWith(
        turn((url) => url !== A),
        { pages: [{ url: A }, { url: B }] },
        reader({ [B]: { status: "busy", httpStatus: 429 } }),
      ),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.busy });
  });

  it("shows pagesUnreadable when the other pages failed for different reasons", async () => {
    const failure = await failureOf(
      fetchWith(
        turn((url) => url !== A),
        { pages: [{ url: A }, { url: B }, { url: C }] },
        reader({ [B]: { status: "busy", httpStatus: 429 }, [C]: { status: "refused", httpStatus: 403 } }),
      ),
    );

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.pagesUnreadable });
  });

  it("still tells the model about the link the conversation does not hold", async () => {
    const failure = await failureOf(
      fetchWith(
        turn((url) => url !== A),
        { pages: [{ url: A }, { url: B }] },
        reader({ [B]: { status: "busy", httpStatus: 429 } }),
      ),
    );

    expect(failure.forModel).toContain("not_in_conversation");
  });
});

describe("a call where some pages could not be read", () => {
  it("names a page asked three times once in the Not read part of what the model reads", async () => {
    const answer = await fetchWith(
      turn(),
      { pages: [{ url: A }, { url: B }, { url: B }, { url: B }] },
      reader({ [A]: okPage("Body."), [B]: { status: "refused", httpStatus: 403 } }),
    );

    const rendered = renderFetchForModel(answer);
    expect(rendered.split(`- ${B}:`).length - 1, rendered).toBe(1);
  });

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

// Plan §13.2 row 5: a call that also continues a page the turn already holds
// still hands that part over when the reader fails; only the pages it had to
// read end as busy.
describe("when the reader does not answer and the turn's cache holds part of the call", () => {
  it.each([
    ["the Worker answering 502", (): Error => new UploadHttpError(502)],
    ["the server refusing to read", (): Error => new ReadPagesRefused("rate_limited")],
  ])("returns the cached page's continuation and marks the page it had to read as not read, on %s", async (_label, error) => {
    const tools = turn();
    const full = filler(250);
    const first = await fetchWith(tools, { pages: [{ url: A }] }, reader({ [A]: okPage(full) }));
    const nextStart = first.pages[0]!.next_start;
    expect(nextStart).toBe(100);
    const failing = vi.fn<ReadPages>(async () => {
      throw error();
    });

    const answer = await fetchWith(tools, { pages: [{ url: A, start: nextStart! }, { url: B }] }, failing);

    expect(failing.mock.calls[0]![0].urls).toEqual([B]);
    expect(answer.pages[0]).toMatchObject({ url: A, status: "ok", start: 100, text: full.slice(100, 200) });
    expect(answer.pages[1]!.status).not.toBe("busy");
  });

  // Plan §14 rows 6 and 8: the page was never asked of the site, so it is not
  // busy; the model is told whether reading it again now can help.
  it("marks the page too_frequent when the server refused to read, telling the model not to read it again now", async () => {
    const tools = turn();
    await fetchWith(tools, { pages: [{ url: A }] }, reader({ [A]: okPage(filler(250)) }));
    const failing = vi.fn<ReadPages>(async () => {
      throw new ReadPagesRefused("rate_limited");
    });

    const answer = await fetchWith(tools, { pages: [{ url: A, start: 100 }, { url: B }] }, failing);

    expect(answer.pages[1]).toMatchObject({ url: B, status: "too_frequent" });
    const line = renderFetchForModel(answer).split("\n").find((text) => text.startsWith(`- ${B}:`)) ?? "";
    expect(line).toContain("too_frequent");
    expect(line).toMatch(/do not read it again/i);
  });

  it("marks the page not_read when the reader did not answer, telling the model reading it once more may work", async () => {
    const tools = turn();
    await fetchWith(tools, { pages: [{ url: A }] }, reader({ [A]: okPage(filler(250)) }));
    const failing = vi.fn<ReadPages>(async () => {
      throw new UploadHttpError(502);
    });

    const answer = await fetchWith(tools, { pages: [{ url: A, start: 100 }, { url: B }] }, failing);

    expect(answer.pages[1]).toMatchObject({ url: B, status: "not_read" });
    const line = renderFetchForModel(answer).split("\n").find((text) => text.startsWith(`- ${B}:`)) ?? "";
    expect(line).toContain("not_read");
    expect(line).toMatch(/once more/i);
  });

  it("still fails the whole call when every page it asks for needs the reader", async () => {
    const tools = turn();
    await fetchWith(tools, { pages: [{ url: A }] }, reader({ [A]: okPage(filler(250)) }));
    const failing = vi.fn<ReadPages>(async () => {
      throw new UploadHttpError(502);
    });

    const failure = await failureOf(fetchWith(tools, { pages: [{ url: B }] }, failing));

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.unavailable });
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

  it.each([
    [400, null],
    [401, null],
    [404, null],
    [503, "reader_not_started"],
  ] as const)(
    "records nothing when the Worker answered %d naming %s, so no container ran (plan §9 I)",
    async (status, code) => {
      const spy = usageSpy();
      const readPages = vi.fn<ReadPages>(async () => {
        throw new UploadHttpError(status, code);
      });

      const failure = await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages, { spy }));

      expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.unavailable });
      expect(spy.serviceCalls).toEqual([]);
    },
  );

  it.each([500, 503])("estimates from the time it took when the Worker answered %d naming nothing, after a container may have run", async (status) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(1_800_000_000_000);
    const readPages = vi.fn<ReadPages>(async () => {
      vi.advanceTimersByTime(4_000);
      throw new UploadHttpError(status);
    });
    const spy = usageSpy();

    await failureOf(fetchWith(turn(), { pages: [{ url: A }] }, readPages, { spy }));

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

  // Plan §12 row 1: with the user's own link refused, a model that found the
  // page's content through web_search summarised that instead of asking for
  // the page itself.
  it("says to ask the user for the page's text even when a search finds content about the page", () => {
    expect(said()).toMatch(/even when a search finds/i);
  });

  it.each(["refused", "needs_login"] as const)(
    "tells the model, for a page that %s, to ask the user for its text even when a search finds content about it",
    (status) => {
      const rendered = renderFetchForModel({
        pages: [{ url: "https://user-gave.example/page", status, links: [] }],
        sources: [],
      });

      expect(rendered).toMatch(/even when a search finds/i);
    },
  );

  it("says a page whose text is a login form, a paywall or a verification or security check counts as needing a login or refused, even when it came back ok (plan §9 E)", () => {
    expect(said()).toMatch(/paywall/i);
    expect(said()).toMatch(/verification|security check/i);
    expect(said()).toMatch(/\bok\b/);
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
