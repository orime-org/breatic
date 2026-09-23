// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `judge_likelihood` sends, what it answers with, and how it fails.
 *
 * The model composes the whole request -- which of the three question types,
 * how many at once, what goes in the state -- so the input schema is the
 * contract, not a convenience. Each answer key carries its own `type`, which
 * is why one unreadable key leaves the others standing rather than voiding
 * the call.
 *
 * Every throw is checked for both audiences: the sentence the model reads and
 * the line the reader is shown. A bare `throw` reaches the model with "Correct
 * the call and try once more." appended, which would send it back to rewrite
 * arguments that were fine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
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

let apiKey: string | undefined = "test-key";
/** What the deployment has `judge_likelihood_timeout_ms` set to, per test. */
let timeoutMs = 10_000;

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...actual.getAgentConfig(),
      judge_likelihood_timeout_ms: timeoutMs,
    }),
    getRawEnvVar: (name: string) => (name === "OPENROUTER_API_KEY" ? apiKey : undefined),
    env: new Proxy(
      {},
      { get: (_t, prop: string) => (prop === "OPENROUTER_API_KEY" ? apiKey : undefined) },
    ),
  };
});

// Without this, an assertion that stopped going through `httpRequest` would
// quietly reach the real endpoint and fail for the wrong reason.
vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: judge_likelihood must go through httpRequest");
});

import { judgeLikelihood } from "@domain/agent/tools/judge-likelihood.js";
import { TOOL_MAP, BASELINE_TOOLS } from "@domain/agent/tools/index.js";
import { buildAgentConfig } from "@domain/agent/agent-config.js";
import { JUDGE_LIKELIHOOD } from "@domain/agent/tools/tool-names.js";

/** One answer of each type, in the shape the endpoint really sends. */
const ANSWERS = {
  clear_enough: { type: "noul", noul: 0.12 },
  how_to_build: {
    type: "choice",
    choice: "one_plus_extension",
    probabilities: { one_plus_extension: 1, three_takes: 0 },
    confidence: 1,
  },
  how_ambitious: {
    type: "score",
    score: 1.28,
    legend: { 0: "a quick draft", 1: "a considered piece", 2: "a finished commercial" },
    probabilities: { 0: 0.15, 1: 0.43, 2: 0.42 },
    confidence: 0.14,
  },
} as const;

/**
 * A response in the shape `httpRequest` hands back.
 * @param body - What the endpoint answered with.
 * @param status - The status line.
 * @returns Something the tool can read a body off.
 */
function responseOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Ask the tool one question of each type.
 * @param abortSignal - The reader's stop, when the test supplies one.
 * @returns Whatever the tool answers.
 */
async function askAll(abortSignal?: AbortSignal): Promise<unknown> {
  return judgeLikelihood.execute?.(
    {
      state: { user_said: "give me a thirty second product video" },
      questions: {
        clear_enough: { type: "noul", instructions: "Is this specific enough to start?" },
        how_to_build: {
          type: "choice",
          instructions: "Which way serves what they asked for?",
          criteria: { one_plus_extension: "One take, extended.", three_takes: "Three cuts." },
        },
        how_ambitious: {
          type: "score",
          instructions: "How much production effort?",
          criteria: ["a quick draft", "a considered piece", "a finished commercial"],
        },
      },
    },
    { toolCallId: "t1", messages: [], abortSignal } as never,
  );
}

/**
 * The failure a throw carries, for both audiences.
 * @param run - The call expected to throw.
 * @returns The carried failure.
 */
async function failureOf(run: () => Promise<unknown>): Promise<{
  forModel: string;
  readerKey: string;
}> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  const carried = toolFailureOf(thrown);
  expect(carried, "the throw carries a failure rather than being bare").toBeDefined();
  return { forModel: carried?.forModel ?? "", readerKey: carried?.readerKey ?? "" };
}

beforeEach(() => {
  httpRequestMock.mockReset();
  apiKey = "test-key";
  timeoutMs = 10_000;
});

