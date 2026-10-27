// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { generateText, stepCountIs, streamText, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { costsOf, NoUpstreamAvailable, UnderstandInterrupted, UpstreamRequestRejected } from "../../errors.js";
import { createProvider } from "../../provider.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { CHAT_REPLY, llmConfig, llmProvider, posted, postedAt, startFakes, stopFakes, vendorReply, type LlmFakes } from "./llm-harness.js";

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

  it.each([408, 409])("retries the same upstream on a %i and keeps it when a retry succeeds, as the AI SDK did (DD 25)", async (status) => {
    let n = 0;
    fakes.deepseek.answer(({ path }) => (++n === 1 ? { status, body: { error: { message: "try again" } } } : vendorReply(path)));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.deepseek)).toHaveLength(2);
    expect(posted(fakes.openrouter)).toHaveLength(0);
    expect(result.providerMetadata?.breatic?.upstream).toBe("deepseek");
  });

  it("moves to the next upstream on a 408 once this one's retries are spent", async () => {
    fakes.deepseek.answer(() => ({ status: 408, body: { error: { message: "timeout" } } }));
    const result = await run(BOTH, "deepseek/deepseek-v4-pro", 1);
    expect((result as { providerMetadata?: { breatic?: { upstream?: unknown } } }).providerMetadata?.breatic?.upstream).toBe("openrouter");
    expect(posted(fakes.deepseek)).toHaveLength(2);
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

  it("retries the fixed upstream on a 408 at the second step and finishes there (DD 25)", async () => {
    let n = 0;
    fakes.openrouter.answer(() => (++n === 1 ? { status: 200, body: TOOL_CALL_REPLY } : n === 2 ? { status: 408, body: {} } : { status: 200, body: CHAT_REPLY }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 1 }).llm.prepare("meta/llama-x", THINK);
    const result = await generateText({
      model: prepared.model,
      prompt: "hi",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }) },
      stopWhen: stepCountIs(2),
      ...prepared.options,
    });
    expect(result.text).toBe("ok");
    expect(posted(fakes.openrouter)).toHaveLength(3);
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

/**
 * OpenRouter's whole answer of 200 whose body is an error, the form its SDK throws as a status-200 APICallError.
 * @param code - The error's code.
 * @returns The reply.
 */
const wholeError = (code: number): Reply => ({ status: 200, body: { error: { code, message: "Provider returned error" } } });

describe("OpenRouter's 200 whose body is an error is judged by its code, as in a stream (design 5.3, 5.5)", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("retries OpenRouter on a 429 in the body", async () => {
    let n = 0;
    fakes.openrouter.answer(({ path }) => (++n === 1 ? wholeError(429) : vendorReply(path)));
    const outcome = await run({ OPENROUTER_API_KEY: "or" }, "meta/llama-x");
    expect((outcome as { text?: unknown }).text).toBe("ok");
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });

  it("moves to the next upstream on a 502 in the body", async () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "deepseek/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "deepseek", weight: 1 }] }];
    fakes.openrouter.answer(() => wholeError(502));
    const provider = createProvider({ config, keyOf: (name) => BOTH[name as keyof typeof BOTH], llmMaxRetries: 0, cleanText: (t) => t });
    const prepared = provider.llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("deepseek");
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("keeps a 200 in the body as a refusal", async () => {
    fakes.openrouter.answer(() => wholeError(200));
    const outcome = await run({ OPENROUTER_API_KEY: "or" }, "meta/llama-x");
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(NoUpstreamAvailable);
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("moves an understand call on to Google on a 502 in the body", async () => {
    fakes.openrouter.answer(() => wholeError(502));
    const answer = await llmProvider(fakes, { OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }, { llmMaxRetries: 0 }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
      maxOutputTokens: 50,
      deadlineAt: Date.now() + 60_000,
    });
    expect(answer.upstream).toBe("google");
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });
});

/**
 * OpenRouter's 200 whose only choice carries an error, the form it uses when a model fails once it is producing output.
 * @param code - The error's code.
 * @param content - What the model wrote before it failed.
 * @returns The reply.
 */
const choiceError = (code: number, content = ""): Reply => ({
  status: 200,
  body: { ...CHAT_REPLY, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "error", error: { code, message: "Upstream died" } }] },
});

