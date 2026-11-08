// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { generateText, streamText } from "ai";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cost } from "../../cost.js";
import { costsOf } from "../../errors.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { CHAT_REPLY, llmProvider, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

// Property (critical path): whatever each upstream answers on each attempt of a
// prepared call, and however the call ends, every answer an upstream billed reaches the caller
// exactly once: on the finish (costOf), in pendingCosts(), or on the error (costsOf).

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopFakes(fakes);
});

/**
 * One server-sent chunk.
 * @param body - The chunk.
 * @returns Its event line.
 */
const event = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

/**
 * A chat completion chunk.
 * @param id - The generation id.
 * @param content - The text it adds.
 * @returns The event line.
 */
const chunk = (id: string, content: string): string =>
  event({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });

/**
 * A whole stream that reports no cost, ending in its finish.
 * @param id - The generation id.
 * @returns The raw stream.
 */
const whole = (id: string): string =>
  chunk(id, "he")
  + event({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  + "data: [DONE]\n\n";

const SSE = "text/event-stream";
const OR_KEYS = { OPENROUTER_API_KEY: "or" };
const KEEPALIVE = ": OPENROUTER PROCESSING\n\n";

/**
 * What an answer was billed as: by the generation it names, unnamed (its cost
 * cannot be looked up by id), or not at all.
 */
type Billed = { id: string } | "unnamed" | null;

/** One scripted answer, how it is billed, and whether it holds the call open until the caller stops. */
interface Scripted {
  reply: Reply;
  billed: Billed;
  holds?: boolean;
}

/**
 * The stream answers an upstream may give its n-th request.
 * @param n - The request's place in the call.
 * @param tracks - Whether the upstream names generations (OpenRouter).
 * @returns The answers by name.
 */
const streamAnswers = (n: number, tracks: boolean): Record<string, Scripted> => {
  const id = `gen-${n}`;
  const named = (billed: Billed): Billed => (tracks ? billed : "unnamed");
  return {
    served: { reply: { status: 200, raw: whole(id), contentType: SSE }, billed: named({ id }) },
    errorFirst: { reply: { status: 200, raw: event({ id, object: "chat.completion.chunk", error: { code: 502, message: "Provider returned error" } }), contentType: SSE }, billed: named({ id }) },
    namedThenError: { reply: { status: 200, raw: chunk(id, "") + event({ id, error: { code: 502, message: "Provider returned error" } }), contentType: SSE }, billed: named({ id }) },
    namedThenCut: { reply: { status: 200, raw: chunk(id, "he"), contentType: SSE, cut: true }, billed: named({ id }) },
    silentThenCut: { reply: { status: 200, raw: KEEPALIVE, contentType: SSE, cut: true }, billed: "unnamed" },
    silentHeld: { reply: { status: 200, raw: KEEPALIVE, contentType: SSE, hold: true }, billed: "unnamed", holds: true },
    namedHeld: { reply: { status: 200, raw: chunk(id, ""), contentType: SSE, hold: true }, billed: named({ id }), holds: true },
    busy: { reply: { status: 503, body: { error: { code: 503, message: "busy" } } }, billed: null },
    limited: { reply: { status: 429, body: { error: { code: 429, message: "slow down" } } }, billed: null },
    refused: { reply: { status: 400, body: { error: { code: 400, message: "bad" } } }, billed: null },
    reset: { reply: "reset", billed: null },
  };
};

/**
 * The whole answers an upstream may give its n-th request.
 * @param n - The request's place in the call.
 * @param tracks - Whether the upstream names generations (OpenRouter).
 * @returns The answers by name.
 */
const wholeAnswers = (n: number, tracks: boolean): Record<string, Scripted> => {
  const id = `gen-${n}`;
  const named = (billed: Billed): Billed => (tracks ? billed : "unnamed");
  return {
    served: { reply: { status: 200, body: { ...CHAT_REPLY, id, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }, billed: named({ id }) },
    servedCosted: { reply: { status: 200, body: { ...CHAT_REPLY, id } }, billed: "unnamed" },
    errorInBody: { reply: { status: 200, body: { id, error: { code: 502, message: "Provider returned error" } } }, billed: named({ id }) },
    cutBody: { reply: { status: 200, raw: `{"id":"${id}","choices":[{"message":{"content":"o`, contentType: "application/json", cut: true }, billed: "unnamed" },
    heldBody: { reply: { status: 200, raw: `{"id":"${id}",   `, contentType: "application/json", hold: true }, billed: "unnamed", holds: true },
    busy: { reply: { status: 503, body: { error: { code: 503, message: "busy" } } }, billed: null },
    limited: { reply: { status: 429, body: { error: { code: 429, message: "slow down" } } }, billed: null },
    refused: { reply: { status: 400, body: { error: { code: 400, message: "bad" } } }, billed: null },
    reset: { reply: "reset", billed: null },
  };
};

const STREAM_NAMES = Object.keys(streamAnswers(0, true));
const WHOLE_NAMES = Object.keys(wholeAnswers(0, true));

/** The two routes a property draws: OpenRouter alone, and a direct vendor with OpenRouter after it. */
const ROUTES = {
  openrouter: { model: "meta/llama-x", keys: { OPENROUTER_API_KEY: "or" } },
  direct: { model: "deepseek/deepseek-v4-pro", keys: { DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" } },
} as const;

/** What the caller ended up holding, split as the billed answers are. */
interface Tally {
  ids: string[];
  unnamed: number;
}

/**
 * Split costs into the generations they look up and the rest.
 * @param costs - The costs the caller holds.
 * @returns The tally.
 */
function tally(costs: readonly Cost[]): Tally {
  const ids: string[] = [];
  let unnamed = 0;
  for (const cost of costs) {
    if (cost.state === "pending") ids.push(String(cost.lookup.generationId));
    else unnamed++;
  }
  return { ids: ids.sort(), unnamed };
}

/**
 * Script both fakes from one sequence: the n-th request either fake receives answers the n-th name.
 * @param script - Answer names in order.
 * @param answers - The answers on offer.
 * @param stop - Stopped once a held answer is written, so the call ends.
 * @returns The answers each request was billed as.
 */
function scriptFakes(script: readonly string[], answers: (n: number, tracks: boolean) => Record<string, Scripted>, stop: AbortController): Billed[] {
  const billed: Billed[] = [];
  let n = 0;
  for (const name of ["openrouter", "deepseek"] as const) {
    fakes[name].answer(({ method }) => {
      if (method !== "POST") return undefined;
      const scripted = answers(n, name === "openrouter")[script[n] ?? "served"]!;
      n++;
      billed.push(scripted.billed);
      if (scripted.holds === true) setTimeout(() => stop.abort(), 150);
      return scripted.reply;
    });
  }
  return billed;
}

/**
 * Split the billed answers as tally splits the costs.
 * @param billed - What each request was billed as.
 * @returns The tally.
 */
function expected(billed: readonly Billed[]): Tally {
  return {
    ids: billed.flatMap((b) => (b !== null && b !== "unnamed" ? [b.id] : [])).sort(),
    unnamed: billed.filter((b) => b === "unnamed").length,
  };
}

describe("prepare: every billed answer reaches the caller once (critical path)", () => {
  it("property, streamed: whatever each upstream answers, and whether the caller stops at the first text", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<keyof typeof ROUTES>("openrouter", "direct"),
        fc.array(fc.constantFrom(...STREAM_NAMES), { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        fc.nat(2),
        async (routeName, script, stopAtText, maxRetries) => {
          const route = ROUTES[routeName];
          const stop = new AbortController();
          const billed = scriptFakes(script, streamAnswers, stop);
          const provider = llmProvider(fakes, route.keys, { llmMaxRetries: maxRetries });
          const prepared = provider.llm.prepare(route.model, { thinking: true, cache: false });
          const ends: Cost[] = [];
          const stream = streamText({
            model: prepared.model,
            prompt: "hi",
            abortSignal: stop.signal,
            ...prepared.options,
            onError: () => undefined,
            onLanguageModelCallEnd: (e) => void ends.push(provider.llm.costOf({ model: route.model, usage: e.usage, providerMetadata: e.providerMetadata })),
          });
          let thrown: unknown;
          try {
            for await (const part of stream.fullStream) {
              if (stopAtText && part.type === "text-delta") stop.abort();
              if (part.type === "error") thrown = part.error;
            }
          } catch (error) {
            thrown = error;
          }
          fakes.openrouter.release();
          fakes.deepseek.release();
          expect(tally([...ends, ...prepared.pendingCosts(), ...costsOf(thrown)])).toEqual(expected(billed));
        },
      ),
      { numRuns: 80 },
    );
  });

  it("property, whole: whatever each upstream answers, however the call ends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<keyof typeof ROUTES>("openrouter", "direct"),
        fc.array(fc.constantFrom(...WHOLE_NAMES), { minLength: 1, maxLength: 5 }),
        fc.nat(2),
        async (routeName, script, maxRetries) => {
          const route = ROUTES[routeName];
          const stop = new AbortController();
          const billed = scriptFakes(script, wholeAnswers, stop);
          const provider = llmProvider(fakes, route.keys, { llmMaxRetries: maxRetries });
          const prepared = provider.llm.prepare(route.model, { thinking: true, cache: false });
          const ends: Cost[] = [];
          let thrown: unknown;
          try {
            const result = await generateText({ model: prepared.model, prompt: "hi", abortSignal: stop.signal, ...prepared.options });
            ends.push(provider.llm.costOf({ model: route.model, usage: result.usage, providerMetadata: result.providerMetadata }));
          } catch (error) {
            thrown = error;
          }
          fakes.openrouter.release();
          fakes.deepseek.release();
          expect(tally([...ends, ...prepared.pendingCosts(), ...costsOf(thrown)])).toEqual(expected(billed));
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("judge: every billed answer reaches the caller once (critical path)", () => {
  /** The decisions endpoint's answers, each with whether it was billed. */
  const JUDGE: Record<string, { reply: Reply; billed: boolean }> = {
    costed: { reply: { status: 200, body: { likely: { p: 0.7 }, usage: { cost: 0.002 } } }, billed: true },
    uncosted: { reply: { status: 200, body: { likely: { p: 0.7 } } }, billed: true },
    notJson: { reply: { status: 200, raw: "<html>", contentType: "text/html" }, billed: true },
    cutBody: { reply: { status: 200, raw: "{\"likely\":", contentType: "application/json", cut: true }, billed: true },
    heldBody: { reply: { status: 200, raw: "{\"likely\":", contentType: "application/json", hold: true }, billed: true },
    refused: { reply: { status: 400, body: { error: { message: "bad question" } } }, billed: false },
    refusedHeld: { reply: { status: 400, raw: "{\"error\":", contentType: "application/json", hold: true }, billed: false },
    busy: { reply: { status: 503, body: { error: "busy" } }, billed: false },
    reset: { reply: "reset", billed: false },
  };

  it("property: whatever the endpoint answers, whether the deadline or the caller ends it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...Object.keys(JUDGE)), fc.constantFrom<"deadline" | "signal">("deadline", "signal"), async (name, ender) => {
        const { reply, billed } = JUDGE[name]!;
        fakes.openrouter.answer(() => reply);
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), 300);
        const outcome = await llmProvider(fakes, OR_KEYS).llm
          .judge({ state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: ender === "deadline" ? 300 : 60_000, ...(ender === "signal" ? { signal: stop.signal } : {}) })
          .catch((e: unknown) => e);
        clearTimeout(timer);
        fakes.openrouter.release();
        const reached = outcome instanceof Error ? costsOf(outcome) : (outcome as { cost?: Cost }).cost === undefined ? [] : [(outcome as { cost: Cost }).cost];
        expect(reached).toHaveLength(billed ? 1 : 0);
      }),
      { numRuns: 40 },
    );
  });
});
