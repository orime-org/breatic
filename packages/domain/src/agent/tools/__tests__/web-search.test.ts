// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `web_search` tells the shared transport, and what it does before it
 * gets there.
 *
 * Same two invisible facts as the other call site: `replaySafe: true` is what
 * buys the retry (with `false` the transport replays 429 and 408 only, and the
 * network blip this batch is named after still fails the tool), and the 10s
 * budget must arrive as `timeoutMs` rather than as a signal on the init, which
 * the transport replaces.
 *
 * The API key check is pinned because it runs BEFORE any request: a missing
 * key is a configuration fact, not a network outcome, and it must not cost a
 * delivery to discover.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { toolFailureOf } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

let apiKey = "test-key";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    env: new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === "BRAVE_SEARCH_API_KEY" ? apiKey : undefined,
      },
    ),
  };
});

// See the note in safe-fetch.test.ts: before the move this tool calls the
// global `fetch`, so without this a handoff assertion would quietly reach the
// real Brave API and fail for the wrong reason.
vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: web_search must go through httpRequest");
});

import { webSearch } from "@domain/agent/tools/web-search.js";

/** The per-delivery budget this tool intends for one search. */
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Invoke the tool the way the model runtime does.
 * @param args - The tool's declared input.
 * @returns Whatever string the tool produced.
 */
async function run(args: { query: string; count?: number }): Promise<string> {
  const execute = webSearch.execute;
  if (execute === undefined) throw new Error("web_search has no execute");
  return (await execute(args, {
    toolCallId: "t1",
    messages: [],
  } as never)) as string;
}

/**
 * Run something that must fail, and read the detail it failed with.
 * @param fn - The call under test.
 * @returns The failure detail the thrown error carried.
 * @throws {Error} When the call returned, or threw without any detail.
 */
async function failureFrom(fn: () => Promise<unknown>): Promise<ToolFailure> {
  try {
    await fn();
  } catch (err: unknown) {
    const failure = toolFailureOf(err);
    if (failure !== undefined) return failure;
    throw new Error(
      `threw without failure detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error("the call returned instead of failing");
}

/**
 * A Brave-shaped success body.
 * @returns A 200 carrying one result.
 */
const braveOk = (): Response =>
  new Response(
    JSON.stringify({
      web: { results: [{ title: "T", url: "https://e.example", description: "D" }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("web_search hands the request to the shared transport", () => {
  beforeEach(() => {
    apiKey = "test-key";
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => braveOk());
  });

  it("declares the search replay-safe and passes its budget as a deadline", async () => {
    await run({ query: "breatic" });

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: true,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
  });

  it("sends the key and the accept header, with no signal left in the init", async () => {
    await run({ query: "breatic" });

    expect(httpRequestMock.mock.calls[0]![1]).toStrictEqual({
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": "test-key",
      },
    });
  });

  it("addresses the search endpoint with the query and count", async () => {
    await run({ query: "hello world", count: 3 });

    const url = new URL(String(httpRequestMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("count")).toBe("3");
  });

  it("says the key is missing without spending a delivery to find out", async () => {
    apiKey = "";

    const failure = await failureFrom(() => run({ query: "breatic" }));

    expect(failure.kind).toBe("tool_failed");
    expect(httpRequestMock).not.toHaveBeenCalled();
  });
});

describe("web_search says a failure is a failure", () => {
  beforeEach(() => {
    apiKey = "test-key";
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => braveOk());
  });

  it("throws when the search service answers an error status", async () => {
    // Returning a string here is what the model reads as a successful call
    // whose answer happens to mention a number. Throwing is what makes the
    // SDK mark the call failed, which is the signal the model acts on.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    const failure = await failureFrom(() => run({ query: "breatic" }));

    expect(failure.kind).toBe("tool_failed");
    expect(failure.forModel).toContain("503");
  });

  it("throws when the search service cannot be reached", async () => {
    httpRequestMock.mockImplementation(async () => {
      throw new Error("http request to https://api.search.brave.com failed after 3 attempts");
    });

    const failure = await failureFrom(() => run({ query: "breatic" }));

    expect(failure.kind).toBe("tool_failed");
    expect(failure.forModel).toContain("failed after 3 attempts");
  });

  it("tells the model what was refused, why, and what it may do instead", async () => {
    // The three things Anthropic's guidance asks a tool error to carry. A
    // message that only names what broke leaves the model with nowhere to go
    // but the same call again, which is the loop this task is named after.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toContain("breatic"); // what was refused
    expect(forModel).toContain("503"); // why
    expect(forModel.toLowerCase()).toMatch(/without search|do not repeat|tell the user/); // what instead
  });

  it("keeps the endpoint and the status out of what a reader is shown", async () => {
    httpRequestMock.mockImplementation(async () => {
      throw new Error("http request to https://api.search.brave.com failed after 3 attempts");
    });

    const { readerKey } = await failureFrom(() => run({ query: "breatic" }));

    // A key, not a sentence: the row outlives the language it was stored in.
    expect(readerKey).toMatch(/^chat\.tool\.failure\./);
    expect(readerKey).not.toContain("brave");
  });
});