describe("an understand answer whose choice carries an error (design 3.5, DD 24)", () => {
  /**
   * Ask the understand model through the harness.
   * @param keys - The environment keys.
   * @returns The answer, or what it threw.
   */
  const ask = (keys: Record<string, string>): Promise<unknown> =>
    llmProvider(fakes, keys, { llmMaxRetries: 0 }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
      maxOutputTokens: 50,
      deadlineAt: Date.now() + 60_000,
    }).catch((e: unknown) => e);

  it("moves on to Google when the code is a 502 and nothing was written", async () => {
    fakes.openrouter.answer(() => choiceError(502));
    const answer = await ask({ OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" });
    expect((answer as { upstream?: unknown }).upstream).toBe("google");
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("keeps the cost OpenRouter billed for the answer it moved past, before Google's (DD 25)", async () => {
    fakes.openrouter.answer(() => choiceError(502));
    const answer = await ask({ OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" });
    expect((answer as { costs?: unknown }).costs).toEqual([
      expect.objectContaining({ state: "known", usd: CHAT_REPLY.usage.cost, source: "reported" }),
      expect.objectContaining({ state: "known", source: "price_table" }),
    ]);
  });

  it("carries the costs of every billed answer on the NoUpstreamAvailable it ends with (DD 25)", async () => {
    fakes.openrouter.answer(() => choiceError(502));
    const error = await ask({ OPENROUTER_API_KEY: "or" });
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).costs).toEqual([expect.objectContaining({ state: "known", usd: CHAT_REPLY.usage.cost })]);
  });

  it("carries the earlier billed answer and the refused one on UpstreamRequestRejected (DD 25)", async () => {
    let n = 0;
    fakes.openrouter.answer(() => choiceError(++n === 1 ? 502 : 400));
    const error = await llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 1 }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
      maxOutputTokens: 50,
      deadlineAt: Date.now() + 60_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).costs).toHaveLength(2);
  });

  it("throws UpstreamRequestRejected naming OpenRouter, with the cost it reported, when the code is a 400 and nothing was written", async () => {
    fakes.openrouter.answer(() => choiceError(400));
    const error = await ask({ OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("openrouter");
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining({ state: "known", usd: CHAT_REPLY.usage.cost })]);
    expect(posted(fakes.google)).toHaveLength(0);
  });

  it("answers what was written before the error, as a stop", async () => {
    fakes.openrouter.answer(() => choiceError(502, "a fox"));
    const answer = await ask({ OPENROUTER_API_KEY: "or" });
    expect(answer).toMatchObject({ text: "a fox", upstream: "openrouter" });
  });
});

