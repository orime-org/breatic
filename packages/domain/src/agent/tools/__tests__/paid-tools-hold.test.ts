// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every paying tool grows the turn's credit hold by its own estimate before it
 * spends, and spends nothing when the studio cannot cover it (inner#1611).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type * as understandModule from "@domain/understand/index.js";

const spend = vi.hoisted(() => vi.fn(async () => {
  throw new Error("a paid request was made");
}));

vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  httpRequest: (...args: unknown[]) => spend(...(args as [])),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getRawEnvVar: (name: string) => (name === "OPENROUTER_API_KEY" ? "or-key" : undefined),
    env: new Proxy({}, { get: (_t, prop: string) => (prop === "BRAVE_SEARCH_API_KEY" ? "brave-key" : prop === "CREDIT_MULTIPLIER" ? 2 : undefined) }),
  };
});

vi.mock("@domain/understand/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof understandModule>()),
  understandMediaAt: (...args: unknown[]) => spend(...(args as [])),
}));

vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped");
});

import { makeSearchTools } from "@domain/agent/tools/web-search.js";
import { imageSearch } from "@domain/agent/tools/image-search.js";
import { makeUnderstandMediaTool } from "@domain/agent/tools/understand-media.js";
import { judgeLikelihood } from "@domain/agent/tools/judge-likelihood.js";
import { usageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";

type Execute = (input: unknown, options: unknown) => Promise<unknown>;

/** Each paying tool, a valid input for it, and what it should hold. */
const TOOLS: { name: string; execute: () => Execute; input: unknown; holds: number }[] = [
  // $0.005 a request, at one credit a cent, doubled by the multiplier.
  { name: "web_search", execute: () => makeSearchTools().web_search.execute as Execute, input: { query: "cats", count: 3 }, holds: 1 },
  { name: "search_images", execute: () => imageSearch.execute as Execute, input: { query: "cats", count: 3 }, holds: 1 },
  {
    name: "understand_media",
    execute: () => makeUnderstandMediaTool().execute as Execute,
    input: { url: "https://example.com/a.png", question: "what is this" },
    holds: 2,
  },
  {
    name: "judge_likelihood",
    execute: () => judgeLikelihood.execute as Execute,
    input: {
      state: { request: "a poster" },
      questions: { clear_enough: { type: "noul", question: "Is it clear?" } },
    },
    holds: 0.1,
  },
];

beforeEach(() => {
  spend.mockClear();
});

describe.each(TOOLS)("$name", ({ execute, input, holds }) => {
  it("spends nothing and says the studio is out of credits when its hold cannot grow", async () => {
    const extend = vi.fn(async () => false);
    const err = await execute()(input, {
      toolCallId: "t1",
      messages: [],
      context: { usage: usageSpy().recorder, hold: { extend } },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(extend).toHaveBeenCalledWith(holds);
    expect(toolFailureOf(err)).toMatchObject({ readerKey: FAILURE_LINES.credits });
    expect(spend).not.toHaveBeenCalled();
  });

  it("holds its estimate before it spends", async () => {
    const order: string[] = [];
    const extend = vi.fn(async () => {
      order.push("hold");
      return true;
    });
    spend.mockImplementationOnce(async () => {
      order.push("spend");
      throw new Error("stop here");
    });
    await execute()(input, {
      toolCallId: "t1",
      messages: [],
      context: { usage: usageSpy().recorder, hold: { extend } },
    }).catch(() => undefined);
    expect(order.slice(0, 2)).toEqual(["hold", "spend"]);
  });
});
