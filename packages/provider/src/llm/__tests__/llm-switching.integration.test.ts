// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { generateText, stepCountIs, streamText, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { NoUpstreamAvailable } from "../../errors.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { CHAT_REPLY, llmProvider, posted, startFakes, stopFakes, vendorReply, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
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