describe("every exit of an understand call carries what was billed (design 3.5, DD 26)", () => {
  /**
   * Ask the understand model through the harness.
   * @param keys - The environment keys.
   * @param maxRetries - Retries on one upstream.
   * @param deadlineMs - Time the call has.
   * @returns The answer, or what it threw.
   */
  const ask = (keys: Record<string, string>, maxRetries: number, deadlineMs = 60_000): Promise<unknown> =>
    llmProvider(fakes, keys, { llmMaxRetries: maxRetries }).llm.understand({
      model: "google/gemini-3.8-flash",
      question: "What is in it?",
      media: [{ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }],
      maxOutputTokens: 50,
      deadlineAt: Date.now() + deadlineMs,
    }).catch((e: unknown) => e);
  const billedChoiceError = (code: unknown): Reply => ({
    status: 200,
    body: { ...CHAT_REPLY, usage: { ...CHAT_REPLY.usage, cost: 0.5 }, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code, message: "Upstream died" } }] },
  });

  it("keeps the cost of a 200 whose error sits at the top of the body, before the retried answer", async () => {
    let n = 0;
    fakes.openrouter.answer(() => (++n === 1 ? { status: 200, body: { id: "gen-a", error: { message: "busy", code: 502 }, usage: { cost: 0.5 } } } : { status: 200, body: CHAT_REPLY }));
    const answer = await ask({ OPENROUTER_API_KEY: "or" }, 1);
    expect((answer as { costs?: unknown }).costs).toEqual([
      expect.objectContaining({ state: "known", usd: 0.5 }),
      expect.objectContaining({ state: "known", usd: CHAT_REPLY.usage.cost }),
    ]);
  });

  it("throws UnderstandInterrupted carrying the billed answer when the deadline cuts the retry", async () => {
    let n = 0;
    fakes.openrouter.answer(() => (++n === 1 ? billedChoiceError(502) : "hang"));
    const error = await ask({ OPENROUTER_API_KEY: "or" }, 1, 1_500);
    expect(error).toBeInstanceOf(UnderstandInterrupted);
    expect((error as UnderstandInterrupted).costs).toEqual([expect.objectContaining({ state: "known", usd: 0.5 })]);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(costsOf(error)).toEqual((error as UnderstandInterrupted).costs);
  });

  it("throws UnderstandInterrupted carrying the cost of an answer whose error form it cannot read, without moving on", async () => {
    fakes.openrouter.answer(() => billedChoiceError("upstream_error"));
    const error = await ask({ OPENROUTER_API_KEY: "or", GOOGLE_API_KEY: "g" }, 0);
    expect(error).toBeInstanceOf(UnderstandInterrupted);
    expect((error as UnderstandInterrupted).costs).toEqual([expect.objectContaining({ state: "known", usd: 0.5 })]);
    expect(posted(fakes.google)).toHaveLength(0);
  });

  it.each([413, 401, 400])("names the status %i on UpstreamRequestRejected, with the upstream's error as its cause", async (status) => {
    fakes.openrouter.answer(() => ({ status, body: { error: { code: status, message: "refused by the service" } } }));
    const error = await ask({ OPENROUTER_API_KEY: "or" }, 0);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).status).toBe(status);
    expect((error as Error).cause).toBeDefined();
  });

  it("names the code of a refusing choice error as the status", async () => {
    fakes.openrouter.answer(() => billedChoiceError(400));
    const error = await ask({ OPENROUTER_API_KEY: "or" }, 0);
    expect((error as UpstreamRequestRejected).status).toBe(400);
  });
});

describe("the reasons of a call no upstream served (design 5.4, DD 24)", () => {
  it("names the status of each upstream's last failure", async () => {
    fakes.deepseek.answer(() => ({ status: 503, body: {} }));
    fakes.openrouter.answer(() => ({ status: 429, body: {} }));
    const outcome = await run(BOTH, "deepseek/deepseek-v4-pro", 0);
    expect(outcome).toBeInstanceOf(NoUpstreamAvailable);
    expect((outcome as NoUpstreamAvailable).reasons).toEqual([
      { upstream: "deepseek", kind: "failed", failure: "http_status", status: 503 },
      { upstream: "openrouter", kind: "failed", failure: "http_status", status: 429 },
    ]);
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

/**
 * One server-sent chunk.
 * @param body - The chunk.
 * @returns Its event line.
 */
const event = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

describe("a stream that reports an error and then finishes (design 3.5, 5.5)", () => {
  it("hands its generation over once, on the finish, and keeps none in pendingCosts", async () => {
    const raw = event({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finish_reason: null }] })
      + event({ id: "gen-1", error: { code: 502, message: "Provider returned error" } })
      + "data: [DONE]\n\n";
    fakes.openrouter.answer(() => ({ status: 200, raw, contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("meta/llama-x", THINK);
    const ends: unknown[] = [];
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options, onError: () => undefined, onFinish: (e) => void ends.push(e.providerMetadata?.breatic) });
    await stream.consumeStream();
    expect(ends).toEqual([expect.objectContaining({ costRef: { upstream: "openrouter", generationId: "gen-1" } })]);
    expect(prepared.pendingCosts()).toEqual([]);
  });
});

describe("a pinned step whose stream reports an error before its content (design 12.4)", () => {
  it("is retried on the same upstream", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const toolCall = event({
      id: "gen-a",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }],
    }) + event({ id: "gen-a", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
    let n = 0;
    fakes.openrouter.answer(() => {
      n++;
      const raw = n === 1 ? toolCall : n === 2 ? inBandError(502) : sse(true);
      return { status: 200, raw, contentType: "text/event-stream" };
    });
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("meta/llama-x", THINK);
    const stream = streamText({
      model: prepared.model,
      prompt: "hi",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }) },
      stopWhen: stepCountIs(2),
      onError: () => undefined,
      ...prepared.options,
    });
    expect(await stream.text).toBe("he");
    expect(posted(fakes.openrouter)).toHaveLength(3);
  });
});