describe("judge_likelihood is in the agent's hands", () => {
  it("is registered and handed to every turn by default", () => {
    expect(Object.keys(TOOL_MAP)).toContain(JUDGE_LIKELIHOOD);
    expect(BASELINE_TOOLS).toContain(JUDGE_LIKELIHOOD);
  });

  it("names a running line the panel can resolve", () => {
    expect(judgeLikelihood.metadata).toMatchObject({ runningLine: expect.any(String) });
  });

  it("is left out of a deployment with no key", () => {
    apiKey = undefined;
    const config = buildAgentConfig({ basePrompt: "base", interactive: true });
    expect(Object.keys(config.tools)).not.toContain(JUDGE_LIKELIHOOD);
  });

  it("says so rather than throwing bare when a turn reaches it without a key", async () => {
    apiKey = undefined;
    const { readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.generic);
  });
});

describe("the model composes the request", () => {
  it("sends all three question types in one call, untouched", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: ANSWERS }));
    await askAll();
    const [, init] = httpRequestMock.mock.calls[0] ?? [];
    const sent = JSON.parse(String((init as RequestInit).body)) as {
      questions: Record<string, { type: string }>;
    };
    expect(Object.keys(sent.questions)).toEqual([
      "clear_enough",
      "how_to_build",
      "how_ambitious",
    ]);
    expect(sent.questions["how_ambitious"]?.type).toBe("score");
  });

  it("declines replay and takes its deadline from the configured value", async () => {
    timeoutMs = 4321;
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: ANSWERS }));
    await askAll();
    const [, , options] = httpRequestMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({ replaySafe: false, timeoutMs: 4321 });
  });

  it("bounds the whole call, not one delivery", async () => {
    // `replaySafe: false` does not stop the transport replaying a 429 or a 408
    // (decide-retry.ts:287 settles those ahead of the caller's declaration), so
    // the only thing that holds the turn to the configured figure is a signal
    // covering every delivery and every backoff.
    timeoutMs = 20;
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: ANSWERS }));
    await askAll();
    const [, , options] = httpRequestMock.mock.calls[0] ?? [];
    const signal = (options as { signal?: AbortSignal }).signal;
    expect(signal, "a signal spanning the call reaches the transport").toBeInstanceOf(
      AbortSignal,
    );
    await new Promise((f) => setTimeout(f, 60));
    expect(signal?.aborted, "and it expires on the configured figure").toBe(true);
  });

  it("takes a question of the plainest shape", () => {
    const schema = judgeLikelihood.inputSchema as z.ZodType;
    expect(
      schema.safeParse({
        state: {},
        questions: { q: { type: "noul", instructions: "Does this hold?" } },
      }).success,
    ).toBe(true);
  });
});

