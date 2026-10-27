// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { generateText, stepCountIs, streamText, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NoUpstreamAvailable } from "../../errors.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { CHAT_REPLY, llmProvider, posted, postedAt, startFakes, stopFakes, vendorReply, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopFakes(fakes);
});

const BOTH = { DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" };
const THINK = { thinking: true, cache: false } as const;

/** A chat completion that calls the `lookup` tool once. */
const TOOL_CALL_REPLY = {
  ...CHAT_REPLY,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    },
  ],
};

/**
 * Server-sent chat completion chunks: the first carries the generation id and
 * some text; `finish` adds the closing chunk with usage.
 * @param finish - Whether the stream ends.
 * @returns The raw stream.
 */
function sse(finish: boolean): string {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
  const first = chunk({ role: "assistant", content: "he" });
  if (!finish) return first;
  return `${first}${`data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0001 },
  })}\n\n`}data: [DONE]\n\n`;
}

describe("switching before the first content (design 5.5)", () => {
  it.each([500, 503])("moves to the next upstream on a %i once this one's retries are spent", async (status) => {
    fakes.deepseek.answer(() => ({ status, body: { error: { message: "busy" } } }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.text).toBe("ok");
    expect(posted(fakes.deepseek)).toHaveLength(3);
    expect(posted(fakes.openrouter)).toHaveLength(1);
    expect(posted(fakes.openrouter)[0]).toMatchObject({ model: "deepseek/deepseek-v4-pro", reasoning: { effort: "max" } });
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
  });

  it("retries the same upstream on a 429 and keeps it when a retry succeeds", async () => {
    let n = 0;
    fakes.deepseek.answer(({ path }) => (++n === 1 ? { status: 429, body: {} } : vendorReply(path)));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.deepseek)).toHaveLength(2);
    expect(posted(fakes.openrouter)).toHaveLength(0);
    expect(result.providerMetadata?.breatic?.upstream).toBe("deepseek");
  });

  it("moves on when the connection is refused", async () => {
    await fakes.deepseek.close();
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 0 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
  });

  it("does not move on a 400", async () => {
    fakes.deepseek.answer(() => ({ status: 400, body: { error: { message: "bad request" } } }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    await expect(generateText({ model: prepared.model, prompt: "hi", ...prepared.options })).rejects.toThrow();
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  // Measured 2026-10-26: OpenRouter answers an unknown model id with this 400 (design 13.3).
  it("reports a model OpenRouter does not have as model_not_found, not as a refused request", async () => {
    fakes.openrouter.answer(() => ({ status: 400, body: { error: { message: "no/such-model is not a valid model ID", code: 400 } } }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("no/such-model", THINK);
    const error = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).reasons).toContainEqual({ upstream: "openrouter", kind: "failed", failure: "model_not_found" });
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("keeps OpenRouter's parameter 400 as a refused request", async () => {
    fakes.openrouter.answer(() => ({ status: 400, body: { error: { message: 'Input required: specify "prompt" or "messages"', code: 400 } } }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const error = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NoUpstreamAvailable);
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("moves a stream on before any content arrived", async () => {
    fakes.deepseek.answer(() => ({ status: 503, body: {} }));
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 0 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(await stream.text).toBe("he");
    expect((await stream.providerMetadata)?.breatic?.upstream).toBe("openrouter");
  });
});

describe("one call stays on the upstream that first served it (design 5.5)", () => {
  /**
   * A two-step tool call whose first step DeepSeek refuses with a 503.
   * @param second - How OpenRouter answers the second step.
   * @returns The call's outcome.
   */
  function twoSteps(second: () => Reply): Promise<unknown> {
    let deepseekCalls = 0;
    fakes.deepseek.answer(({ path }) => (++deepseekCalls === 1 ? { status: 503, body: {} } : vendorReply(path)));
    let openrouterCalls = 0;
    fakes.openrouter.answer(() => (++openrouterCalls === 1 ? { status: 200, body: TOOL_CALL_REPLY } : second()));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 0 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    return generateText({
      model: prepared.model,
      prompt: "hi",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }) },
      stopWhen: stepCountIs(2),
      ...prepared.options,
    });
  }

  it("sends the second step to the upstream of the first, with its reasoning field, though the first one is back", async () => {
    await twoSteps(() => ({ status: 200, body: CHAT_REPLY }));
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(2);
    expect(posted(fakes.openrouter)[1]).toMatchObject({ reasoning: { effort: "max" } });
  });

  it("only retries the fixed upstream on a 429 at the second step, then fails without moving", async () => {
    await expect(twoSteps(() => ({ status: 429, body: {} }))).rejects.toThrow();
    expect(posted(fakes.deepseek)).toHaveLength(1);
  });
});

describe("what a call reports about its cost (design 3.5, S4)", () => {
  it("names the upstream that served it and no lookup when the answer carried its cost", async () => {
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic).toMatchObject({ upstream: "openrouter" });
    expect(result.providerMetadata?.breatic?.costRef).toBeUndefined();
    expect(prepared.pendingCosts()).toEqual([]);
  });

  it("carries a lookup for OpenRouter when the answer did not say what it cost", async () => {
    const { cost: _cost, ...usage } = CHAT_REPLY.usage;
    fakes.openrouter.answer(() => ({ status: 200, body: { ...CHAT_REPLY, usage } }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.costRef).toMatchObject({ upstream: "openrouter", generationId: "gen-test" });
  });

  it("hands the lookup of a stream stopped before its end to pendingCosts", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(false), contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stop = new AbortController();
    const stream = streamText({ model: prepared.model, prompt: "hi", abortSignal: stop.signal, ...prepared.options });
    for await (const text of stream.textStream) {
      if (text !== "") break;
    }
    stop.abort();
    await Promise.resolve(stream.consumeStream()).catch(() => undefined);
    expect(prepared.pendingCosts()).toEqual([{ state: "pending", lookup: expect.objectContaining({ upstream: "openrouter", generationId: "gen-1" }) }]);
  });

  it("forgets the lookup once the stream finished", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    await streamText({ model: prepared.model, prompt: "hi", ...prepared.options }).consumeStream();
    expect(prepared.pendingCosts()).toEqual([]);
  });
});

/**
 * Prepare a thinking call of one model and run it whole.
 * @param keys - The environment keys.
 * @param model - Our model id.
 * @param maxRetries - Retries on one upstream.
 * @returns The answer, or what the call threw.
 */
async function run(keys: Record<string, string>, model: string, maxRetries = 2): Promise<unknown> {
  const prepared = llmProvider(fakes, keys, { llmMaxRetries: maxRetries }).llm.prepare(model, THINK);
  return generateText({ model: prepared.model, prompt: "hi", ...prepared.options }).catch((e: unknown) => e);
}

/**
 * The upstream that served a call, or undefined when it threw.
 * @param outcome - What run gave back.
 * @returns The upstream.
 */
const servedBy = (outcome: unknown): unknown => (outcome as { providerMetadata?: { breatic?: { upstream?: unknown } } }).providerMetadata?.breatic?.upstream;

// Each vendor's own answers, measured 2026-10-27 except Anthropic's missing model, read from its error docs (design 5.3).
describe("a direct vendor's answer that it has no such model moves the call on (design 5.3)", () => {
  it.each([
    {
      vendor: "google" as const,
      model: "google/gemini-no-such",
      key: "GOOGLE_API_KEY",
      reply: { status: 404, body: { error: { code: 404, message: "models/gemini-no-such is not found for API version v1beta, or is not supported for generateContent.", status: "NOT_FOUND" } } },
    },
    {
      vendor: "openai" as const,
      model: "openai/gpt-no-such",
      key: "OPENAI_API_KEY",
      reply: { status: 404, body: { error: { message: "The model `gpt-no-such` does not exist or you do not have access to it.", type: "invalid_request_error", param: null, code: "model_not_found" } } },
    },
    {
      vendor: "deepseek" as const,
      model: "deepseek/deepseek-no-such",
      key: "DEEPSEEK_API_KEY",
      reply: {
        status: 400,
        body: { error: { message: "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-no-such. (request_id: 1)", type: "invalid_request_error", param: null, code: "invalid_request_error" } },
      },
    },
    {
      vendor: "anthropic" as const,
      model: "anthropic/claude-no-such",
      key: "ANTHROPIC_API_KEY",
      reply: { status: 404, body: { type: "error", error: { type: "not_found_error", message: "model: claude-no-such" } } },
    },
  ])("$vendor", async ({ vendor, model, key, reply }) => {
    fakes[vendor].answer(() => reply);
    const outcome = await run({ [key]: "k", OPENROUTER_API_KEY: "or" }, model);
    expect(servedBy(outcome)).toBe("openrouter");
    expect(posted(fakes[vendor])).toHaveLength(1);
  });
});

describe("a direct vendor's refusal of the params stays a refusal (design 5.3)", () => {
  it.each([
    {
      vendor: "google" as const,
      model: "google/gemini-2.5-flash",
      key: "GOOGLE_API_KEY",
      reply: { status: 400, body: { error: { code: 400, message: "* GenerateContentRequest.generation_config.temperature: temperature must be in the range [0.0, 2.0].", status: "INVALID_ARGUMENT" } } },
    },
    {
      vendor: "openai" as const,
      model: "openai/gpt-5",
      key: "OPENAI_API_KEY",
      reply: { status: 400, body: { error: { message: "Invalid 'temperature': decimal above maximum value.", type: "invalid_request_error", param: "temperature", code: "decimal_above_max_value" } } },
    },
    {
      vendor: "deepseek" as const,
      model: "deepseek/deepseek-v4-pro",
      key: "DEEPSEEK_API_KEY",
      reply: { status: 400, body: { error: { message: "Invalid temperature value, the valid range of temperature is [0, 2] (request_id: 1)", type: "invalid_request_error", param: null, code: "invalid_request_error" } } },
    },
    {
      vendor: "anthropic" as const,
      model: "anthropic/claude-opus-5.5",
      key: "ANTHROPIC_API_KEY",
      reply: { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be greater than or equal to 1" } } },
    },
    {
      vendor: "openai" as const,
      model: "openai/gpt-5",
      key: "OPENAI_API_KEY",
      reply: { status: 404, body: { error: { message: "Not found", type: "invalid_request_error", param: null, code: null } } },
    },
  ])("$vendor $reply.status", async ({ vendor, model, key, reply }) => {
    fakes[vendor].answer(() => reply);
    const outcome = await run({ [key]: "k", OPENROUTER_API_KEY: "or" }, model);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(NoUpstreamAvailable);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });
});

describe("an upstream's answer that the account has no balance moves the call on (design 5.3)", () => {
  it.each([
    {
      vendor: "anthropic" as const,
      model: "anthropic/claude-opus-5.5",
      key: "ANTHROPIC_API_KEY",
      // Measured 2026-10-27.
      reply: { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } } },
    },
    {
      vendor: "deepseek" as const,
      model: "deepseek/deepseek-v4-pro",
      key: "DEEPSEEK_API_KEY",
      // DeepSeek's error code page: 402 Insufficient Balance.
      reply: { status: 402, body: { error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" } } },
    },
    {
      vendor: "openai" as const,
      model: "openai/gpt-5",
      key: "OPENAI_API_KEY",
      // Measured 2026-10-27.
      reply: { status: 429, body: { error: { message: "You have no credits remaining.", type: "insufficient_quota", param: null, code: "credit_balance_exhausted" } } },
    },
  ])("$vendor, at once and without retrying it", async ({ vendor, model, key, reply }) => {
    fakes[vendor].answer(() => reply);
    const outcome = await run({ [key]: "k", OPENROUTER_API_KEY: "or" }, model, 2);
    expect(servedBy(outcome)).toBe("openrouter");
    expect(posted(fakes[vendor])).toHaveLength(1);
  });

  it("names the exhausted balance among the reasons when OpenRouter answers 402", async () => {
    fakes.openrouter.answer(() => ({ status: 402, body: { error: { message: "Insufficient credits", code: 402 } } }));
    const outcome = await run({ OPENROUTER_API_KEY: "or" }, "meta/llama-x", 2);
    expect(outcome).toBeInstanceOf(NoUpstreamAvailable);
    expect((outcome as NoUpstreamAvailable).reasons).toEqual([{ upstream: "openrouter", kind: "failed", failure: "insufficient_balance" }]);
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });
});

/**
 * A server-sent error part before any content, the shape OpenRouter streams.
 * @param code - The error's code.
 * @returns The raw stream.
 */
const inBandError = (code: number): string => `data: ${JSON.stringify({ error: { code, message: "Provider returned error" } })}\n\n`;

describe("an error part before the first content is judged like a status (design 5.5)", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("moves to the next upstream on an in-band 5xx", async () => {
    fakes.deepseek.answer(() => ({ status: 200, raw: inBandError(502), contentType: "text/event-stream" }));
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 0 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(await stream.text).toBe("he");
    expect((await stream.providerMetadata)?.breatic?.upstream).toBe("openrouter");
  });

  it("retries the same upstream on an in-band 429", async () => {
    let n = 0;
    fakes.openrouter.answer(() => ({ status: 200, raw: ++n === 1 ? inBandError(429) : sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("meta/llama-x", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(await stream.text).toBe("he");
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });

  it("does not move on an in-band 400", async () => {
    fakes.deepseek.answer(() => ({ status: 200, raw: inBandError(400), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options });
    await stream.consumeStream();
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });
});

describe("waiting before a retry on the same upstream (design 5.3)", () => {
  /**
   * The gaps between the requests a fake received, in milliseconds.
   * @param times - Arrival times.
   * @returns Each gap.
   */
  const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i]!);

  it("backs off with jitter before retrying a 429", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    let n = 0;
    fakes.deepseek.answer(({ path }) => (++n === 1 ? { status: 429, body: {} } : vendorReply(path)));
    const outcome = await run(BOTH, "deepseek/deepseek-v4-pro", 2);
    expect(servedBy(outcome)).toBe("deepseek");
    expect(gaps(postedAt(fakes.deepseek))[0]).toBeGreaterThanOrEqual(900);
  });

  it("waits the Retry-After the upstream asked for", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let n = 0;
    fakes.deepseek.answer(({ path }) => (++n === 1 ? { status: 429, body: {}, headers: { "retry-after": "2" } } : vendorReply(path)));
    const outcome = await run(BOTH, "deepseek/deepseek-v4-pro", 2);
    expect(servedBy(outcome)).toBe("deepseek");
    expect(gaps(postedAt(fakes.deepseek))[0]).toBeGreaterThanOrEqual(1_900);
  });

  it("moves on at once when the Retry-After is longer than a minute", async () => {
    fakes.deepseek.answer(() => ({ status: 429, body: {}, headers: { "retry-after": "3600" } }));
    const started = Date.now();
    const outcome = await run(BOTH, "deepseek/deepseek-v4-pro", 2);
    expect(servedBy(outcome)).toBe("openrouter");
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("backs off on the upstream a later step is pinned to", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    let openrouterCalls = 0;
    fakes.openrouter.answer(() => {
      openrouterCalls++;
      if (openrouterCalls === 1) return { status: 200, body: TOOL_CALL_REPLY };
      return openrouterCalls === 2 ? { status: 429, body: {} } : { status: 200, body: CHAT_REPLY };
    });
    // DeepSeek has no key, so OpenRouter serves the first step and the second is pinned to it.
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    await generateText({
      model: prepared.model,
      prompt: "hi",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }) },
      stopWhen: stepCountIs(2),
      ...prepared.options,
    });
    expect(posted(fakes.openrouter)).toHaveLength(3);
    expect(gaps(postedAt(fakes.openrouter))[1]).toBeGreaterThanOrEqual(900);
  });
});

describe("a stream stopped before its first content (design 3.5, S4)", () => {
  it("still hands the generation it was given to pendingCosts", async () => {
    const opening = `data: ${JSON.stringify({ id: "gen-early", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`;
    fakes.openrouter.answer(() => ({ status: 200, raw: opening, contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stop = new AbortController();
    const stream = streamText({ model: prepared.model, prompt: "hi", abortSignal: stop.signal, ...prepared.options });
    setTimeout(() => stop.abort(), 300);
    await Promise.resolve(stream.consumeStream()).catch(() => undefined);
    expect(prepared.pendingCosts()).toEqual([{ state: "pending", lookup: expect.objectContaining({ upstream: "openrouter", generationId: "gen-early" }) }]);
  });
});