/**
 * One Anthropic server-sent event.
 * @param name - The event name.
 * @param body - Its data.
 * @returns The event lines.
 */
const anthropicEvent = (name: string, body: unknown): string => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`;

describe("each vendor's own in-band error form before the first content (design 5.5, DD 22)", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("retries Anthropic's in-stream overload, then moves on", async () => {
    const opening = anthropicEvent("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      + anthropicEvent("ping", { type: "ping" })
      + anthropicEvent("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    fakes.anthropic.answer(() => ({ status: 200, raw: opening, contentType: "text/event-stream" }));
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 1 }).llm.prepare("anthropic/claude-opus-5.5", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, ...prepared.options });
    expect(await stream.text).toBe("he");
    expect(posted(fakes.anthropic)).toHaveLength(2);
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });

  it("retries DeepSeek's in-stream server error, then moves on", async () => {
    fakes.deepseek.answer(() => ({ status: 200, raw: event({ error: { code: "server_error", message: "busy" } }), contentType: "text/event-stream" }));
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(true), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 1 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, ...prepared.options });
    expect(await stream.text).toBe("he");
    expect(posted(fakes.deepseek)).toHaveLength(2);
  });
});

describe("a pinned step on an answer a retry cannot fix (design 5.3, 12.4)", () => {
  /**
   * A two-step call through OpenRouter whose second step gets this answer.
   * @param second - The second step's answer.
   * @returns What the call threw.
   */
  async function secondStep(second: Reply): Promise<unknown> {
    let n = 0;
    fakes.openrouter.answer(() => (++n === 1 ? { status: 200, body: TOOL_CALL_REPLY } : second));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 3 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    return generateText({
      model: prepared.model,
      prompt: "hi",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }) },
      stopWhen: stepCountIs(2),
      ...prepared.options,
    }).then(() => undefined, (e: unknown) => e);
  }

  it("does not retry an exhausted balance", async () => {
    expect(await secondStep({ status: 402, body: { error: { message: "Insufficient credits", code: 402 } } })).toBeInstanceOf(Error);
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });

  it("does not retry a missing model", async () => {
    expect(await secondStep({ status: 400, body: { error: { message: "x/y is not a valid model ID", code: 400 } } })).toBeInstanceOf(Error);
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });

  it("does not wait out a pinned 503's Retry-After longer than a minute", async () => {
    expect(await secondStep({ status: 503, body: {}, headers: { "retry-after": "3600" } })).toBeInstanceOf(Error);
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });

  it("does not wait out a Retry-After longer than a minute", async () => {
    expect(await secondStep({ status: 429, body: {}, headers: { "retry-after": "3600" } })).toBeInstanceOf(Error);
    expect(posted(fakes.openrouter)).toHaveLength(2);
  });
});

describe("streams cut or left early (design 5.3, 3.5)", () => {
  it("stops on an answer the vendor's SDK cannot read, without moving on", async () => {
    fakes.deepseek.answer(() => ({ status: 200, raw: "not json", contentType: "application/json" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    await expect(generateText({ model: prepared.model, prompt: "hi", ...prepared.options })).rejects.toThrow();
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("stops on what the vendor's SDK refuses before sending, without moving on", async () => {
    const prepared = llmProvider(fakes, { ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("anthropic/claude-opus-5.5", THINK);
    const outcome = await generateText({
      model: prepared.model,
      messages: [{ role: "user", content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "application/x-unknown" }] }],
      ...prepared.options,
    }).catch((e: unknown) => e);
    expect(outcome).toMatchObject({ name: "AI_UnsupportedFunctionalityError" });
    expect(posted(fakes.anthropic)).toHaveLength(0);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("moves on from an error body that is not JSON", async () => {
    fakes.deepseek.answer(() => ({ status: 503, raw: "upstream busy", contentType: "text/plain" }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 0 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
  });

  it("fails without moving on when a stream breaks before its first content", async () => {
    const opening = event({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    fakes.deepseek.answer(() => ({ status: 200, raw: opening, contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, ...prepared.options });
    setTimeout(() => void fakes.deepseek.close(), 100);
    expect(await stream.text.then(() => "done", () => "failed")).toBe("failed");
    expect(posted(fakes.deepseek)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("fails a stream that breaks after its content", async () => {
    const content = event({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finish_reason: null }] });
    fakes.deepseek.answer(() => ({ status: 200, raw: content, contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, BOTH, { llmMaxRetries: 2 }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, ...prepared.options });
    setTimeout(() => void fakes.deepseek.close(), 100);
    expect(await stream.text.then(() => "done", () => "failed")).toBe("failed");
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("hands the generation of a stream whose connection is cut after content over exactly once", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(false), contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("meta/llama-x", THINK);
    const ends: unknown[] = [];
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, onFinish: (e) => void ends.push(e.providerMetadata?.breatic), ...prepared.options });
    for await (const text of stream.textStream) {
      if (text !== "") {
        void fakes.openrouter.close();
        break;
      }
    }
    await Promise.resolve(stream.consumeStream()).catch(() => undefined);
    const handed = [...ends.map((e) => (e as { costRef?: { generationId?: string } } | undefined)?.costRef?.generationId), ...prepared.pendingCosts().map((c) => (c as unknown as { lookup: { generationId: string } }).lookup.generationId)];
    expect(handed.filter((id) => id === "gen-1")).toHaveLength(1);
  });

  it("keeps the lookup of a model stream its reader cancels, and closes the upstream stream", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: sse(false), contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, { OPENROUTER_API_KEY: "or" }).llm.prepare("meta/llama-x", THINK);
    const model = prepared.model as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream<{ type: string }> }> };
    const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], providerOptions: prepared.options.providerOptions });
    const reader = stream.getReader();
    for (let part = await reader.read(); !part.done && part.value.type !== "text-delta"; part = await reader.read());
    await reader.cancel("left");
    expect(prepared.pendingCosts()).toEqual([{ state: "pending", lookup: expect.objectContaining({ generationId: "gen-1" }) }]);
  });

  it("stops at once on an in-band error whose form the vendor does not know", async () => {
    const opening = anthropicEvent("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      + anthropicEvent("ping", { type: "ping" })
      + anthropicEvent("error", { type: "error", error: { type: "mystery_error", message: "?" } });
    fakes.anthropic.answer(() => ({ status: 200, raw: opening, contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 2 }).llm.prepare("anthropic/claude-opus-5.5", THINK);
    const stream = streamText({ model: prepared.model, prompt: "hi", onError: () => undefined, ...prepared.options });
    expect(await stream.text.then(() => "done", () => "failed")).toBe("failed");
    expect(posted(fakes.anthropic)).toHaveLength(1);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });
});
