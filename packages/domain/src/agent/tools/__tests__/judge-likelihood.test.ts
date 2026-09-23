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
  };
});

// Without this, an assertion that stopped going through `httpRequest` would
// quietly reach the real endpoint and fail for the wrong reason.
vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: judge_likelihood must go through httpRequest");
});

import { judgeLikelihood } from "@domain/agent/tools/judge-likelihood.js";
import { TOOL_MAP, BASELINE_TOOLS } from "@domain/agent/tools/index.js";
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

  it("is left out of a deployment with no key", async () => {
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
    timeoutMs = 10_000;
    httpRequestMock.mockResolvedValueOnce(responseOf({ answers: ANSWERS }));
    await askAll();
    const [, , options] = httpRequestMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({ replaySafe: false, timeoutMs: 10_000 });
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
    expect(forModel.toLowerCase()).toContain("rate");
    expect(forModel).not.toContain("openrouter.ai");
  });

  it("says nothing answered when the delivery never landed", async () => {
    httpRequestMock.mockRejectedValueOnce(new Error("http request to <redacted> timed out"));
    const { forModel, readerKey } = await failureOf(askAll);
    expect(readerKey).toBe(FAILURE_LINES.unreachable);
    expect(forModel).not.toContain("openrouter.ai");
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
