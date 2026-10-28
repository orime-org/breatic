// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { generateText, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_REPLY, llmProvider, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

// Every model call an upstream billed reaches the caller once: on its finish as costRef or a
// reported cost, or in pendingCosts() (design 3.5, 5.5, DD 33).

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopFakes(fakes);
});

const THINK = { thinking: true, cache: false } as const;
const OR = { OPENROUTER_API_KEY: "or" };

/**
 * One server-sent chunk.
 * @param body - The chunk.
 * @returns Its event line.
 */
const event = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

/**
 * A chat completion chunk of one generation.
 * @param id - The generation id.
 * @param delta - What it adds.
 * @param extra - Other fields.
 * @returns The event line.
 */
const chunk = (id: string, delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  event({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...extra });

/**
 * A whole stream of one generation that reports no cost, so its finish carries a lookup.
 * @param id - The generation id.
 * @returns The raw stream.
 */
const finished = (id: string): string =>
  chunk(id, { role: "assistant", content: "he" })
  + event({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  + "data: [DONE]\n\n";

const pending = (generationId: string): unknown => ({ state: "pending", lookup: { upstream: "openrouter", generationId } });

describe("a stream whose first chunk is an in-band error (DD 33)", () => {
  it("hands the errored generation to pendingCosts, beside the one that served", async () => {
    let n = 0;
    fakes.openrouter.answer(() => ({
      status: 200,
      raw: ++n === 1 ? event({ id: "gen-err", object: "chat.completion.chunk", error: { code: 502, message: "Provider returned error" } }) : finished("gen-ok"),
      contentType: "text/event-stream",
    }));
    const prepared = llmProvider(fakes, OR, { llmMaxRetries: 1 }).llm.prepare("meta/llama-x", THINK);
    const ends: unknown[] = [];
    const stream = streamText({ model: prepared.model, prompt: "hi", ...prepared.options, onFinish: (e) => void ends.push(e.providerMetadata?.breatic) });
    await stream.consumeStream();
    expect(posted(fakes.openrouter)).toHaveLength(2);
    expect(ends).toEqual([expect.objectContaining({ costRef: { upstream: "openrouter", generationId: "gen-ok" } })]);
    expect(prepared.pendingCosts()).toEqual([pending("gen-err")]);
  });
});

describe("a stream that named its generation and then failed before content", () => {
  it("keeps that generation in pendingCosts once the retry finishes", async () => {
    let n = 0;
    fakes.openrouter.answer(() => ({
      status: 200,
      raw: ++n === 1 ? chunk("gen-a", { role: "assistant", content: "" }) + event({ id: "gen-a", error: { code: 502, message: "Provider returned error" } }) : finished("gen-b"),
      contentType: "text/event-stream",
    }));
    const prepared = llmProvider(fakes, OR, { llmMaxRetries: 1 }).llm.prepare("meta/llama-x", THINK);
    await streamText({ model: prepared.model, prompt: "hi", ...prepared.options }).consumeStream();
    expect(prepared.pendingCosts()).toEqual([pending("gen-a")]);
  });
});

describe("a whole answer of 200 whose body is an error (DD 33)", () => {
  it("hands the generation it names to pendingCosts when the call moves past it", async () => {
    let n = 0;
    fakes.openrouter.answer(() => (++n === 1 ? { status: 200, body: { id: "gen-whole", error: { code: 502, message: "Provider returned error" } } } : { status: 200, body: CHAT_REPLY }));
    const prepared = llmProvider(fakes, OR, { llmMaxRetries: 1 }).llm.prepare("meta/llama-x", THINK);
    const result = await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(result.text).toBe("ok");
    expect(prepared.pendingCosts()).toEqual([pending("gen-whole")]);
  });

  it("hands it over when the call stops on it", async () => {
    fakes.openrouter.answer(() => ({ status: 200, body: { id: "gen-stop", error: { code: 400, message: "Provider returned error" } } }));
    const prepared = llmProvider(fakes, OR, { llmMaxRetries: 1 }).llm.prepare("meta/llama-x", THINK);
    await expect(generateText({ model: prepared.model, prompt: "hi", ...prepared.options })).rejects.toThrow();
    expect(prepared.pendingCosts()).toEqual([pending("gen-stop")]);
  });
});

describe("a direct vendor's stream cut before its finish (DD 33)", () => {
  const opening = chunk("ds-1", { role: "assistant", content: "he" });

  it("hands one missing cost to pendingCosts", async () => {
    fakes.deepseek.answer(() => ({ status: 200, raw: opening, contentType: "text/event-stream", hold: true }));
    const prepared = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    const stop = new AbortController();
    const stream = streamText({ model: prepared.model, prompt: "hi", abortSignal: stop.signal, ...prepared.options });
    for await (const text of stream.textStream) {
      if (text !== "") break;
    }
    stop.abort();
    await Promise.resolve(stream.consumeStream()).catch(() => undefined);
    expect(prepared.pendingCosts()).toEqual([expect.objectContaining({ state: "missing" })]);
    fakes.deepseek.release();
  });

  it("hands nothing to pendingCosts once the stream finished", async () => {
    const prepared = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds" }).llm.prepare("deepseek/deepseek-v4-pro", THINK);
    fakes.deepseek.answer(() => ({ status: 200, raw: finished("ds-1"), contentType: "text/event-stream" }));
    await streamText({ model: prepared.model, prompt: "hi", ...prepared.options }).consumeStream();
    expect(prepared.pendingCosts()).toEqual([]);
  });
});

describe("a stop that lands around the finish (DD 33)", () => {
  it.each(["text-delta", "finish-step", "finish"])("hands the generation over exactly once when the caller stops at its %s", async (at) => {
    fakes.openrouter.answer(() => ({ status: 200, raw: finished("gen-1"), contentType: "text/event-stream" }));
    const prepared = llmProvider(fakes, OR).llm.prepare("meta/llama-x", THINK);
    const stop = new AbortController();
    const ends: unknown[] = [];
    const stream = streamText({
      model: prepared.model,
      prompt: "hi",
      abortSignal: stop.signal,
      ...prepared.options,
      onError: () => undefined,
      onLanguageModelCallEnd: (e) => void ends.push(e.providerMetadata?.breatic),
    });
    try {
      for await (const part of stream.fullStream) {
        if (part.type === at) stop.abort();
      }
    } catch {
      // the stop ends the read
    }
    const handedOver = ends.filter((e) => (e as { costRef?: { generationId?: string } } | undefined)?.costRef?.generationId === "gen-1").length;
    const stillPending = prepared.pendingCosts().filter((c) => c.state === "pending" && c.lookup.generationId === "gen-1").length;
    expect(handedOver + stillPending).toBe(1);
  });
});
