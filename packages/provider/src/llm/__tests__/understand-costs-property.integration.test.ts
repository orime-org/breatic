// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Cost } from "../../cost.js";
import { costsOf } from "../../errors.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { CHAT_REPLY, GENERATE_CONTENT_REPLY, llmProvider, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

// Property (design 13.1, DD 33, critical path): whatever OpenRouter and Google answer, every
// answer an upstream billed reaches the caller exactly once, on the answer or on the error.

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopFakes(fakes);
});

/** One OpenRouter answer, and the entry it is billed as; null when nothing was billed. */
interface Scripted {
  reply: Reply;
  billed: string | null;
}

/**
 * The OpenRouter answers a script draws from, each with the n-th answer's own amount or id.
 * @param n - Its place in the script.
 * @returns The answers by name.
 */
const openRouterAnswers = (n: number): Record<string, Scripted> => {
  const usd = (n + 1) / 1_000;
  const choiceError = (code: number): unknown => ({ ...CHAT_REPLY, usage: { cost: usd }, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code, message: "x" } }] });
  return {
    served: { reply: { status: 200, body: { ...CHAT_REPLY, usage: { cost: usd } } }, billed: `known:${usd}` },
    servedUnpriced: { reply: { status: 200, body: { ...CHAT_REPLY, id: `gen-${n}`, usage: {} } }, billed: `pending:gen-${n}` },
    passingInBody: { reply: { status: 200, body: { id: `gen-${n}`, error: { code: 502, message: "x" }, usage: { cost: usd } } }, billed: `known:${usd}` },
    refusedInChoice: { reply: { status: 200, body: choiceError(400) }, billed: `known:${usd}` },
    unknownInChoice: { reply: { status: 200, body: choiceError(Number.NaN) }, billed: `known:${usd}` },
    notJson: { reply: { status: 200, raw: "<html>", contentType: "text/html" }, billed: "missing" },
    busyBilled: { reply: { status: 503, body: { error: { code: 503, message: "busy" }, usage: { cost: usd } } }, billed: `known:${usd}` },
    busy: { reply: { status: 503, body: { error: { code: 503, message: "busy" } } }, billed: null },
    refused: { reply: { status: 400, body: { error: { code: 400, message: "bad" } } }, billed: null },
    reset: { reply: "reset", billed: null },
  };
};

const NAMES = Object.keys(openRouterAnswers(0));

/**
 * The key one cost is counted under.
 * @param cost - The cost.
 * @returns The key.
 */
function keyOf(cost: Cost): string {
  if (cost.state === "pending") return `pending:${String(cost.lookup.generationId)}`;
  if (cost.state === "missing") return "missing";
  return cost.source === "price_table" ? "google" : `known:${cost.usd}`;
}

describe("understand: every billed answer reaches the caller once (critical path)", () => {
  it("property: whatever each upstream answers, and however the call ends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 6 }),
        fc.constantFrom<"served" | "busy">("served", "busy"),
        fc.nat(2),
        async (script, google, maxRetries) => {
          const billed: string[] = [];
          let n = 0;
          fakes.openrouter.answer(() => {
            const scripted = openRouterAnswers(n)[script[n] ?? "served"]!;
            n++;
            if (scripted.billed !== null) billed.push(scripted.billed);
            return scripted.reply;
          });
          fakes.google.answer(({ path }) => {
            if (!path.includes(":generateContent")) return undefined;
            if (google === "busy") return { status: 503, body: { error: { code: 503, message: "busy", status: "UNAVAILABLE" } } };
            billed.push("google");
            return { status: 200, body: GENERATE_CONTENT_REPLY };
          });
          const outcome = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }, { llmMaxRetries: maxRetries, understandOpenRouterFirst: true }).llm
            .understand({
              model: "google/gemini-3.8-flash",
              question: "What is in it?",
              media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
              maxOutputTokens: 50,
              deadlineAt: Date.now() + 60_000,
            })
            .catch((e: unknown) => e);
          const reached = outcome instanceof Error ? costsOf(outcome) : (outcome as { costs: Cost[] }).costs;
          expect(reached.map(keyOf).sort()).toEqual([...billed].sort());
        },
      ),
      { numRuns: 60 },
    );
  });
});
