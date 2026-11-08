// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The turn's two web tools (inner#1664): `web_search` and `web_fetch` are
 * built together by `makeWebTools`, so the sources the model cites share one
 * run of numbers however the two are called -- one after the other, or in the
 * same step. Also pinned: how they reach a turn through the registry, and that
 * `web_search` built this way behaves as it did before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";
import type { z } from "zod";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type { ReadPagesRequest } from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

let apiKey = "test-key";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...actual.getAgentConfig(),
      web_search_max_tokens: 8192,
      web_search_timeout_ms: 10_000,
      web_fetch_max_urls: 20,
      web_fetch_timeout_ms: 90_000,
      web_fetch_page_timeout_ms: 30_000,
      web_fetch_settle_ms: 8_000,
      web_fetch_concurrency: 6,
      web_fetch_max_chars: 80_000,
      web_fetch_max_bytes: 20_971_520,
    }),
    getMiniToolsConfig: () => {
      const real = actual.getMiniToolsConfig();
      return {
        ...real,
        classes: { ...real.classes, WebReaderContainer: { instance_type: "standard-2", vcpu: 1, memory_gib: 6, disk_gb: 12 } },
      };
    },
    env: new Proxy({}, { get: (_t, prop: string) => (prop === "BRAVE_SEARCH_API_KEY" ? apiKey : undefined) }),
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: the web tools must go through httpRequest or readPages");
});