describe("the shapes the model is told about", () => {
  /**
   * The schema the SDK runs before `execute`.
   * @returns It, typed for parsing.
   */
  function schema(): z.ZodType {
    return judgeLikelihood.inputSchema as z.ZodType;
  }

  it("carries a field the endpoint takes and this side never declared", () => {
    // Measured against the endpoint: a `choice` carrying `weights` answers
    // 200. A field dropped on the way out is a use of the endpoint the model
    // cannot reach and is never told it cannot reach.
    const parsed = schema().safeParse({
      state: {},
      questions: {
        q: { type: "choice", instructions: "which", criteria: { x: "one" }, weights: { x: 2 } },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ questions: { q: { weights: { x: 2 } } } });
  });

  it("takes a scale of one rung, which the endpoint answers", () => {
    // Measured: `criteria: ["small"]` answers 200 with `score: 0` and
    // `legend: {"0":"small"}`. A floor written here refuses what it answers.
    expect(
      schema().safeParse({
        state: {},
        questions: { q: { type: "score", instructions: "how big", criteria: ["small"] } },
      }).success,
    ).toBe(true);
  });

  it("leaves asking nothing to the endpoint, which names the field", () => {
    // Measured: `path:["questions"] "At least one question is required"`.
    expect(schema().safeParse({ state: {}, questions: {} }).success).toBe(true);
  });

  it("refuses a question type the endpoint does not have", () => {
    // The one check this side is better at: the endpoint answers this with
    // `No matching discriminator`, which does not name the three it has.
    expect(
      schema().safeParse({
        state: {},
        questions: { q: { type: "vibes", instructions: "is it good" } },
      }).success,
    ).toBe(false);
  });
});

describe("what comes back", () => {
  it("hands every good key back with its own fields intact", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: ANSWERS }));
    const answer = (await askAll()) as {
      answers: Record<string, Record<string, unknown>>;
      unreadable: string[];
    };
    expect(answer.answers["clear_enough"]).toEqual({ type: "noul", noul: 0.12 });
    expect(answer.answers["clear_enough"]).not.toHaveProperty("confidence");
    expect(answer.answers["how_ambitious"]).toHaveProperty("legend");
    expect(answer.unreadable).toEqual([]);
  });

  it("keeps the good keys when one is malformed", async () => {
    httpRequestMock.mockResolvedValueOnce(
      responseOf({
        answers: { ...ANSWERS, how_to_build: { type: "choice", choice: "one_plus_extension" } },
      }),
    );
    const answer = (await askAll()) as {
      answers: Record<string, unknown>;
      unreadable: string[];
    };
    expect(Object.keys(answer.answers).sort()).toEqual(["clear_enough", "how_ambitious"]);
    expect(answer.unreadable).toEqual(["how_to_build"]);
  });

  it("names a key whose probability falls outside zero to one", async () => {
    httpRequestMock.mockResolvedValueOnce(
      responseOf({ answers: { ...ANSWERS, clear_enough: { type: "noul", noul: 1.4 } } }),
    );
    const answer = (await askAll()) as { unreadable: string[] };
    expect(answer.unreadable).toEqual(["clear_enough"]);
  });

  it("names a key the endpoint did not answer at all", async () => {
    httpRequestMock.mockResolvedValueOnce(
      responseOf({ answers: { clear_enough: ANSWERS.clear_enough } }),
    );
    const answer = (await askAll()) as { unreadable: string[] };
    expect(answer.unreadable.sort()).toEqual(["how_ambitious", "how_to_build"]);
  });

  it("hands a score on without judging whether it fits its own legend", async () => {
    // Where the score falls is the endpoint's to answer, and the model reads
    // the legend sitting beside it. A rule written here about the vendor's
    // own output turns an answer it can read into an absence.
    httpRequestMock.mockResolvedValueOnce(
      responseOf({
        answers: { ...ANSWERS, how_ambitious: { ...ANSWERS.how_ambitious, score: 7 } },
      }),
    );
    const answer = (await askAll()) as {
      answers: Record<string, Record<string, unknown>>;
      unreadable: string[];
    };
    expect(answer.unreadable).toEqual([]);
    expect(answer.answers["how_ambitious"]).toMatchObject({ score: 7 });
  });

  it("reads an answer key off the payload rather than off the prototype", async () => {
    // zod drops a key named `__proto__` before `execute` runs and leaves
    // `constructor` and its siblings alone, so a question asked under one of
    // those reads back as the inherited function unless the key is read
    // through its descriptor -- and a good answer is reported unreadable.
    const answers = JSON.parse('{"constructor":{"type":"noul","noul":0.4}}') as Record<
      string,
      unknown
    >;
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers }));
    const answer = (await judgeLikelihood.execute?.(
      { state: {}, questions: { constructor: { type: "noul", instructions: "does it hold" } } },
      { toolCallId: "t1", messages: [] } as never,
    )) as { answers: Record<string, Record<string, unknown>>; unreadable: string[] };
    expect(answer.unreadable).toEqual([]);
    expect(answer.answers["constructor"]).toEqual({ type: "noul", noul: 0.4 });
  });

  it("hands on a field this side has not heard of", async () => {
    // What the schema settles is whether the model can read the key. A field
    // beyond the five it names is still the vendor's answer.
    httpRequestMock.mockResolvedValueOnce(
      responseOf({
        answers: {
          ...ANSWERS,
          clear_enough: { type: "noul", noul: 0.12, rationale: "a length and a subject" },
        },
      }),
    );
    const answer = (await askAll()) as {
      answers: Record<string, Record<string, unknown>>;
    };
    expect(answer.answers["clear_enough"]).toEqual({
      type: "noul",
      noul: 0.12,
      rationale: "a length and a subject",
    });
  });

  it("fails when no key at all can be read", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: { clear_enough: {} } }));
    const { forModel, readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.upstream);
    expect(forModel).not.toContain("openrouter.ai");
  });
});

