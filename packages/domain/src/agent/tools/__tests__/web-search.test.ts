// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import type { z } from "zod";
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
/** What the deployment has `web_search_max_tokens` set to, per test. */
let maxTokens = 8192;

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...actual.getAgentConfig(),
      web_search_max_tokens: maxTokens,
    }),
    env: new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === "BRAVE_SEARCH_API_KEY" ? apiKey : undefined,
      },
    ),
  };
});

// Without this, a handoff assertion that stopped going through `httpRequest`
// would quietly reach the real Brave API and fail for the wrong reason.
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
 * A body shaped like the LLM context endpoint's.
 * @param sources - One entry per source: its snippets.
 * @returns A 200 carrying that grounding.
 */
const grounding = (sources: string[][]): Response =>
  new Response(
    JSON.stringify({
      grounding: {
        generic: sources.map((snippets, i) => ({
          url: `https://s${String(i)}.example`,
          title: `Source ${String(i)}`,
          snippets,
        })),
      },
      sources: {},
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * A Brave-shaped success body.
 * @returns A 200 carrying one source.
 */
const braveOk = (): Response => grounding([["D"]]);

describe("web_search hands the request to the shared transport", () => {
  beforeEach(() => {
    apiKey = "test-key";
    maxTokens = 8192;
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
      redirect: "manual",
    });
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
    maxTokens = 8192;
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
    maxTokens = 8192;
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
    expect(forModel.toLowerCase()).toMatch(
      /do not call this tool again|do not search again|do not repeat/,
    );
  });

  it.each([
    [500, /fault on their side/i],
    [403, /credentials/i],
  ])("puts HTTP %i on the right side of the line", async (status: number, says: RegExp) => {
    // 三个分支的边界各自只差一个数:500 是「他们的」那一档的第一个,403 是凭据
    // 那一档的最后一个。两条边界一个用例都没有时,把它们各挪一位 793 条测试全绿。
    httpRequestMock.mockImplementation(async () => new Response(null, { status }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(says);
  });

  it("counts being rate limited as the service's own trouble", async () => {
    // Numbered among the 4xx, but the query is not what it objects to.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 429 }));

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/fault on their side/i);
    expect(forModel).not.toMatch(/would not take/i);
  });

  it("does offer a reworded query for a request the service would not take", async () => {
    // 400 rather than 422: on this endpoint a 422 is what this side sent being
    // refused (an invalid token, or a parameter out of range), and no rewording
    // reaches either. That case is pinned in its own block below.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 400 }));

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

  it("says a body that stopped arriving may be worth asking for again", async () => {
    // The connection is reset while the body is being read. What the service
    // meant to send was never seen from here, so "it answered, but not with
    // results" is a claim this layer cannot make: the answer may well have
    // been results. Asking once more is what fits what is known.
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
    // is a red test rather than a silent loss. The list is written by hand
    // while the name of this case says "every one", which is a claim only as
    // true as the last person to add a failure and come back here -- twice
    // now it has not been. A throw added to the tool gets a site added here.
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
      // 这个清单原先漏掉的两支。清单是手写的,而这条用例的名字说的是「每一条」。
      async (): Promise<ToolFailure> => {
        // 凭据被拒。上面那条 503 走的是同一个函数的另一支。
        httpRequestMock.mockImplementation(async () => new Response(null, { status: 401 }));
        return failureFrom(() => run({ query: "breatic" }));
      },
      async (): Promise<ToolFailure> => {
        // 这个请求它不收。
        httpRequestMock.mockImplementation(async () => new Response(null, { status: 422 }));
        return failureFrom(() => run({ query: "breatic" }));
      },
      // 「答了，但答的不是结果」的两个判据各来一次。它们说的是同一句话，而
      // 判据是两个:整个响应体不是对象、以及 `web.results` 在那儿但不是列表。
      async (): Promise<ToolFailure> => {
        httpRequestMock.mockImplementation(
          async () =>
            new Response("null", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );
        return failureFrom(() => run({ query: "breatic" }));
      },
      async (): Promise<ToolFailure> => {
        httpRequestMock.mockImplementation(
          async () =>
            new Response(JSON.stringify({ web: { results: "一段文字" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );
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
      // 而且不把下一步限定在「这一轮」。这句话模型读两次:失败当场读一次，之后
      // 它跟着记录进历史，以后每一轮再读一次 —— 而那时「这一轮」指的已经是另
      // 一轮了。绑到这一次调用上的说法（「这次搜索」）两处读都对。
      expect(forModel.toLowerCase()).not.toContain("this turn");
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

describe("web_search asks for page content, not for snippets of a listing", () => {
  beforeEach(() => {
    apiKey = "test-key";
    maxTokens = 8192;
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => grounding([["body text"]]));
  });

  it("addresses the endpoint that returns extracted page content", async () => {
    await run({ query: "cyberpunk palette" });

    const [url] = httpRequestMock.mock.calls[0] as [string];
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      "https://api.search.brave.com/res/v1/llm/context",
    );
    expect(new URL(url).searchParams.get("q")).toBe("cyberpunk palette");
  });

  it("puts every source's own text in front of the model", async () => {
    httpRequestMock.mockImplementation(async () =>
      grounding([["first half", "second half"], ["other page"]]),
    );

    const out = await run({ query: "cyberpunk palette" });

    expect(out).toContain("first half");
    expect(out).toContain("second half");
    expect(out).toContain("other page");
    expect(out).toContain("https://s0.example");
    expect(out).toContain("https://s1.example");
  });

  it("asks for as many sources as the model wanted", async () => {
    await run({ query: "cyberpunk palette", count: 3 });

    const [url] = httpRequestMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("maximum_number_of_urls")).toBe("3");
  });

  it("asks for the amount of content the deployment configured", async () => {
    maxTokens = 2048;

    await run({ query: "cyberpunk palette" });

    const [url] = httpRequestMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("maximum_number_of_tokens")).toBe("2048");
  });

  it("refuses a query with nothing in it before spending a delivery", async () => {
    // The service answers 422 `too_short` for an empty q, which the tool would
    // then have to explain to the model. Rejecting it here gives the model the
    // SDK's input error instead, which is the signal that says: write a query.
    // Declared as the SDK's own `FlexibleSchema`, which says nothing about
    // parsing; what the tool passes it is a zod object, and that is the thing
    // being asserted here.
    const schema = webSearch.inputSchema as unknown as z.ZodType<{ query: string }>;

    expect(schema.safeParse({ query: "   " }).success).toBe(false);
    expect(schema.safeParse({ query: "a real query" }).success).toBe(true);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("tells the transport not to follow a redirect", async () => {
    await run({ query: "cyberpunk palette" });

    const [, init] = httpRequestMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });
});

describe("web_search says whose fault a refusal is", () => {
  beforeEach(() => {
    apiKey = "test-key";
    maxTokens = 8192;
    httpRequestMock.mockReset();
  });

  it("calls a rejected subscription token a fault on this side", async () => {
    httpRequestMock.mockImplementation(
      async () => new Response('{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}', { status: 422 }),
    );

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/configuration|this side/i);
    expect(forModel).not.toMatch(/different wording|try a different/i);
  });

  it("calls a redirect a fault on this side too", async () => {
    // With `redirect: "manual"` a 3xx comes back as an ordinary response. The
    // address we hold is the stale thing; no wording of the query reaches it.
    httpRequestMock.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere" } }),
    );

    const { forModel } = await failureFrom(() => run({ query: "breatic" }));

    expect(forModel).toMatch(/configuration|this side/i);
    expect(forModel).not.toMatch(/different wording|try a different/i);
  });
});

describe("web_search reports a search that came back empty", () => {
  beforeEach(() => {
    apiKey = "test-key";
    maxTokens = 8192;
    httpRequestMock.mockReset();
  });

  it("calls an empty grounding array a search that found nothing", async () => {
    // Measured against the live endpoint: a `site:` query against a domain with
    // nothing on it answers 200 with `generic` as an empty array. This is a
    // path a model reaches, not a schema drift.
    httpRequestMock.mockImplementation(async () => grounding([]));

    const out = await run({ query: "site:example.invalid pricing" });

    expect(out).toMatch(/no .*results|found nothing|came back empty/i);
    expect(out).not.toContain("https://s0.example");
  });

  it("separates a search that found nothing from an answer it cannot read", async () => {
    // Both used to look alike: an implementation that does not know this
    // response shape reads every body as "nothing found". A body with no
    // grounding at all is the service answering something else, which is a
    // failure; an empty `generic` is a search that ran and found nothing.
    httpRequestMock.mockImplementation(
      async () => new Response('{"sources":{}}', { status: 200 }),
    );

    const { forModel } = await failureFrom(() =>
      run({ query: "site:example.invalid pricing" }),
    );

    expect(forModel).toMatch(/not with results|their side/i);
  });

  it("keeps our subscription state out of what it says", async () => {
    httpRequestMock.mockImplementation(async () => grounding([]));

    const out = await run({ query: "site:example.invalid pricing" });

    expect(out).not.toMatch(/plan|subscription|deployment/i);
  });
});

describe("web_search bounds what one search can inject", () => {
  beforeEach(() => {
    apiKey = "test-key";
    maxTokens = 8192;
    httpRequestMock.mockReset();
  });

  it("drops whole sources rather than cutting one in half", async () => {
    // Each source carries far more than the ceiling allows in total, so the
    // assembled string has to lose some of them.
    const fat = "x".repeat(20_000);
    httpRequestMock.mockImplementation(async () =>
      grounding([[fat], [fat], [fat], [fat], [fat], [fat], [fat], [fat]]),
    );

    const out = await run({ query: "cyberpunk palette" });

    const kept = out.split("https://s").length - 1;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(8);
    // Every source still present kept all of its text: as many whole copies of
    // the body as there are surviving sources, so none was cut mid-snippet.
    expect(out.split(fat).length - 1).toBe(kept);
  });

  it("raises its ceiling when the deployment raises the budget", async () => {
    // The ceiling is four characters per configured token, so a deployment
    // that asks for more text gets more of it through. A fixed ceiling would
    // cut into what operations themselves asked for -- measured, a legal
    // answer at 16384 tokens is 60048 characters, over the 50000 an earlier
    // draft of this had proposed as a constant.
    const fat = "z".repeat(20_000);
    const sources: string[][] = Array.from({ length: 8 }, () => [fat]);
    httpRequestMock.mockImplementation(async () => grounding(sources));

    maxTokens = 8192;
    const tight = await run({ query: "cyberpunk palette" });
    maxTokens = 32768;
    const roomy = await run({ query: "cyberpunk palette" });

    const kept = (out: string): number => out.split("https://s").length - 1;
    expect(kept(roomy)).toBeGreaterThan(kept(tight));
  });

  it("says so when it had to drop sources", async () => {
    const fat = "y".repeat(20_000);
    httpRequestMock.mockImplementation(async () =>
      grounding([[fat], [fat], [fat], [fat], [fat], [fat], [fat], [fat]]),
    );

    const out = await run({ query: "cyberpunk palette" });

    // Without this line the model reads the sources it can see as all there
    // were, and answers "nothing I found says X" when X was in a dropped one.
    expect(out).toMatch(/dropped|omitted|not shown|of \d+ sources/i);
  });
});