import { BASELINE_TOOLS, NO_TOOL_CONTEXT, TOOL_MAP, buildToolSet, type ToolContext } from "@domain/agent/tools/index.js";
import { WEB_FETCH } from "@domain/agent/tools/tool-names.js";
import { makeWebTools, publisherOf } from "@domain/agent/tools/web-tools.js";
import type { FetchAnswer, ReadPages } from "@domain/agent/tools/web-fetch.js";
import { renderSearchForModel, type SearchAnswer } from "@domain/agent/tools/web-search.js";
import { usageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";

/** A turn's context in which every link is one the conversation holds. */
const CONTEXT: ToolContext = { mediaUrlAllowed: () => false, pageUrlFor: async (url: string) => url };

/**
 * A body shaped like Brave's LLM context endpoint.
 * @param entries - One entry per source.
 * @returns A 200 carrying that grounding.
 */
function grounding(entries: { url: string; title: string; snippets: string[] }[]): Response {
  return new Response(JSON.stringify({ grounding: { generic: entries } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A reader that reads every page it is asked for as a short HTML page. */
const readPages = vi.fn<ReadPages>(async (request: ReadPagesRequest) => ({
  pages: request.urls.map((url) => ({ url, status: "ok" as const, title: url, kind: "html" as const, text: `Body of ${url}.` })),
  usage: { wallMs: 1_000, cpuUsec: 500_000 },
}));

/**
 * Run a search the way the model runtime does.
 * @param search - The turn's web_search, if it was built.
 * @param query - What to search for.
 * @returns The structured answer.
 */
async function searchWith(search: Tool | undefined, query: string): Promise<SearchAnswer> {
  if (search === undefined) throw new Error("web_search was not built");
  const execute = search.execute;
  if (execute === undefined) throw new Error("web_search has no execute");
  const parsed = (search.inputSchema as unknown as z.ZodType<{ query: string; count: number }>).parse({ query });
  return (await execute(parsed, {
    toolCallId: "s1",
    messages: [],
    context: { usage: usageSpy().recorder, readPages },
  } as never)) as SearchAnswer;
}

/**
 * Run a fetch the way the model runtime does.
 * @param fetchTool - The turn's web_fetch, if it was built.
 * @param urls - The pages to read.
 * @returns The structured answer.
 */
async function fetchWith(fetchTool: Tool | undefined, urls: string[]): Promise<FetchAnswer> {
  if (fetchTool === undefined) throw new Error("web_fetch was not built");
  const execute = fetchTool.execute;
  if (execute === undefined) throw new Error("web_fetch has no execute");
  const parsed = (fetchTool.inputSchema as unknown as z.ZodType).parse({ pages: urls.map((url) => ({ url })) });
  return (await execute(parsed, {
    toolCallId: "f1",
    messages: [],
    context: { usage: usageSpy().recorder, readPages },
  } as never)) as FetchAnswer;
}

/**
 * Every number a set of answers handed out.
 * @param searches - Search answers.
 * @param fetches - Fetch answers.
 * @returns The numbers, ascending.
 */
function numbersOf(searches: SearchAnswer[], fetches: FetchAnswer[]): number[] {
  return [
    ...searches.flatMap((a) => a.sources.map((s) => s.index)),
    ...fetches.flatMap((a) => a.pages.flatMap((p) => (p.index === undefined ? [] : [p.index]))),
  ].sort((x, y) => x - y);
}

beforeEach(() => {
  apiKey = "test-key";
  httpRequestMock.mockReset();
  readPages.mockClear();
});

describe("web_fetch in the registry", () => {
  it("is named web_fetch", () => {
    expect(WEB_FETCH).toBe("web_fetch");
  });

  it("is registered and offered on every turn", () => {
    expect(TOOL_MAP).toHaveProperty("web_fetch");
    expect(BASELINE_TOOLS).toContain("web_fetch");
  });

  it("needs no search key: it is built on a deployment without one, and web_search is not", () => {
    apiKey = "";
    expect(Object.keys(buildToolSet(["web_search", "web_fetch"], CONTEXT))).toEqual(["web_fetch"]);
  });

  it("is built beside web_search when the search key is set", () => {
    expect(Object.keys(buildToolSet(["web_search", "web_fetch"], CONTEXT))).toEqual(["web_search", "web_fetch"]);
  });

  it("reads the turn's links through the context it was built with", async () => {
    const urlFor = vi.fn(async (_url: string): Promise<string | undefined> => undefined);
    const set = buildToolSet(["web_fetch"], { mediaUrlAllowed: () => false, pageUrlFor: urlFor });

    await fetchWith(set.web_fetch, ["https://example.com/a"]).catch(() => undefined);

    expect(urlFor).toHaveBeenCalledWith("https://example.com/a");
    expect(readPages).not.toHaveBeenCalled();
  });

  it("sends the reader the spelling the context recorded, not the model's (plan §9 A)", async () => {
    const set = buildToolSet(["web_fetch"], {
      mediaUrlAllowed: () => false,
      pageUrlFor: async (url: string) => (url.startsWith("https://example.com/a") ? "https://example.com/a" : undefined),
    });

    const answer = await fetchWith(set.web_fetch, ["https://example.com/a#secret"]);

    expect(readPages).toHaveBeenCalledTimes(1);
    expect(readPages.mock.calls[0]![0].urls).toEqual(["https://example.com/a"]);
    expect(answer.pages[0]).toMatchObject({ url: "https://example.com/a#secret", status: "ok" });
  });

  it("holds no link when the turn knows no conversation", async () => {
    expect(await NO_TOOL_CONTEXT.pageUrlFor?.("https://example.com/a")).toBeUndefined();
    expect(NO_TOOL_CONTEXT).not.toHaveProperty("pageUrlAllowed");
  });
});

describe("one run of citation numbers across web_search and web_fetch", () => {
  it("continues from a search into a fetch when buildToolSet builds both for a turn", async () => {
    httpRequestMock.mockImplementation(() =>
      grounding([
        { url: "https://a.example", title: "A", snippets: ["a"] },
        { url: "https://b.example", title: "B", snippets: ["b"] },
      ]),
    );
    const set = buildToolSet(["web_search", "web_fetch"], CONTEXT);

    const search = await searchWith(set.web_search, "q");
    const fetched = await fetchWith(set.web_fetch, ["https://c.example/page"]);

    expect(search.sources.map((s) => s.index)).toEqual([1, 2]);
    expect(fetched.pages.map((p) => p.index)).toEqual([3]);
  });

  it("continues from a fetch into a search in one makeWebTools", async () => {
    httpRequestMock.mockImplementation(() => grounding([{ url: "https://a.example", title: "A", snippets: ["a"] }]));
    const tools = makeWebTools(CONTEXT);

    const fetched = await fetchWith(tools.web_fetch, ["https://c.example/page", "https://d.example/page"]);
    const search = await searchWith(tools.web_search, "q");

    expect(fetched.pages.map((p) => p.index)).toEqual([1, 2]);
    expect(search.sources.map((s) => s.index)).toEqual([3]);
  });

  it("never hands out one number twice when a search and a fetch run in the same step", async () => {
    httpRequestMock.mockImplementation(() =>
      grounding([
        { url: "https://a.example", title: "A", snippets: ["a"] },
        { url: "https://b.example", title: "B", snippets: ["b"] },
      ]),
    );
    const tools = makeWebTools(CONTEXT);

    const [search, fetchedOne, fetchedTwo] = await Promise.all([
      searchWith(tools.web_search, "q"),
      fetchWith(tools.web_fetch, ["https://c.example/page"]),
      fetchWith(tools.web_fetch, ["https://d.example/page", "https://e.example/page"]),
    ]);

    expect(numbersOf([search], [fetchedOne, fetchedTwo])).toEqual([1, 2, 3, 4, 5]);
  });

  it("starts again from one in a fresh makeWebTools", async () => {
    httpRequestMock.mockImplementation(() => grounding([{ url: "https://a.example", title: "A", snippets: ["a"] }]));
    const first = makeWebTools(CONTEXT);
    await searchWith(first.web_search, "q");
    await fetchWith(first.web_fetch, ["https://c.example/page"]);

    const fresh = makeWebTools(CONTEXT);

    expect((await fetchWith(fresh.web_fetch, ["https://c.example/page"])).pages[0]!.index).toBe(1);
    expect((await searchWith(fresh.web_search, "q")).sources[0]!.index).toBe(2);
  });
});

describe("web_search built by makeWebTools", () => {
  it("answers and renders as before", async () => {
    httpRequestMock.mockImplementation(() =>
      grounding([{ url: "https://www.vogue.co.uk/runway", title: "Runway", snippets: ["one", "two"] }]),
    );

    const answer = await searchWith(makeWebTools(CONTEXT).web_search, "spring runway");

    expect(answer).toEqual({
      query: "spring runway",
      sources: [{ url: "https://www.vogue.co.uk/runway", title: "Runway", publisher: "Vogue", excerpts: ["one", "two"], index: 1 }],
      sent: 1,
    });
    expect(renderSearchForModel(answer)).toContain('<source index="1">\nurl: https://www.vogue.co.uk/runway\ntitle: Runway\n<text>\none\n[...]\ntwo\n</text>\n</source>');
  });

  it("records one Brave request per search, as before", async () => {
    httpRequestMock.mockImplementation(() => grounding([{ url: "https://a.example", title: "A", snippets: ["a"] }]));
    const spy = usageSpy();
    const search = makeWebTools(CONTEXT).web_search;
    const execute = search.execute;
    if (execute === undefined) throw new Error("web_search has no execute");

    await execute({ query: "q", count: 5 }, { toolCallId: "s1", messages: [], context: { usage: spy.recorder } } as never);

    expect(spy.serviceCalls).toEqual([
      { source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 },
    ]);
  });

  it("keeps its running line", () => {
    expect(makeWebTools(CONTEXT).web_search.metadata).toEqual({ runningLine: "chat.tool.searching" });
  });

  it("says its numbers are shared with web_fetch", () => {
    const description = makeWebTools(CONTEXT).web_search.description;
    const said = typeof description === "string" ? description.replace(/\s+/g, " ") : "";

    expect(said).toContain("web_fetch");
    expect(said).toMatch(/share one run of numbers/i);
  });
});

describe("publisherOf", () => {
  it.each([
    ["https://www.vogue.co.uk/fashion", "Vogue"],
    ["https://vitest.dev/guide/", "Vitest"],
    ["https://news.example/b", "News"],
    ["not an address", "not an address"],
  ])("names %s as %s, as web_search always has", (url, publisher) => {
    expect(publisherOf(url)).toBe(publisher);
  });
});
