// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { ProviderConfigError } from "../../config/schema.js";
import { NoAnswer } from "../../http/errors.js";
import { NoUpstreamAvailable, UpstreamRequestRejected } from "../../errors.js";
import { generateText, type LanguageModelUsage } from "ai";
import { createProvider } from "../../provider.js";
import type { CapabilityPolicy } from "../api.js";
import { CHAT_REPLY, llmConfig, llmProvider, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

/** The buckets of `usage` below, as domain's bucketsOf splits it. */
const TOKENS = { input: 11, cachedInput: 0, output: 3, reasoning: 0 };

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
    expect(cost).toEqual({ state: "known", usd: 0.000136764, tokens: TOKENS, source: "reported" });
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
    expect(cost).toMatchObject({ state: "known", source: "price_table", tokens: TOKENS });
    expect((cost as { usd: number }).usd).toBeCloseTo((11 * 1.32 + 3 * 3.96) / 1_000_000, 12);
  });

  it("answers missing for a direct call of a model without prices", () => {
    const cost = llmProvider(fakes, { ANTHROPIC_API_KEY: "k" }).llm.costOf({
      model: "anthropic/claude-unpriced",
      usage,
      providerMetadata: { breatic: { upstream: "anthropic" } },
    });
    expect(cost).toMatchObject({ state: "missing", tokens: TOKENS });
  });

  it("splits cached and reasoning tokens into their own buckets", () => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage: { ...usage, inputTokens: 20, inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 8, cacheWriteTokens: 0 }, outputTokens: 9, outputTokenDetails: { textTokens: 4, reasoningTokens: 5 } },
      providerMetadata: { breatic: { upstream: "openrouter" }, openrouter: { usage: { cost: 0.001 } } },
    });
    expect(cost).toEqual({ state: "known", usd: 0.001, tokens: { input: 20, cachedInput: 8, output: 9, reasoning: 5 }, source: "reported" });
  });

  it("answers missing, with the tokens, for an OpenRouter call that reported no cost and no generation", () => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "openrouter" } },
    });
    expect(cost).toMatchObject({ state: "missing", tokens: TOKENS });
  });
});

