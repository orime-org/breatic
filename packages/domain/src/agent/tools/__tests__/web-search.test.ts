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
async function run(
  args: { query: string; count?: number },
  abortSignal?: AbortSignal,
): Promise<string> {
  const execute = webSearch.execute;
  if (execute === undefined) throw new Error("web_search has no execute");
  return (await execute(args, {
    ...(abortSignal ? { abortSignal } : {}),
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

describe("what a thrown tool failure carries", () => {
  // Its own reset. Without one this ran on the key the case above cleared,
  // and so on the missing-key branch rather than the 503 it sets up below --
  // the one branch it was written to pin went unrun while it passed.
  beforeEach(() => {
    apiKey = "test-key";
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => braveOk());
  });

  it("puts the model's reason on the Error itself, not only in the detail", async () => {
    // Within one turn the SDK builds the error-text it shows the model from
    // the thrown Error's `message`; the carried detail is only read later,
    // out of storage. The two have to say the same thing or the model gets a
    // useful reason a turn late.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    let thrown: unknown;
    try {
      await run({ query: "breatic" });
    } catch (err: unknown) {
      thrown = err;
    }

    expect((thrown as Error).message).toBe(toolFailureOf(thrown)?.forModel);
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

  it("does not blame the service for a status that is about our request", async () => {
    // 401 is the key this side sent being refused. Calling that a fault on
    // their side, and offering a reworded query as the way out, sends the
    // model to spend the turn rewording its way past a credential it cannot
    // reach -- which is the loop this task is named after, entered by being
    // told the wrong thing about why the call failed.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 401 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toContain("401");
    expect(forModel).not.toMatch(/fault on their side|not a problem with the query/i);
    expect(forModel).not.toMatch(/different wording/i);
  });

  it("still blames the service for a status that is theirs", async () => {
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/fault on their side/i);
  });

  it("does not offer a reworded query for a failure that has nothing to do with the query", async () => {
    // Both halves of one sentence cannot be true: if the service being down
    // is not a problem with the query, rewording the query reaches nothing.
    // The other tool says of the same status not to call it again this turn,
    // and one of the two was going to be disobeyed.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).not.toMatch(/different wording/i);
    expect(forModel.toLowerCase()).toMatch(/do not call this tool again|do not search again/);
  });

  it("counts being rate limited as the service's own trouble", async () => {
    // Numbered among the 4xx, but the query is not what it objects to.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 429 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/fault on their side/i);
    expect(forModel).not.toMatch(/would not take/i);
  });

  it("does offer a reworded query for a request the service would not take", async () => {
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 422 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/different wording/i);
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

  it("calls a search that found nothing a search that found nothing", async () => {
    // Brave 的 `web` 这一节按它自己的 schema 是 optional (nullable)，官方 API
    // reference 写着各结果类型「conditionally included based on data
    // availability」—— 也就是这个词没有网页结果时，整节不出现。这是一次成功的
    // 搜索，只是搜到零条；报成故障会让模型照着「搜索不可用」去回答用户。
    httpRequestMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ query: { original: "breatic" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const answer = await run({ query: "breatic" });

    expect(answer).toMatch(/no results/i);
  });

  it("says a body that stopped arriving may be worth asking for again", async () => {
    // 连接在读响应体期间被重置。我们从没看见对方最终发的是什么，所以「答了但
    // 不是结果」这个断言本层给不出；而 web_fetch 对结构完全相同的失败说的是
    // 「站点答了，是正文没到齐，再取一次可能就好」。同一件事两个工具说反了，
    // 其中一个必然被违背。
    httpRequestMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async (): Promise<never> => {
        throw new Error("terminated");
      },
    }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/terminated/);
    expect(forModel).toMatch(/once more|again/i);
    expect(forModel).not.toMatch(/not with results/i);
  });

  it("does not say a service that answered could not be reached", async () => {
    // A 200 whose body parses to something this tool cannot read at all. The
    // service was reached and it did answer, and a model told otherwise stops
    // searching for the rest of the turn over a network problem that is not
    // there.
    httpRequestMock.mockImplementation(
      async () =>
        new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { forModel, readerKey } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).not.toMatch(/could not be reached|unreachable/i);
    expect(forModel).toMatch(/not with results/i);
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });

  it("does not call an answer it cannot read a search that found nothing", async () => {
    // Answering "no results" for a body this tool could not read hands the
    // model a fact -- that nothing matches this query -- which it then builds
    // its reply on. Every other failure here throws; this one returned.
    httpRequestMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ web: { results: { 0: "not an array" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/not with results/i);
  });

  it("does not call a service that answered unreachable", async () => {
    // A 200 whose body is not JSON — a CDN or WAF interstitial, or a
    // content-type that drifted. `res.json()` rejects inside the same try as
    // the request, and saying the service could not be reached sends the
    // model looking for a network problem that is not there.
    httpRequestMock.mockImplementation(
      async () => new Response("<html>are you a robot</html>", { status: 200 }),
    );

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).not.toMatch(/could not be reached|unreachable/i);
  });

  it("closes every one of its reasons with what the model may do next", async () => {
    // Anthropic's guidance is specific AND actionable, and the second half is
    // the one that keeps a failing tool from being called again the same way.
    // Each site named here, so stripping the closing clause from any of them
    // is a red test rather than a silent loss.
    // Each site starts from the same known state. Left to inherit what the one
    // before it set, a site never reaches the branch it is named after: with
    // the key still cleared from the site above, every case after the first
    // ends at the missing-key check, and three branches go unrun while the loop
    // still passes.
    const sites = [
      async (): Promise<ToolFailure> => {
        apiKey = "";
        return failureFrom(() => run({ query: "breatic" }));
      },
      async (): Promise<ToolFailure> => {
        httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));
        return failureFrom(() => run({ query: "breatic" }));
      },
      async (): Promise<ToolFailure> => {
        httpRequestMock.mockImplementation(async () => new Response("<html>", { status: 200 }));
        return failureFrom(() => run({ query: "breatic" }));
      },
      async (): Promise<ToolFailure> => {
        httpRequestMock.mockImplementation(async () => {
          throw new Error("failed after 3 attempts");
        });
        return failureFrom(() => run({ query: "breatic" }));
      },
    ];

    for (const site of sites) {
      apiKey = "test-key";
      httpRequestMock.mockReset();
      httpRequestMock.mockImplementation(async () => braveOk());

      const { forModel } = await site();
      expect(forModel.toLowerCase()).toMatch(
        /do not call this tool again|try a different wording|continue without search|do not repeat/,
      );
    }
  });

  it("calls a stop during the read a stop, not the service failing", async () => {
    // The body arrives after the status does, so a turn stopped while it is
    // still being read fails inside the guard around the read rather than the
    // one around the request. Both endings look the same from there -- a
    // rejected promise -- and only the signal tells them apart.
    const gaveUp = new AbortController();
    httpRequestMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async (): Promise<never> => {
        gaveUp.abort();
        throw new Error("The operation was aborted");
      },
    }));

    const failure = await failureFrom(() => run({ query: "breatic" }, gaveUp.signal));

    expect(failure.kind).toBe("user_aborted");
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
