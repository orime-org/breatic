// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { NoAnswer } from "../../http/errors.js";
import type { LanguageModelUsage } from "ai";
import type { CapabilityPolicy } from "../api.js";
import { CHAT_REPLY, llmProvider, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

const usage: LanguageModelUsage = {
  inputTokens: 11,
  inputTokenDetails: { noCacheTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  totalTokens: 14,
};

describe("costOf (design 3.6)", () => {
  it("takes the cost OpenRouter reported", () => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "openrouter" }, openrouter: { usage: { cost: 0.000136764 } } },
    });
    expect(cost).toEqual({ state: "known", usd: 0.000136764, source: "reported" });
  });

  it("answers pending with the lookup when OpenRouter did not say", () => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "openrouter", costRef: { upstream: "openrouter", generationId: "gen-9" } } },
    });
    expect(cost).toEqual({ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-9" } });
  });

  it("prices a direct call from the token prices", () => {
    const cost = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "deepseek" } },
    });
    expect(cost).toMatchObject({ state: "known", source: "price_table" });
    expect((cost as { usd: number }).usd).toBeCloseTo((11 * 1.32 + 3 * 3.96) / 1_000_000, 12);
  });

  it("answers missing for a direct call of a model without prices", () => {
    const cost = llmProvider(fakes, { ANTHROPIC_API_KEY: "k" }).llm.costOf({
      model: "anthropic/claude-unpriced",
      usage,
      providerMetadata: { breatic: { upstream: "anthropic" } },
    });
    expect(cost.state).toBe("missing");
  });
});

describe("cost.lookup (design 3.6)", () => {
  it("reads the generation's total cost from OpenRouter", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? { status: 200, body: { data: { id: "gen-9", total_cost: 0.0002 } } } : undefined));
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: false });
    expect(cost).toEqual({ state: "known", usd: 0.0002, source: "billing" });
    expect(fakes.openrouter.seen[0]?.query).toBe("id=gen-9");
  });

  it("stays pending while OpenRouter has not recorded it, and is missing on the last attempt", async () => {
    fakes.openrouter.answer(() => ({ status: 404, body: { error: { message: "not found" } } }));
    const provider = llmProvider(fakes, { OPENROUTER_API_KEY: "or" });
    const lookup = { upstream: "openrouter", generationId: "gen-9" };
    expect((await provider.cost.lookup(lookup, { lastAttempt: false })).state).toBe("pending");
    expect((await provider.cost.lookup(lookup, { lastAttempt: true })).state).toBe("missing");
  });
});

