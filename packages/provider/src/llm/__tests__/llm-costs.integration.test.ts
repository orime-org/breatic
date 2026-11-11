// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import fc from "fast-check";
import { ProviderConfigError } from "../../config/schema.js";
import { NoAnswer } from "../../http/errors.js";
import { SIDE_REQUEST_MS } from "../../http/request.js";
import { costsOf, NoUpstreamAvailable, UpstreamRequestRejected } from "../../errors.js";
import { generateText, streamText, type FinishReason, type LanguageModelUsage } from "ai";
import { createProvider } from "../../provider.js";
import type { CapabilityPolicy, UnderstandAnswer } from "../api.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { yaml } from "../../config/__tests__/shipped.js";
import { CHAT_REPLY, GENERATE_CONTENT_REPLY, llmConfig, llmProvider, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

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

describe("costOf", () => {
  it("takes the cost OpenRouter reported", () => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "openrouter" }, openrouter: { usage: { cost: 0.000136764 } } },
    });
    expect(cost).toEqual({ state: "known", usd: 0.000136764, tokens: TOKENS, source: "reported" });
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, "0.5"])("reads a reported cost of %s as no cost, never a known one", (reported) => {
    const cost = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "openrouter" }, openrouter: { usage: { cost: reported as number } } },
    });
    expect(cost.state).not.toBe("known");
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
      providerMetadata: { breatic: { upstream: "deepseek", sentAt: Date.now() } },
    });
    expect(cost).toMatchObject({ state: "known", source: "price_table", tokens: TOKENS });
    expect((cost as { usd: number }).usd).toBeCloseTo((11 * 1.32 + 3 * 3.96) / 1_000_000, 12);
  });

  it("answers missing for a direct call whose finish names no send time", () => {
    const cost = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage,
      providerMetadata: { breatic: { upstream: "deepseek" } },
    });
    expect(cost).toEqual({ state: "missing", reason: expect.stringContaining("names no send time"), tokens: TOKENS });
  });

  it("answers missing for a direct call of a model without prices", () => {
    const cost = llmProvider(fakes, { ANTHROPIC_API_KEY: "k" }).llm.costOf({
      model: "anthropic/claude-unpriced",
      usage,
      providerMetadata: { breatic: { upstream: "anthropic", sentAt: Date.now() } },
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

describe("a direct finish that reports no token usage (critical path)", () => {
  const { usage: _usage, ...WHOLE_WITHOUT_USAGE } = CHAT_REPLY;
  /** A streamed DeepSeek answer that closes after its finish_reason chunk, before the usage chunk. */
  const STREAMED_WITHOUT_USAGE = [
    { id: "ds-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "a long answer" }, finish_reason: null }] },
    { id: "ds-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

  it.each(["whole", "streamed"] as const)("books a %s DeepSeek call whose answer carries no usage as missing, never a known 0", async (shape) => {
    fakes.deepseek.answer(() => (shape === "whole" ? { status: 200, body: WHOLE_WITHOUT_USAGE } : { status: 200, raw: STREAMED_WITHOUT_USAGE, contentType: "text/event-stream" }));
    const provider = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }, { llmMaxRetries: 0 });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false });
    let finished: { usage: LanguageModelUsage; providerMetadata: Parameters<typeof provider.llm.costOf>[0]["providerMetadata"] };
    if (shape === "whole") {
      finished = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    } else {
      const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
      await stream.consumeStream();
      finished = { usage: await stream.usage, providerMetadata: await stream.providerMetadata };
    }
    const cost = provider.llm.costOf({ model: "deepseek/deepseek-v4-pro", usage: finished.usage, providerMetadata: finished.providerMetadata });
    expect(cost).toEqual({
      state: "missing",
      reason: "deepseek reported no token usage for deepseek/deepseek-v4-pro",
      tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    });
  });

  it("prices a direct finish that reports input tokens only, as Gemini answers a blocked prompt", () => {
    const cost = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }).llm.costOf({
      model: "deepseek/deepseek-v4-pro",
      usage: { inputTokens: 11, inputTokenDetails: { noCacheTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokens: undefined, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: 11 },
      providerMetadata: { breatic: { upstream: "deepseek", sentAt: Date.now() } },
    });
    expect(cost).toEqual({ state: "known", usd: (11 * 1.32) / 1_000_000, tokens: { input: 11, cachedInput: 0, output: 0, reasoning: 0 }, source: "price_table" });
  });
});

describe("costOf by the price table, to the cent (critical path)", () => {
  /**
   * The cost of one direct Anthropic call with cache reads and writes, at these prices per million tokens:
   * miss 3, hit 0.3, a 5-minute write 3.75, a one-hour write 6, output 15.
   * @param cacheTtl - The cache the call asked for.
   * @returns The cost.
   */
  const priced = (cacheTtl: "5m" | "1h"): unknown => {
    const config = llmConfig(fakes);
    config.llm!.prices!["anthropic/claude-priced"] = [{
      input_cache_miss_per_mtok: 3,
      input_cache_hit_per_mtok: 0.3,
      input_cache_write_5m_per_mtok: 3.75,
      input_cache_write_1h_per_mtok: 6,
      output_per_mtok: 15,
    }];
    const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    return provider.llm.costOf({
      model: "anthropic/claude-priced",
      usage: {
        inputTokens: 100,
        inputTokenDetails: { noCacheTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 30 },
        outputTokens: 10,
        outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
        totalTokens: 110,
      },
      providerMetadata: { breatic: { upstream: "anthropic", cacheTtl, sentAt: Date.now() } },
    });
  };

  it("charges the uncached input at the miss price, the cache read at the hit price and the write at the 5-minute price", () => {
    expect((priced("5m") as { usd: number }).usd).toBeCloseTo((50 * 3 + 20 * 0.3 + 30 * 3.75 + 10 * 15) / 1_000_000, 12);
  });

  it("charges the write at the one-hour price for a one-hour cache", () => {
    expect((priced("1h") as { usd: number }).usd).toBeCloseTo((50 * 3 + 20 * 0.3 + 30 * 6 + 10 * 15) / 1_000_000, 12);
  });
});

describe("a direct price that changes on a stated date (critical path)", () => {
  const CHANGES_AT = Date.parse("2027-01-01T00:00:00Z");

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The shipped LLM config with Google's Gemini 3.8 Flash price, which doubles on 2027-01-01.
   * @returns The raw configuration.
   */
  const dated = (): ReturnType<typeof llmConfig> => {
    const config = llmConfig(fakes);
    config.llm!.prices!["google/gemini-3.8-flash"] = [
      { input_cache_hit_per_mtok: 0.075, input_cache_miss_per_mtok: 0.75, output_per_mtok: 3.75 },
      { from: "2027-01-01T00:00:00Z", input_cache_hit_per_mtok: 0.15, input_cache_miss_per_mtok: 1.5, output_per_mtok: 7.5 },
    ];
    return config;
  };

  it.each([
    [CHANGES_AT - 1, (11 * 0.75 + 3 * 3.75) / 1_000_000],
    [CHANGES_AT, (11 * 1.5 + 3 * 7.5) / 1_000_000],
  ])("books a direct Gemini call sent at %i at the price in effect then", (at, usd) => {
    const provider = createProvider({ config: dated(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const cost = provider.llm.costOf({ model: "google/gemini-3.8-flash", usage, providerMetadata: { breatic: { upstream: "google", sentAt: at } } });
    expect(cost).toMatchObject({ state: "known", source: "price_table" });
    expect((cost as { usd: number }).usd).toBeCloseTo(usd, 12);
  });

  it.each([
    ["before the change", CHANGES_AT - 1, undefined, "google"],
    ["at the change, OpenRouter's prices read when it took effect", CHANGES_AT, "2027-01-01T00:00:00Z", "openrouter"],
    ["at the change, OpenRouter's prices read before it took effect, so unknown", CHANGES_AT, "2026-12-31T23:59:59Z", "google"],
    ["at the change, OpenRouter's prices read at an unstated moment, so unknown", CHANGES_AT, undefined, "google"],
  ])("ranks a cheapest call %s by the direct price in effect then", async (_name, at, readAt, first) => {
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    const config = dated();
    config.llm!.openrouter_prices = { "google/gemini-3.8-flash": { input_cache_miss_per_mtok: 1, output_per_mtok: 5 } };
    if (readAt !== undefined) config.llm!.openrouter_prices_at = readAt;
    const provider = createProvider({ config, keyOf: (name) => ({ GOOGLE_API_KEY: "g", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("google/gemini-3.8-flash", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe(first);
  });

  it.each(["2026-12-31T12:00:00Z", "2027-01-01T12:00:00Z"])("ranks a cheapest Gemini 3.8 Flash call planned at %s with the shipped prices google first", async (at) => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(at) });
    const shipped = yaml<NonNullable<ReturnType<typeof llmConfig>["llm"]>>("provider/llm.yaml");
    const config = llmConfig(fakes);
    config.llm!.prices = shipped.prices;
    config.llm!.openrouter_prices = shipped.openrouter_prices;
    config.llm!.openrouter_prices_at = shipped.openrouter_prices_at;
    const provider = createProvider({ config, keyOf: (name) => ({ GOOGLE_API_KEY: "g", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("google/gemini-3.8-flash", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("google");
  });

  it("books an understand call sent before the change and answered after it at the price in effect when it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: CHANGES_AT - 1 });
    fakes.google.answer(() => {
      vi.setSystemTime(CHANGES_AT + 60_000);
      return { status: 200, body: GENERATE_CONTENT_REPLY };
    });
    const provider = createProvider({ config: dated(), keyOf: (name) => ({ GOOGLE_API_KEY: "g" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const answer = await provider.llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
      maxOutputTokens: 200,
      deadlineAt: CHANGES_AT + 3_600_000,
    });
    expect(Date.now()).toBe(CHANGES_AT + 60_000);
    expect(answer.costs).toEqual([{ state: "known", usd: (11 * 0.75 + 3 * 3.75) / 1_000_000, tokens: TOKENS, source: "price_table" }]);
  });
  it("books an understand call whose upload and wait for the file span the change at the price in effect when the model request was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: CHANGES_AT - 60_000 });
    const config = dated();
    config.upstreams.google = { ...config.upstreams.google!, base_url: `${fakes.google.url}/v1beta` };
    config.llm!.gemini_inline_max_bytes = 8;
    config.llm!.gemini_file_poll_ms = 20;
    let generateSentAt = 0;
    fakes.google.answer(({ method, path }) => {
      if (path === "/upload/v1beta/files") return { status: 200, body: {}, headers: { "x-goog-upload-url": `${fakes.google.url}/upload-session/1` } };
      if (path === "/upload-session/1") return { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } };
      if (method === "GET") {
        // Google finishes processing the file after the price changed.
        vi.setSystemTime(CHANGES_AT + 30_000);
        return { status: 200, body: { name: "files/abc", uri: "https://files.example/abc", state: "ACTIVE" } };
      }
      if (method === "DELETE") return { status: 200, body: {} };
      generateSentAt = Date.now();
      return { status: 200, body: GENERATE_CONTENT_REPLY };
    });
    const provider = createProvider({ config, keyOf: (name) => ({ GOOGLE_API_KEY: "g" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const answer = await provider.llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array(32), contentType: "image/png" }],
      maxOutputTokens: 200,
      deadlineAt: CHANGES_AT + 3_600_000,
    });
    expect(generateSentAt).toBe(CHANGES_AT + 30_000);
    expect(answer.costs).toEqual([{ state: "known", usd: (11 * 1.5 + 3 * 7.5) / 1_000_000, tokens: TOKENS, source: "price_table" }]);
  });
});

describe("DeepSeek's off-peak price, half the peak outside 01:00-04:00 and 06:00-10:00 UTC on weekdays (critical path)", () => {
  /** The direct and OpenRouter prices llm.yaml ships. */
  const SHIPPED = yaml<{ prices: NonNullable<NonNullable<ReturnType<typeof llmConfig>["llm"]>["prices"]>; openrouter_prices: Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }> }>("provider/llm.yaml");
  /** Each model's peak price per million tokens: cache miss and output, as DeepSeek's pricing page states them. */
  const PEAK: Readonly<Record<string, readonly [number, number]>> = { "deepseek/deepseek-v4-pro": [1.32, 3.96], "deepseek/deepseek-v4.1-flash-1017": [0.3, 1.2] };
  /** Monday 2026-11-09, 00:00 UTC. */
  const MONDAY = Date.parse("2026-11-09T00:00:00Z");
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The harness config with the shipped direct and OpenRouter prices.
   * @returns The raw configuration.
   */
  const shippedPrices = (): ReturnType<typeof llmConfig> => {
    const config = llmConfig(fakes);
    config.llm!.prices = SHIPPED.prices;
    config.llm!.openrouter_prices = SHIPPED.openrouter_prices;
    return config;
  };

  const moments: [string, number, boolean][] = [
    ["Monday 00:59", MONDAY + 59 * MINUTE, false],
    ["Monday 01:00", MONDAY + HOUR, true],
    ["Monday 03:59", MONDAY + 3 * HOUR + 59 * MINUTE, true],
    ["Monday 04:00", MONDAY + 4 * HOUR, false],
    ["Monday 05:59", MONDAY + 5 * HOUR + 59 * MINUTE, false],
    ["Monday 06:00", MONDAY + 6 * HOUR, true],
    ["Monday 09:59", MONDAY + 9 * HOUR + 59 * MINUTE, true],
    ["Monday 10:00", MONDAY + 10 * HOUR, false],
    ["Saturday 12:00", Date.parse("2026-11-14T12:00:00Z"), false],
    ["Saturday 02:00, inside a weekday window's hours", Date.parse("2026-11-14T02:00:00Z"), false],
    ["Sunday 07:00, inside a weekday window's hours", Date.parse("2026-11-15T07:00:00Z"), false],
    ["2027-01-01 02:00, a Friday and a Chinese public holiday", Date.parse("2027-01-01T02:00:00Z"), false],
  ];

  it.each(Object.keys(PEAK).flatMap((model) => moments.map(([name, at, peak]) => [model, name, at, peak] as const)))("books %s sent %s at its price then", (model, _name, at, peak) => {
    const provider = createProvider({ config: shippedPrices(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const [miss, output] = PEAK[model]!;
    const factor = peak ? 1 : 0.5;
    const cost = provider.llm.costOf({ model, usage, providerMetadata: { breatic: { upstream: "deepseek", sentAt: at } } });
    expect(cost).toEqual({ state: "known", usd: (11 * (miss * factor) + 3 * (output * factor)) / 1_000_000, tokens: TOKENS, source: "price_table" });
  });

  /** Each model's cache-hit price at peak, per million tokens, as DeepSeek's pricing page states it. */
  const PEAK_HIT: Readonly<Record<string, number>> = { "deepseek/deepseek-v4-pro": 0.044, "deepseek/deepseek-v4.1-flash-1017": 0.006 };
  /** Saturday 2026-11-14 02:00 UTC: inside a weekday window's hours, off-peak since it is a weekend. */
  const SATURDAY_TWO = Date.parse("2026-11-14T02:00:00Z");

  it.each(Object.keys(PEAK))("books an off-peak %s call's cache reads at half the cache-hit price", (model) => {
    const provider = createProvider({ config: shippedPrices(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const [miss, output] = PEAK[model]!;
    const cached: LanguageModelUsage = { ...usage, inputTokens: 20, inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 8, cacheWriteTokens: 0 } };
    const cost = provider.llm.costOf({ model, usage: cached, providerMetadata: { breatic: { upstream: "deepseek", sentAt: SATURDAY_TWO } } });
    expect(cost).toEqual({
      state: "known",
      usd: (12 * (miss * 0.5) + 8 * (PEAK_HIT[model]! * 0.5) + 3 * (output * 0.5)) / 1_000_000,
      tokens: { input: 20, cachedInput: 8, output: 3, reasoning: 0 },
      source: "price_table",
    });
  });

  it.each(["5m", "1h"] as const)("books an off-peak call's %s cache writes at the off-peak write price", (cacheTtl) => {
    const config = llmConfig(fakes);
    config.llm!.prices!["anthropic/claude-priced"] = [{
      input_cache_miss_per_mtok: 3,
      input_cache_hit_per_mtok: 0.3,
      input_cache_write_5m_per_mtok: 3.75,
      input_cache_write_1h_per_mtok: 6,
      output_per_mtok: 15,
      off_peak: { factor: 0.5, peak_utc: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }] },
    }];
    const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const cost = provider.llm.costOf({
      model: "anthropic/claude-priced",
      usage: {
        inputTokens: 100,
        inputTokenDetails: { noCacheTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 30 },
        outputTokens: 10,
        outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
        totalTokens: 110,
      },
      providerMetadata: { breatic: { upstream: "anthropic", cacheTtl, sentAt: SATURDAY_TWO } },
    });
    const write = cacheTtl === "1h" ? 6 : 3.75;
    expect(cost).toMatchObject({ state: "known", usd: (50 * (3 * 0.5) + 20 * (0.3 * 0.5) + 30 * (write * 0.5) + 10 * (15 * 0.5)) / 1_000_000 });
  });

  it.each([
    ["before the dated price, which alone has an off-peak", Date.parse("2026-11-14T02:00:00Z"), 1],
    ["after the dated price, at its own off-peak factor", Date.parse("2027-01-02T02:00:00Z"), 0.25],
  ])("books a Saturday 02:00 call %s", (_name, at, factor) => {
    const config = llmConfig(fakes);
    config.llm!.prices!["deepseek/deepseek-v4-pro"] = [
      { input_cache_miss_per_mtok: 1.32, output_per_mtok: 3.96 },
      { from: "2027-01-01T00:00:00Z", input_cache_miss_per_mtok: 1.32, output_per_mtok: 3.96, off_peak: { factor: 0.25, peak_utc: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }] } },
    ];
    const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const cost = provider.llm.costOf({ model: "deepseek/deepseek-v4-pro", usage, providerMetadata: { breatic: { upstream: "deepseek", sentAt: at } } });
    expect(cost).toEqual({ state: "known", usd: (11 * (1.32 * factor) + 3 * (3.96 * factor)) / 1_000_000, tokens: TOKENS, source: "price_table" });
  });

  it("books a call sent in peak hours and finished off-peak at the peak price", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: MONDAY + 4 * HOUR + MINUTE });
    const provider = createProvider({ config: shippedPrices(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
    const cost = provider.llm.costOf({ model: "deepseek/deepseek-v4-pro", usage, providerMetadata: { breatic: { upstream: "deepseek", sentAt: MONDAY + 3 * HOUR + 59 * MINUTE } } });
    expect(cost).toEqual({ state: "known", usd: (11 * 1.32 + 3 * 3.96) / 1_000_000, tokens: TOKENS, source: "price_table" });
  });

  it.each([
    ["Monday 02:00", MONDAY + 2 * HOUR, "openrouter"],
    ["Saturday 12:00", Date.parse("2026-11-14T12:00:00Z"), "deepseek"],
  ])("ranks a cheapest deepseek/deepseek-v4-pro call planned %s with the shipped direct prices", async (_name, at, first) => {
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    const config = shippedPrices();
    // An OpenRouter price between the off-peak and the peak direct price, so the ranking turns on the hour alone.
    config.llm!.openrouter_prices = { ...config.llm!.openrouter_prices, "deepseek/deepseek-v4-pro": { input_cache_miss_per_mtok: 0.788916, output_per_mtok: 1.577832 } };
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe(first);
  });

  /** A streamed DeepSeek answer: one text chunk, then the finish with the usage `usage` holds. */
  const STREAMED = [
    { id: "ds-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: "ds-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

  /**
   * Run one prepared call, whole or streamed, and book its finish.
   * @param provider - The provider.
   * @param shape - Whole or streamed.
   * @returns The finish's cost and its breatic metadata.
   */
  const bookedCall = async (provider: ReturnType<typeof createProvider>, shape: "whole" | "streamed"): Promise<{ cost: unknown; breatic: unknown }> => {
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false });
    let finished: { usage: LanguageModelUsage; providerMetadata: Parameters<typeof provider.llm.costOf>[0]["providerMetadata"] };
    if (shape === "whole") {
      finished = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    } else {
      const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
      await stream.consumeStream();
      finished = { usage: await stream.usage, providerMetadata: await stream.providerMetadata };
    }
    const cost = provider.llm.costOf({ model: "deepseek/deepseek-v4-pro", usage: finished.usage, providerMetadata: finished.providerMetadata });
    return { cost, breatic: finished.providerMetadata?.breatic };
  };

  it.each(["whole", "streamed"] as const)("books a %s call whose 429 was retried across 01:00 at the peak price, the moment the retry that served it was sent", async (shape) => {
    vi.useFakeTimers({ toFake: ["Date"], now: MONDAY + 59 * MINUTE + 50_000 });
    let n = 0;
    fakes.deepseek.answer(() => {
      if (++n === 1) {
        // The Retry-After wait carries the retry past 01:00.
        vi.setSystemTime(MONDAY + HOUR + 10_000);
        return { status: 429, body: {}, headers: { "retry-after-ms": "10" } };
      }
      return shape === "whole" ? { status: 200, body: CHAT_REPLY } : { status: 200, raw: STREAMED, contentType: "text/event-stream" };
    });
    const provider = createProvider({ config: shippedPrices(), keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds" })[name], llmMaxRetries: 1, cleanText: (t) => t });
    const { cost, breatic } = await bookedCall(provider, shape);
    expect(n).toBe(2);
    expect(breatic).toMatchObject({ upstream: "deepseek", sentAt: MONDAY + HOUR + 10_000 });
    expect(cost).toMatchObject({ state: "known", usd: (11 * 1.32 + 3 * 3.96) / 1_000_000, source: "price_table" });
  });

  it.each(["whole", "streamed"] as const)("books a %s call that switched upstream across 01:00 at the moment the second upstream was sent it", async (shape) => {
    vi.useFakeTimers({ toFake: ["Date"], now: MONDAY + 59 * MINUTE + 50_000 });
    const config = shippedPrices();
    config.upstreams.backup = { kind: "deepseek", base_url: fakes.openai.url, key_env: "DEEPSEEK_API_KEY" };
    config.llm!.routes = config.llm!.routes.map((r) => (r.prefix === "deepseek/" ? { ...r, upstreams: [{ upstream: "deepseek", weight: 0 }, { upstream: "backup", weight: 1 }] } : r));
    fakes.deepseek.answer(() => {
      vi.setSystemTime(MONDAY + HOUR + 10_000);
      return { status: 503, body: {} };
    });
    fakes.openai.answer(() => (shape === "whole" ? { status: 200, body: CHAT_REPLY } : { status: 200, raw: STREAMED, contentType: "text/event-stream" }));
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const { cost, breatic } = await bookedCall(provider, shape);
    expect(breatic).toMatchObject({ upstream: "backup", sentAt: MONDAY + HOUR + 10_000 });
    expect(cost).toMatchObject({ state: "known", usd: (11 * 1.32 + 3 * 3.96) / 1_000_000, source: "price_table" });
  });

  it.each(["whole", "streamed"] as const)("books a %s call sent at 03:59 and answered at 04:01 at the peak price, the moment the try that served it was sent", async (shape) => {
    const sent = MONDAY + 3 * HOUR + 59 * MINUTE;
    vi.useFakeTimers({ toFake: ["Date"], now: sent });
    fakes.deepseek.answer(() => {
      // The upstream answers after the peak window closed.
      vi.setSystemTime(MONDAY + 4 * HOUR + MINUTE);
      return shape === "whole" ? { status: 200, body: CHAT_REPLY } : { status: 200, raw: STREAMED, contentType: "text/event-stream" };
    });
    const provider = createProvider({ config: shippedPrices(), keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const { cost, breatic } = await bookedCall(provider, shape);
    expect(Date.now()).toBe(MONDAY + 4 * HOUR + MINUTE);
    expect(breatic).toMatchObject({ upstream: "deepseek", sentAt: sent });
    expect(cost).toEqual({ state: "known", usd: (11 * 1.32 + 3 * 3.96) / 1_000_000, tokens: TOKENS, source: "price_table" });
  });
});

describe("cost.lookup of answers it cannot read", () => {
  const lookup = { upstream: "openrouter", generationId: "gen-9" };
  const raw = (body: string): Reply => ({ status: 200, raw: body, contentType: "application/json" });

  it("reads a cost of 1e999 as no cost yet, never a known Infinity", async () => {
    fakes.openrouter.answer(() => raw('{"data":{"total_cost":1e999,"native_tokens_prompt":5}}'));
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup(lookup, { lastAttempt: false })).toEqual({ state: "pending", lookup });
  });

  it("reads a token count of 1e999 as 0", async () => {
    fakes.openrouter.answer(() => raw('{"data":{"total_cost":0.5,"native_tokens_prompt":1e999,"native_tokens_completion":3}}'));
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup(lookup, { lastAttempt: false })).toEqual({
      state: "known",
      usd: 0.5,
      tokens: { input: 0, cachedInput: 0, output: 3, reasoning: 0 },
      source: "billing",
    });
  });

  it("answers missing on the last attempt for an answer whose data is not an object", async () => {
    fakes.openrouter.answer(() => raw('{"data":"gen-9"}'));
    expect((await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup(lookup, { lastAttempt: true })).state).toBe("missing");
  });
});

describe("cost.lookup", () => {
  it("reads the generation's total cost from OpenRouter", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? { status: 200, body: { data: { id: "gen-9", total_cost: 0.0002 } } } : undefined));
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: false });
    expect(cost).toEqual({ state: "known", usd: 0.0002, source: "billing", tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 } });
    expect(fakes.openrouter.seen[0]?.query).toBe("id=gen-9");
    expect(fakes.openrouter.seen[0]?.authorization).toBe("Bearer or");
  });

  it("asks OpenRouter again within one lookup when it answers 503", async () => {
    let asks = 0;
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? (++asks === 1 ? { status: 503, body: {} } : { status: 200, body: { data: { id: "gen-9", total_cost: 0.0002 } } }) : undefined));
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: false });
    expect(cost.state).toBe("known");
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

  it("answers missing at once for a direct upstream, which keeps no generations, and for a lookup with no generation", async () => {
    const provider = llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" });
    expect(await provider.cost.lookup({ upstream: "google", generationId: "gen-9" }, { lastAttempt: false })).toEqual({ state: "missing", reason: "the lookup names nothing to ask" });
    expect(await provider.cost.lookup({ upstream: "openrouter" }, { lastAttempt: false })).toEqual({ state: "missing", reason: "the lookup names nothing to ask" });
    expect(fakes.openrouter.seen).toHaveLength(0);
    expect(fakes.google.seen).toHaveLength(0);
  });

  it("stays pending while OpenRouter has not recorded it, and is missing on the last attempt", async () => {
    fakes.openrouter.answer(() => ({ status: 404, body: { error: { message: "not found" } } }));
    const provider = llmProvider(fakes, { OPENROUTER_API_KEY: "or" });
    const lookup = { upstream: "openrouter", generationId: "gen-9" };
    expect((await provider.cost.lookup(lookup, { lastAttempt: false })).state).toBe("pending");
    expect((await provider.cost.lookup(lookup, { lastAttempt: true })).state).toBe("missing");
  });

  it("answers missing with the token counts when the generation on the last attempt carries tokens but no cost", async () => {
    const data = { id: "gen-9", native_tokens_prompt: 11, native_tokens_cached: 2, native_tokens_completion: 3, native_tokens_reasoning: 1 };
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/generation" ? { status: 200, body: { data } } : undefined));
    const provider = llmProvider(fakes, { OPENROUTER_API_KEY: "or" });
    const lookup = { upstream: "openrouter", generationId: "gen-9" };
    expect(await provider.cost.lookup(lookup, { lastAttempt: false })).toEqual({ state: "pending", lookup });
    expect(await provider.cost.lookup(lookup, { lastAttempt: true })).toEqual({
      state: "missing",
      reason: expect.any(String),
      tokens: { input: 11, cachedInput: 2, output: 3, reasoning: 1 },
    });
  });
});

describe("cost.fromGeneration: a lookup queued before it named its upstream", () => {
  it("names the upstream that keeps generations to look a cost up by", () => {
    expect(llmProvider(fakes, {}).cost.fromGeneration("gen-9")).toEqual({ upstream: "openrouter", generationId: "gen-9" });
  });

  it("names none when no upstream keeps generations", () => {
    const config = llmConfig(fakes);
    delete config.upstreams.openrouter;
    config.llm!.routes = [{ prefix: "", upstreams: [{ upstream: "google", weight: 0 }] }];
    config.llm!.understand_routes = [{ prefix: "", upstreams: [{ upstream: "google", weight: 0 }] }];
    delete config.llm!.openrouter_backends;
    const provider = createProvider({ config, keyOf: () => undefined, llmMaxRetries: 0, cleanText: (t) => t });
    expect(provider.cost.fromGeneration("gen-9")).toBeUndefined();
  });
});

describe("cost.lookup is a side request", () => {
  it("ends within the side-request limit while OpenRouter never answers, missing on the last attempt", async () => {
    fakes.openrouter.answer(() => "hang");
    const started = Date.now();
    const cost = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).cost.lookup({ upstream: "openrouter", generationId: "gen-9" }, { lastAttempt: true });
    expect(Date.now() - started).toBeLessThan(SIDE_REQUEST_MS + 5_000);
    expect(cost.state).toBe("missing");
  }, 60_000);
});

describe("cost.lookup on its last attempt (critical path)", () => {
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

describe("understand", () => {
  it("answers its finish reason in AI SDK's unified words, the same for every upstream", () => {
    expectTypeOf<UnderstandAnswer["finishReason"]>().toEqualTypeOf<FinishReason>();
  });

  const picture = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };

  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

  it("asks Google first, through its own generateContent, with each item inline", async () => {
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("google");
    expect(answer.costs).toEqual([expect.objectContaining({ state: "known", source: "price_table" })]);
    const call = fakes.google.seen.find((r) => r.method === "POST");
    expect(call?.path.endsWith("/models/gemini-3.8-flash:generateContent")).toBe(true);
    const parts = (call?.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts).toContainEqual({ text: "What is in it?" });
    expect(parts).toContainEqual({ inlineData: { mimeType: "image/png", data: b64(picture.bytes) } });
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it.each([
    ["content-filter when Google blocked the prompt", { promptFeedback: { blockReason: "SAFETY" } }, "content-filter"],
    ["other when Google gave no candidate and no block reason", {}, "other"],
  ] as const)("answers an empty text and %s", async (_name, body, finishReason) => {
    fakes.google.answer(() => ({ status: 200, body: { ...body, usageMetadata: { promptTokenCount: 10 } } }));
    const answer = await llmProvider(fakes, { GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("google");
    expect(answer.text).toBe("");
    expect(answer.finishReason).toBe(finishReason);
  });

  it("asks OpenRouter when Google has no key, each item inline in OpenRouter's own form, with the pinned backend", async () => {
    const video = { bytes: new Uint8Array([0, 0, 0, 24]), contentType: "video/mp4" };
    const webm = { bytes: new Uint8Array([26, 69, 223, 163]), contentType: "audio/webm" };
    const wave = { bytes: new Uint8Array([82, 73, 70, 70]), contentType: "audio/vnd.wave" };
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture, video, webm, wave],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer).toEqual({ text: "ok", finishReason: "stop", costs: [{ state: "known", usd: CHAT_REPLY.usage.cost, tokens: TOKENS, source: "reported" }], upstream: "openrouter" });
    const [body] = posted(fakes.openrouter);
    expect(body).toMatchObject({ model: "google/gemini-3.8-flash", max_tokens: 200, provider: { only: ["google-vertex"], allow_fallbacks: false } });
    const parts = (body as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!.content;
    expect(parts).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${b64(picture.bytes)}` } });
    expect(parts).toContainEqual({ type: "video_url", video_url: { url: `data:video/mp4;base64,${b64(video.bytes)}` } });
    expect(parts).toContainEqual({ type: "input_audio", input_audio: { data: b64(webm.bytes), format: "webm" } });
    expect(parts).toContainEqual({ type: "input_audio", input_audio: { data: b64(wave.bytes), format: "wav" } });
  });

  it("sends nothing to OpenRouter for an audio type it has no format name for", async () => {
    const error = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([1]), contentType: "audio/x-unknown" }],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("uploads through the Files API past the inline limit, waits for the file, reads it by its uri, then deletes it", async () => {
    const config = llmConfig(fakes);
    config.upstreams.google = { ...config.upstreams.google!, base_url: `${fakes.google.url}/v1beta` };
    config.llm!.gemini_inline_max_bytes = 8;
    config.llm!.gemini_file_poll_ms = 10;
    let polls = 0;
    fakes.google.answer(({ method, path }) => {
      if (method === "POST" && path === "/upload/v1beta/files") return { status: 200, body: {}, headers: { "x-goog-upload-url": `${fakes.google.url}/upload-session/1` } };
      if (method === "POST" && path === "/upload-session/1") return { status: 200, body: { file: { name: "files/abc", uri: "https://files.example/abc", mimeType: "image/png", state: "PROCESSING" } } };
      if (method === "GET" && path === "/v1beta/files/abc") return { status: 200, body: { name: "files/abc", uri: "https://files.example/abc", mimeType: "image/png", state: ++polls < 2 ? "PROCESSING" : "ACTIVE" } };
      if (method === "DELETE" && path === "/v1beta/files/abc") return { status: 200, body: {} };
      return { status: 200, body: GENERATE_CONTENT_REPLY };
    });
    const provider = createProvider({ config, keyOf: (name) => ({ GOOGLE_API_KEY: "g" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const answer = await provider.llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array(32), contentType: "image/png" }],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.text).toBe("ok");
    // The delete runs after the answer, without holding it.
    await vi.waitFor(() => expect(fakes.google.seen.some((r) => r.method === "DELETE")).toBe(true));
    const order = fakes.google.seen.map((r) => `${r.method} ${r.path}`);
    const generate = order.findIndex((o) => o.endsWith(":generateContent"));
    expect(order.indexOf("POST /upload/v1beta/files")).toBeLessThan(generate);
    expect(order.lastIndexOf("GET /v1beta/files/abc")).toBeLessThan(generate);
    expect(order.indexOf("DELETE /v1beta/files/abc")).toBeGreaterThan(generate);
    const parts = (fakes.google.seen[generate]!.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts).toContainEqual({ fileData: { mimeType: "image/png", fileUri: "https://files.example/abc" } });
    expect(JSON.stringify(parts)).not.toContain("inlineData");
  });

  it.each([
    ["Google's SAFETY", "google", { status: 200, body: { ...GENERATE_CONTENT_REPLY, candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: "SAFETY", index: 0 }] } }],
    ["OpenRouter's content_filter", "openrouter", { status: 200, body: { ...CHAT_REPLY, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }] } }],
  ] as const)("answers %s as content-filter", async (_name, upstream, reply) => {
    fakes[upstream].answer(() => reply);
    const keys: Record<string, string> = upstream === "google" ? { GOOGLE_API_KEY: "g" } : { OPENROUTER_API_KEY: "or" };
    const answer = await llmProvider(fakes, keys).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.finishReason).toBe("content-filter");
  });

  it("moves on to OpenRouter when Google answers that it has no such model", async () => {
    fakes.google.answer(() => ({ status: 404, body: { error: { code: 404, message: "models/gemini-3.8-flash is not found", status: "NOT_FOUND" } } }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("openrouter");
  });

  it("moves on to OpenRouter for a not-found answer longer than a log snippet", async () => {
    const details = Array.from({ length: 6 }, (_, i) => ({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: `MODEL_NOT_FOUND_${i}`, domain: "generativelanguage.googleapis.com" }));
    const body = { error: { code: 404, message: "models/gemini-3.8-flash is not found for API version v1beta", status: "NOT_FOUND", details } };
    expect(JSON.stringify(body).length).toBeGreaterThan(500);
    fakes.google.answer(() => ({ status: 404, body }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [picture],
      maxOutputTokens: 200,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("openrouter");
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
    expect(answer.costs).toEqual([{ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-test" } }]);
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
    expect(answer.cost).toBeUndefined();
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("carries no cost for a refusal, which was not billed", async () => {
    fakes.openrouter.answer(() => ({ status: 400, body: { error: { message: "bad question" } } }));
    expect((await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request)).cost).toBeUndefined();
  });

  it("hands back the refusal's status with no words when its body stops part way", async () => {
    fakes.openrouter.answer(() => ({ status: 400, raw: "{\"error\":", contentType: "application/json", hold: true }));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge({ ...request, budgetMs: 500 });
    expect(answer).toEqual({ status: 400, body: "" });
    fakes.openrouter.release();
  });

  it("throws carrying one missing cost when a 2xx answer stops part way, since it was billed", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: "{\"likely\":", contentType: "application/json", hold: true }));
    const error = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge({ ...request, budgetMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(costsOf(error)).toEqual([expect.objectContaining({ state: "missing" })]);
    fakes.openrouter.release();
  });

  it("cleans the state and the questions with the caller's text cleaning, inside lists too", async () => {
    fakes.openrouter.answer(() => ({ status: 200, body: {} }));
    await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { cleanText: (t) => t.replaceAll("HIDDEN", "") }).llm.judge({
      ...request,
      state: { note: "fineHIDDEN", steps: ["oneHIDDEN", { name: "twoHIDDEN" }, 3] },
      questions: { "okHIDDEN": { text: "whyHIDDEN" } },
    });
    expect(JSON.stringify(posted(fakes.openrouter)[0])).not.toContain("HIDDEN");
    expect(posted(fakes.openrouter)[0]?.state).toEqual({ note: "fine", steps: ["one", { name: "two" }, 3] });
  });

  it("throws NoAnswer when the connection drops after the request arrived", async () => {
    fakes.openrouter.answer(() => "reset");
    await expect(llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.judge(request)).rejects.toBeInstanceOf(NoAnswer);
  });
});

describe("capabilities", () => {
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

  it.each([
    ["data that is not a list", { status: 200, body: { data: {} } }],
    ["a body that is not JSON", { status: 200, raw: "<html>", contentType: "text/html" }],
  ] as const)("keeps the last list and cools down when a later list answers %s", async (_name, bad) => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/models" ? { status: 200, body: models } : undefined));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    const shortLived = { ...policy, ttlMs: 50 };
    expect(await llm.capabilities("google/gemini-3.8-flash", shortLived)).toEqual({ pictures: true });
    fakes.openrouter.answer(() => bad);
    await new Promise((done) => setTimeout(done, 80));
    expect(await llm.capabilities("google/gemini-3.8-flash", shortLived)).toEqual({ pictures: true });
    expect(await llm.capabilities("google/gemini-3.8-flash", shortLived)).toEqual({ pictures: true });
    expect(listed()).toBe(2);
  });

  it("skips a row that is not an object and reads the rest", async () => {
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/models" ? { status: 200, body: { data: [5, null, ...models.data] } } : undefined));
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.capabilities("google/gemini-3.8-flash", policy)).toEqual({ pictures: true });
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

describe("capabilities: the context window", () => {
  const policy: CapabilityPolicy = { override: "auto", timeoutMs: 2_000, ttlMs: 60_000, retryMs: 200 };
  const PATH = "/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints";
  const endpoints = { data: { endpoints: [{ context_length: 1_048_576 }, { context_length: 1_000_000 }] } };
  const asked = (): number => fakes.openrouter.seen.filter((s) => s.path === PATH).length;

  it("reads the smallest endpoint window once per model and serves it from the cache", async () => {
    fakes.openrouter.answer(({ path }) => (path === PATH ? { status: 200, body: endpoints } : undefined));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", policy)).contextWindow).toBe(1_000_000);
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", policy)).contextWindow).toBe(1_000_000);
    expect(asked()).toBe(1);
  });

  it("reads the window when the picture capability is fixed by the deployment", async () => {
    fakes.openrouter.answer(({ path }) => (path === PATH ? { status: 200, body: endpoints } : undefined));
    expect(await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.capabilities("deepseek/deepseek-v4.1-flash-1017", { ...policy, override: "no" }))
      .toEqual({ pictures: false, contextWindow: 1_000_000 });
  });

  it("has no window when the list fails, and does not ask again inside the cooldown", async () => {
    fakes.openrouter.answer(() => ({ status: 503, body: {} }));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    // A cooldown longer than the run, so the second ask always falls inside it.
    const cooling = { ...policy, retryMs: 60_000 };
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", cooling)).contextWindow).toBeUndefined();
    const first = asked();
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", cooling)).contextWindow).toBeUndefined();
    expect(asked()).toBe(first);
  });

  it("keeps the last window when a later list names none", async () => {
    fakes.openrouter.answer(({ path }) => (path === PATH ? { status: 200, body: endpoints } : undefined));
    const llm = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm;
    const shortLived = { ...policy, ttlMs: 50 };
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", shortLived)).contextWindow).toBe(1_000_000);
    fakes.openrouter.answer(({ path }) => (path === PATH ? { status: 200, body: { data: { endpoints: [] } } } : undefined));
    await new Promise((done) => setTimeout(done, 80));
    expect((await llm.capabilities("deepseek/deepseek-v4.1-flash-1017", shortLived)).contextWindow).toBe(1_000_000);
    expect(asked()).toBe(2);
  });
});

describe("assertModelsPriced", () => {
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

describe("a refused understand call", () => {
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
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining(cost)]);
  });

  it("carries no cost for a refusal whose body is not JSON", async () => {
    fakes.google.answer(() => ({ status: 400, raw: "<html>bad request</html>", contentType: "text/html" }));
    const error = await refused({ GOOGLE_API_KEY: "g" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).costs).toEqual([]);
  });

  it("carries no cost for a refusal status whose body names none, and names the upstream that refused", async () => {
    fakes.google.answer(() => ({ status: 400, body: { error: { code: 400, message: "bad image", status: "INVALID_ARGUMENT" } } }));
    const error = await refused({ GOOGLE_API_KEY: "g" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect((error as UpstreamRequestRejected).costs).toEqual([]);
  });
});

describe("OpenRouter's backend pin", () => {
  it("is not sent on a prepared call: only understand pins the backend, as today", () => {
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("google/gemini-3.8-flash", { thinking: false, cache: false });
    expect(prepared.options.providerOptions.openrouter).not.toHaveProperty("provider");
  });
});

describe("cheapest mode for LLM calls", () => {
  it("serves a priced direct upstream before OpenRouter, whatever their weights", async () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "deepseek/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "deepseek", weight: 1 }] }, ...config.llm!.routes.filter((r) => r.prefix !== "deepseek/")];
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("deepseek");
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  /**
   * The upstream a cheapest call of DeepSeek V4 Pro reaches, DeepSeek at weight 0 and OpenRouter at 1.
   * @param openrouter - OpenRouter's unit prices for it, if any.
   * @param statesQuantization - Whether one of its OpenRouter endpoints states a level (`openrouter_states_quantization`).
   * @returns The upstream that answered.
   */
  const cheapestOn = async (openrouter?: { input_cache_miss_per_mtok: number; output_per_mtok: number }, statesQuantization = false): Promise<unknown> => {
    const config = llmConfig(fakes);
    config.llm!.openrouter_prices = openrouter === undefined ? {} : { "deepseek/deepseek-v4-pro": openrouter };
    if (statesQuantization) config.llm!.openrouter_states_quantization = ["deepseek/deepseek-v4-pro"];
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    return result.providerMetadata?.breatic?.upstream;
  };

  it("serves OpenRouter first when its unit price for the model is below the direct one", async () => {
    const direct = llmConfig(fakes).llm!.prices!["deepseek/deepseek-v4-pro"]![0];
    expect(await cheapestOn({ input_cache_miss_per_mtok: direct.input_cache_miss_per_mtok / 2, output_per_mtok: direct.output_per_mtok })).toBe("openrouter");
  });

  it("asks OpenRouter to try its endpoints cheapest first, the endpoint its unit price is taken from", async () => {
    const direct = llmConfig(fakes).llm!.prices!["deepseek/deepseek-v4-pro"]![0];
    expect(await cheapestOn({ input_cache_miss_per_mtok: direct.input_cache_miss_per_mtok / 2, output_per_mtok: direct.output_per_mtok })).toBe("openrouter");
    expect(posted(fakes.openrouter)[0]?.provider).toEqual({ sort: "price", quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"] });
  });

  it("leaves unknown out of a cheapest OpenRouter call for a model one of whose endpoints states a level", async () => {
    const direct = llmConfig(fakes).llm!.prices!["deepseek/deepseek-v4-pro"]![0];
    expect(await cheapestOn({ input_cache_miss_per_mtok: direct.input_cache_miss_per_mtok / 2, output_per_mtok: direct.output_per_mtok }, true)).toBe("openrouter");
    expect(posted(fakes.openrouter)[0]?.provider).toEqual({ sort: "price", quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"] });
  });

  it("ranks OpenRouter last for a model that states a level but has no OpenRouter price, and still leaves unknown out of its call", async () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "deepseek/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "deepseek", weight: 1 }] }, ...config.llm!.routes.filter((r) => r.prefix !== "deepseek/")];
    config.llm!.openrouter_prices = {};
    config.llm!.openrouter_states_quantization = ["deepseek/deepseek-v4-pro"];
    fakes.deepseek.answer(() => ({ status: 503, body: { error: { message: "busy" } } }));
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
    expect(posted(fakes.openrouter)[0]?.provider).toEqual({ sort: "price", quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"] });
  });

  it("takes the quantizations a deployment lists for a cheapest OpenRouter call", async () => {
    const config = llmConfig(fakes);
    config.llm!.openrouter_prices = { "deepseek/deepseek-v4-pro": { input_cache_miss_per_mtok: 0.01, output_per_mtok: 0.01 } };
    config.llm!.openrouter_quantizations = ["bf16"];
    const provider = createProvider({ config, keyOf: (name) => ({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false }, { mode: "cheapest" });
    await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.openrouter)[0]?.provider).toEqual({ sort: "price", quantizations: ["bf16"] });
  });

  it("leaves OpenRouter's own endpoint choice to it outside cheapest mode", async () => {
    const provider = createProvider({ config: llmConfig(fakes), keyOf: (name) => ({ OPENROUTER_API_KEY: "or" })[name], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", { thinking: false, cache: false });
    await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.openrouter)[0]).not.toHaveProperty("provider");
  });

  it("serves the direct upstream first when OpenRouter's unit price is higher", async () => {
    const direct = llmConfig(fakes).llm!.prices!["deepseek/deepseek-v4-pro"]![0];
    expect(await cheapestOn({ input_cache_miss_per_mtok: direct.input_cache_miss_per_mtok, output_per_mtok: direct.output_per_mtok * 2 })).toBe("deepseek");
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("keeps the weight order between equal unit prices", async () => {
    const direct = llmConfig(fakes).llm!.prices!["deepseek/deepseek-v4-pro"]![0];
    expect(await cheapestOn({ input_cache_miss_per_mtok: direct.input_cache_miss_per_mtok, output_per_mtok: direct.output_per_mtok })).toBe("deepseek");
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

describe("llm.availability", () => {
  it("answers the upstreams of an understand call in its own route's order, naming each missing key", () => {
    const availability = llmProvider(fakes, { GOOGLE_API_KEY: "g" }).llm.availability("google/gemini-3.8-flash", "understand");
    expect(availability.upstreams).toEqual([
      { upstream: "google", weight: 0, configured: true, envVar: "GOOGLE_API_KEY" },
      { upstream: "openrouter", weight: 1, configured: false, envVar: "OPENROUTER_API_KEY" },
    ]);
  });

  it("answers the upstreams of a prepared call by the call routes", () => {
    const availability = llmProvider(fakes, { GOOGLE_API_KEY: "g" }).llm.availability("google/gemini-3.8-flash", "call");
    expect(availability.upstreams.map((u) => [u.upstream, u.configured])).toEqual([["google", true], ["openrouter", false]]);
  });

  it("answers the OpenRouter upstream a judge call uses", () => {
    expect(llmProvider(fakes, {}).llm.availability("typesafe/jev-1.13", "judge").upstreams).toEqual([
      { upstream: "openrouter", weight: 0, configured: false, envVar: "OPENROUTER_API_KEY" },
    ]);
    expect(llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.availability("typesafe/jev-1.13", "judge").upstreams[0]?.configured).toBe(true);
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
    expect(answer.cost?.state).toBe("missing");
  });
});

describe("capabilities with a stop signal", () => {
  it("lets a caller leave a pending refresh when its signal ends", async () => {
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