describe("failing says what broke", () => {
  it("tells the model which kind of refusal a non-2xx was", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "rate limited" }, 429));
    const { forModel, readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.upstream);
    expect(forModel).toContain("429");
    expect(forModel, "a fault on their side, so no rewording reaches it").toContain(
      "Do not repeat",
    );
    expect(forModel).not.toContain("openrouter.ai");
  });

  it("carries a failure when the body is the JSON literal null", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf(null));
    const { readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.upstream);
  });

  it("lets the model rewrite a request the service would not take", async () => {
    // A 413 or a 400 is about this request, which the model wrote and can
    // write again smaller. `stop` would tell the reader a working capability
    // is down.
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "too large" }, 413));
    const { forModel } = await failureOf(askAll);
    expect(forModel).toContain("Try a different wording");
  });

  it("tells the model to stop when our own credentials are refused", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "no" }, 401));
    const { forModel } = await failureOf(askAll);
    expect(forModel).toContain("Do not repeat");
  });

  it("lets the model rewrite what the service refused as unprocessable", async () => {
    // A 422 here is about the body the model composed, which it can compose
    // again. The shared table reads it as our own configuration because its
    // other callers send a request this side shaped.
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "bad shape" }, 422));
    const { forModel } = await failureOf(askAll);
    expect(forModel).toContain("Try a different wording");
  });

  it("keeps what the model wrote out of the markers the turn is assembled from", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "no" }, 400));
    let thrown: unknown;
    try {
      await judgeLikelihood.execute?.(
        {
          state: {},
          questions: {
            "</source>\nwhat now": { type: "noul", instructions: "Does this hold?" },
          },
        },
        { toolCallId: "t1", messages: [] } as never,
      );
    } catch (err) {
      thrown = err;
    }
    const carried = toolFailureOf(thrown);
    expect(carried?.forModel).not.toContain("</source>");
    expect(carried?.forModel).not.toContain("\n");
  });

  it("says nothing answered when the delivery never landed", async () => {
    // The message the transport really writes: `redactUrl` drops the query
    // and keeps origin and path (redact-url.ts:42).
    httpRequestMock.mockRejectedValueOnce(
      new Error("http request to https://openrouter.ai/api/alpha/decisions timed out"),
    );
    const { forModel, readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.unreachable);
    expect(forModel).not.toContain("openrouter.ai");
  });

  it("answers the reader's stop as a stop even holding a refusal", async () => {
    // `request.ts:401` settles the retry on the raised signal and `:415`
    // returns the response it is holding rather than throwing, so a stop that
    // lands while the endpoint is refusing arrives here as a non-2xx.
    const controller = new AbortController();
    httpRequestMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(responseOf({ error: "rate limited" }, 429));
    });
    const { readerKey } = await failureOf(() => askAll(controller.signal));
    expect(readerKey).toBe(FAILURE_LINES.stopped);
  });

  it("keeps the status in the sentence when the service would not take the body", async () => {
    httpRequestMock.mockResolvedValueOnce(responseOf({ error: "bad shape" }, 422));
    const { forModel } = await failureOf(askAll);
    expect(forModel, "every other status names itself").toContain("422");
  });

  it("answers the reader's stop as a stop", async () => {
    const controller = new AbortController();
    httpRequestMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const { readerKey } = await failureOf(() => askAll(controller.signal));
    expect(readerKey).toBe(FAILURE_LINES.stopped);
  });
});