describe("cost.lookup on its last attempt (design 13.1, critical path)", () => {
  it("property: answers known or missing, never pending, whatever OpenRouter says", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(200, 404, 429, 500, 503),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
        async (status, totalCost) => {
          fakes.openrouter.answer(() => ({ status, body: status === 200 ? { data: { id: "g", ...(totalCost === undefined ? {} : { total_cost: totalCost }) } } : {} }));
          const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "g" }, { lastAttempt: true });
          expect(["known", "missing"]).toContain(cost.state);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("understand (design 6.5)", () => {
  const picture = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };

  it("asks OpenRouter first for a Google model, with the media inline and the pinned backend", async () => {
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer).toEqual({ text: "ok", finishReason: "stop", cost: { state: "known", usd: CHAT_REPLY.usage.cost, source: "reported" }, upstream: "openrouter" });
    const [body] = posted(fakes.openrouter);
    expect(body?.provider).toEqual({ only: ["google-vertex"], allow_fallbacks: false });
    expect(JSON.stringify(body)).toContain(`data:image/png;base64,${Buffer.from(picture.bytes).toString("base64")}`);
    expect(posted(fakes.google)).toHaveLength(0);
  });

  it("reads through Google directly when OpenRouter has no key, priced from the token prices", async () => {
    const answer = await llmProvider(fakes, { GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("google");
    expect(answer.cost).toMatchObject({ state: "known", source: "price_table" });
    expect(JSON.stringify(posted(fakes.google)[0])).toContain(Buffer.from(picture.bytes).toString("base64"));
  });

  it("passes the question through the caller's text cleaning", async () => {
    await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { cleanText: (t) => t.replaceAll("HIDDEN", "") }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?HIDDEN",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(JSON.stringify(posted(fakes.openrouter)[0])).not.toContain("HIDDEN");
  });
});

describe("judge (JEV)", () => {
  const request = { state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: 5_000 };

  it("posts to the decisions endpoint beside OpenRouter's API and hands back the body and its cost", async () => {
    const body = { likely: { p: 0.7 }, usage: { cost: 0.002 } };
    fakes.openrouter.answer(({ path }) => (path === "/api/alpha/decisions" ? { status: 200, body } : undefined));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual(body);
    expect(answer.cost).toEqual({ state: "known", usd: 0.002, source: "reported" });
    expect(posted(fakes.openrouter)[0]).toMatchObject({ model: "typesafe/jev-1.13", state: { a: 1 } });
  });

  it("hands a refusal back for the caller to read, sending once", async () => {
    fakes.openrouter.answer(() => ({ status: 503, body: { error: "busy" } }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request);
    expect(answer.status).toBe(503);
    expect(answer.body).toContain("busy");
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("cleans the state and the questions with the caller's text cleaning", async () => {
    fakes.openrouter.answer(() => ({ status: 200, body: {} }));
    await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { cleanText: (t) => t.replaceAll("HIDDEN", "") }).llm.judge({
      ...request,
      state: { note: "fineHIDDEN" },
      questions: { "okHIDDEN": { text: "whyHIDDEN" } },
    });
    expect(JSON.stringify(posted(fakes.openrouter)[0])).not.toContain("HIDDEN");
  });

  it("throws NoAnswer when the connection drops after the request arrived", async () => {
    fakes.openrouter.answer(() => "reset");
    await expect(llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request)).rejects.toBeInstanceOf(NoAnswer);
  });
});

describe("capabilities (design 3.5, U6)", () => {
  const policy: CapabilityPolicy = { override: "auto", timeoutMs: 2_000, ttlMs: 60_000, retryMs: 200 };
  const models = {
    data: [
      { id: "google/gemini-3.8-flash", architecture: { input_modalities: ["text", "image"] } },
      { id: "deepseek/deepseek-v4-pro", architecture: { input_modalities: ["text"] } },
      { id: "odd/model", architecture: { input_modalities: "image" } },
    ],
  };
  const listed = (): number => fakes.openrouter.seen.filter((s) => s.path === "/api/v1/models").length;

  it("reads picture support from OpenRouter's model list and shares one list across models", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/models" ? { status: 200, body: models } : undefined));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    expect(await llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: true });
    expect(await llm.capabilities("deepseek/deepseek-v4-pro", policy)).toEqual({ pictures: false });
    expect(await llm.capabilities("odd/model", policy)).toEqual({ pictures: false });
    expect(listed()).toBe(1);
  });

  it("answers false on a failed list and asks again only after the cooldown", async () => {
    fakes.openrouter.answer(() => ({ status: 500, body: {} }));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    expect(await llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: false });
    expect(await llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: false });
    expect(listed()).toBe(1);
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/models" ? { status: 200, body: models } : undefined));
    await new Promise((done) => setTimeout(done, 250));
    expect(await llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: true });
  });

  it("follows an override without asking", async () => {
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    expect(await llm.capabilities("x/y", { ...policy, override: "yes" })).toEqual({ pictures: true });
    expect(await llm.capabilities("x/y", { ...policy, override: "no" })).toEqual({ pictures: false });
    expect(listed()).toBe(0);
  });

  it("shares one pending list between concurrent askers", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/models" ? { status: 200, body: models } : undefined));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    await Promise.all([llm.capabilities("google/gemini-3.8-flash", policy), llm.capabilities("deepseek/deepseek-v4-pro", policy)]);
    expect(listed()).toBe(1);
  });

  it("gives up on a hung list at the timeout and answers false", async () => {
    fakes.openrouter.answer(() => "hang");
    const started = Date.now();
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.capabilities("google/gemini-3.8-flash", { ...policy, timeoutMs: 300 })).toEqual({ pictures: false });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