describe("cost.lookup (design 3.6)", () => {
  it("reads the generation's total cost from OpenRouter", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? { status: 200, body: { data: { id: "gen-9", total_cost: 0.0002 } } } : undefined));
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: false });
    expect(cost).toEqual({ state: "known", usd: 0.0002, source: "billing", tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 } });
    expect(fakes.openrouter.seen[0]?.query).toBe("id=gen-9");
  });

  it("carries the generation's native token counts", async () => {
    const data = { id: "gen-9", total_cost: 0.0002, native_tokens_prompt: 11, native_tokens_cached: 2, native_tokens_completion: 3, native_tokens_reasoning: 1 };
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? { status: 200, body: { data } } : undefined));
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: false });
    expect(cost).toEqual({ state: "known", usd: 0.0002, source: "billing", tokens: { input: 11, cachedInput: 2, output: 3, reasoning: 1 } });
  });

  it.each([
    ["an upstream the configuration does not have", { upstream: "nowhere", generationId: "gen-9" }],
    ["an OpenRouter handle with no generation", { upstream: "openrouter" }],
  ])("answers missing for %s, asking nobody", async (_name, lookup) => {
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup(lookup, { lastAttempt: false });
    expect(cost.state).toBe("missing");
    expect(fakes.openrouter.seen).toHaveLength(0);
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
    expect(answer).toEqual({ text: "ok", finishReason: "stop", cost: { state: "known", usd: CHAT_REPLY.usage.cost, tokens: TOKENS, source: "reported" }, upstream: "openrouter" });
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

  it("answers pending with OpenRouter's generation when the answer carried no cost", async () => {
    const { cost: _cost, ...withoutCost } = CHAT_REPLY.usage;
    fakes.openrouter.answer(() => ({ status: 200, body: { ...CHAT_REPLY, usage: withoutCost } }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.cost).toEqual({ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-test" } });
  });

  it("runs without a deadline when the caller passes an endless one", async () => {
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Number.POSITIVE_INFINITY,
    });
    expect(answer.text).toBe("ok");
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

  it("resends the list request after a passing 503, as a read-only request", async () => {
    let n = 0;
    fakes.openrouter.answer(({ path }) => (path !== "/api/v1/models" ? undefined : ++n === 1 ? { status: 503, body: {} } : { status: 200, body: models }));
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: true });
    expect(listed()).toBe(2);
  });

  it("answers false on a failed list and asks again only after the cooldown", async () => {
    fakes.openrouter.answer(() => ({ status: 400, body: {} }));
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

describe("assertModelsPriced (design 10)", () => {
  it("refuses a model this deployment reaches directly without a token price", () => {
    const llm = llmProvider(fakes, { ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "or" }).llm;
    expect(() => llm.assertModelsPriced(["anthropic/claude-unpriced", "deepseek/deepseek-v4-pro"])).toThrow(ProviderConfigError);
    try {
      llm.assertModelsPriced(["anthropic/claude-unpriced"]);
    } catch (error) {
      expect((error as ProviderConfigError).problems).toEqual([expect.stringContaining("anthropic/claude-unpriced")]);
    }
  });

  it("accepts it when the direct upstream has no key and the call goes through OpenRouter", () => {
    expect(() => llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.assertModelsPriced(["anthropic/claude-unpriced"])).not.toThrow();
  });

  it("counts the upstreams that read media", () => {
    const llm = llmProvider(fakes, { GOOGLE_API_KEY: "g", OPENROUTER_API_KEY: "or" }).llm;
    expect(() => llm.assertModelsPriced(["google/gemini-unpriced"])).toThrow(ProviderConfigError);
  });
});

describe("a refused understand call (design 3.5, 5.4)", () => {
  const picture = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };
  /**
   * Ask through the harness and catch what it throws.
   * @param keys - The environment keys.
   * @returns The thrown error.
   */
  const refused = (keys: Record<string, string>): Promise<unknown> =>
    llmProvider(fakes, keys).llm.understand({ model: "google/gemini-3.8-flash", question: "What?", media: [picture], maxOutputTokens: 50, deadlineAt: Date.now() + 60_000 }).then(
      () => undefined,
      (e: unknown) => e,
    );

  it.each([
    ["the cost it reported", { id: "gen-123", error: { message: "The model declined", code: 200 }, usage: { cost: 0.0123 } }, { state: "known", usd: 0.0123, source: "reported" }],
    ["a lookup by its generation", { id: "gen-123", error: { message: "The model declined", code: 200 } }, { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-123" } }],
    ["a missing cost when the answer says neither", { error: { message: "The model declined", code: 200 } }, { state: "missing" }],
  ])("throws UpstreamRequestRejected naming OpenRouter, carrying %s, for a 200 that refuses", async (_name, body, cost) => {
    fakes.openrouter.answer(() => ({ status: 200, body }));
    const error = await refused({ OPENROUTER_API_KEY: "or" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("openrouter");
    expect((error as UpstreamRequestRejected & { cost?: unknown }).cost).toMatchObject(cost);
  });

  it("carries no cost for a refusal whose body is not JSON", async () => {
    fakes.google.answer(() => ({ status: 400, raw: "<html>bad request</html>", contentType: "text/html" }));
    const error = await refused({ GOOGLE_API_KEY: "g" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected & { cost?: unknown }).cost).toBeUndefined();
  });

  it("carries no cost for a refusal status whose body names none, and names the upstream that refused", async () => {
    fakes.google.answer(() => ({ status: 400, body: { error: { code: 400, message: "bad image", status: "INVALID_ARGUMENT" } } }));
    const error = await refused({ GOOGLE_API_KEY: "g" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect((error as UpstreamRequestRejected & { cost?: unknown }).cost).toBeUndefined();
  });
});

describe("cheapest mode for LLM calls (design 5.1)", () => {
  it("serves a priced direct upstream before OpenRouter, whatever their weights", async () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "deepseek/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "deepseek", weight: 1 }] }, ...config.llm!.routes.filter((r) => r.prefix !== "deepseek/")];
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("deepseek");
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("keeps the weight order for a model without a direct price", async () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "deepseek/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "deepseek", weight: 1 }] }, ...config.llm!.routes.filter((r) => r.prefix !== "deepseek/")];
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/unpriced", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
  });
});

describe("judge routing (JEV)", () => {
  const request = { state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: 5_000 };

  it("refuses an upstream that is not OpenRouter's kind", async () => {
    await expect(llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request, { mode: "upstream", upstream: "deepseek" })).rejects.toBeInstanceOf(UpstreamRequestRejected);
  });

  it("answers NoUpstreamAvailable naming the key when OpenRouter has none", async () => {
    const error = await llmProvider(fakes, {}).llm.judge(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).reasons).toEqual([{ upstream: "openrouter", kind: "missing_key", envVar: "OPENROUTER_API_KEY" }]);
  });

  it("answers a missing cost for a body that is not JSON", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: "not json", contentType: "text/plain" }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request);
    expect(answer.cost.state).toBe("missing");
  });
});

describe("capabilities with a stop signal (design 3.5, U6)", () => {
  it("lets a caller leave a pending refresh when its signal ends, without cancelling it for others", async () => {
    const policy: CapabilityPolicy = { override: "auto", timeoutMs: 2_000, ttlMs: 60_000, retryMs: 200 };
    fakes.openrouter.answer(() => "hang");
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    const stop = new AbortController();
    const leaving = llm.capabilities("google/gemini-3.8-flash", policy, stop.signal).catch((e: unknown) => e);
    const staying = llm.capabilities("google/gemini-3.8-flash", policy);
    stop.abort(new Error("turn ended"));
    expect(await leaving).toBeInstanceOf(Error);
    expect(await staying).toEqual({ pictures: false });
  });
});
