// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { googleUnderstand } from "../google.js";
import { costedOf, openRouterUnderstand } from "../openrouter.js";

describe("Google's understand answers at the edges of their shape", () => {
  it("reads a part without text as no words, and leaves thoughts out", () => {
    expect(googleUnderstand.read({ candidates: [{ content: { parts: [{}, { text: "seen", thought: true }, { text: "a cat" }] }, finishReason: "STOP" }] })).toEqual({ text: "a cat", finishReason: "stop" });
  });

  it("reads a candidate without content or finish reason as an empty answer that stopped for another reason", () => {
    expect(googleUnderstand.read({ candidates: [{ content: null }] })).toEqual({ text: "", finishReason: "other" });
    expect(googleUnderstand.read({ candidates: [{ content: {} }] })).toEqual({ text: "", finishReason: "other" });
  });

  it("names the blocked and cut answers as the AI SDK does", () => {
    expect(googleUnderstand.read({ candidates: [{ finishReason: "SAFETY" }] })).toMatchObject({ finishReason: "content-filter" });
    expect(googleUnderstand.read({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toMatchObject({ finishReason: "length" });
    expect(googleUnderstand.read({ candidates: [] })).toEqual({ text: "", finishReason: "other" });
    expect(googleUnderstand.read({ promptFeedback: { blockReason: null } })).toEqual({ text: "", finishReason: "other" });
    expect(googleUnderstand.read({ promptFeedback: { blockReason: "OTHER" } })).toEqual({ text: "", finishReason: "content-filter" });
  });

  it("says what is wrong with an answer it cannot read", () => {
    const read = googleUnderstand.read({ candidates: "nope" });
    expect(read).toEqual({ unreadable: expect.stringContaining("candidates") });
  });

  it("counts each usage field it is not given as none, thoughts within the output", () => {
    expect(googleUnderstand.billing({ usageMetadata: { promptTokenCount: 0 } }).usage).toMatchObject({ inputTokens: 0, outputTokens: 0, outputTokenDetails: { reasoningTokens: 0 } });
    expect(googleUnderstand.billing({ usageMetadata: { candidatesTokenCount: 2 } }).usage).toMatchObject({ inputTokens: 0, outputTokens: 2, outputTokenDetails: { reasoningTokens: 0 } });
    expect(googleUnderstand.billing({ usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 3 } }).usage)
      .toMatchObject({ inputTokens: 10, inputTokenDetails: { cacheReadTokens: 4 }, outputTokens: 9, outputTokenDetails: { reasoningTokens: 3 } });
  });

  it("costs an answer without usage it can read as missing", () => {
    for (const body of [null, {}, { usageMetadata: {} }, { usageMetadata: { totalTokenCount: 40 } }, { usageMetadata: { promptTokenCount: "ten" } }]) {
      expect(googleUnderstand.billing(body)).toMatchObject({ missing: expect.any(String) });
    }
  });
});

describe("OpenRouter's understand answers at the edges of their shape", () => {
  it("reads a choice without a message or finish reason as an empty answer that stopped for another reason", () => {
    expect(openRouterUnderstand.read({ choices: [{ message: null }] })).toEqual({ text: "", finishReason: "other" });
    expect(openRouterUnderstand.read({ choices: [{ message: { content: "a cat" }, finish_reason: "unheard_of" }] })).toEqual({ text: "a cat", finishReason: "other" });
    expect(openRouterUnderstand.read({ choices: [{ message: { content: "a cat" }, finish_reason: "stop" }] })).toEqual({ text: "a cat", finishReason: "stop" });
  });

  it("hands back an error sitting at the top of the answer or on an empty choice, and not one beside words", () => {
    expect(openRouterUnderstand.read({ error: { code: 502 } })).toEqual({ error: { code: 502 } });
    expect(openRouterUnderstand.read({ error: null, choices: [{ message: { content: "" }, error: { code: 500 } }] })).toEqual({ error: { code: 500 } });
    expect(openRouterUnderstand.read({ choices: [{ message: { content: "" }, error: null }] })).toEqual({ text: "", finishReason: "other" });
    expect(openRouterUnderstand.read({ choices: [{ message: { content: "partial" }, error: { code: 500 }, finish_reason: "error" }] })).toEqual({ text: "partial", finishReason: "error" });
  });

  it("says what is wrong with an answer it cannot read", () => {
    expect(openRouterUnderstand.read({ choices: "nope" })).toEqual({ unreadable: expect.stringContaining("choices") });
    expect(openRouterUnderstand.read({ choices: [] })).toEqual({ unreadable: "OpenRouter's answer has no choice" });
  });

  it("counts each usage field it is not given as none, and carries the reported cost and the generation id", () => {
    const none = openRouterUnderstand.billing({ id: "gen-1", usage: {} });
    expect(none).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 }, providerMetadata: {}, generationId: "gen-1" });
    const full = openRouterUnderstand.billing({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } });
    expect(full).toMatchObject({ usage: { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 4 }, outputTokens: 5, outputTokenDetails: { reasoningTokens: 2 } }, providerMetadata: { openrouter: { usage: { cost: 0.002 } } } });
    expect(openRouterUnderstand.billing(undefined)).toMatchObject({ usage: { inputTokens: 0 }, providerMetadata: {} });
  });

  it("reads an answer whose id or usage it cannot read as having neither", () => {
    expect(costedOf({ id: 5, usage: "x" })).toEqual({ id: undefined, usage: undefined });
    expect(costedOf("not an object")).toEqual({});
  });
});
