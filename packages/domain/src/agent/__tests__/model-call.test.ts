// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import { getAgentConfig } from "@breatic/core";

/**
 * model-call wrapper (#1625 Slice 3). All LLM calls route through
 * generateTextRetry / streamTextRetry so the retry budget (maxRetries) is set
 * from config in ONE place instead of each call site silently inheriting the
 * AI SDK default. Mock `ai` to capture the args the wrapper forwards.
 */
const generateTextMock = vi.fn(
  async (args: Record<string, unknown>) => ({ text: "ok", args }),
);
const streamTextMock = vi.fn(
  (args: Record<string, unknown>) => ({ streamed: true, args }),
);

vi.mock("ai", () => ({
  generateText: (a: Record<string, unknown>) => generateTextMock(a),
  streamText: (a: Record<string, unknown>) => streamTextMock(a),
}));

import { generateTextRetry, streamTextRetry } from "@domain/agent/model-call.js";

describe("model-call wrapper (#1625 Slice 3)", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    streamTextMock.mockClear();
  });

  it("generateTextRetry injects maxRetries from agent config", async () => {
    // Pin the shipped default so the injection assertions are NOT vacuous
    // (a missing config field would make both sides undefined).
    expect(getAgentConfig().llm_max_retries).toBe(2);
    await generateTextRetry({ model: "m" as never, prompt: "hi" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      maxRetries: getAgentConfig().llm_max_retries,
    });
  });

  it("an explicit maxRetries at the call site overrides the config default", async () => {
    await generateTextRetry({ model: "m" as never, prompt: "hi", maxRetries: 5 });
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxRetries: 5 });
  });

  it("streamTextRetry injects maxRetries and returns the stream result unchanged", () => {
    const r = streamTextRetry({ model: "m" as never, prompt: "hi" });
    expect(streamTextMock.mock.calls[0]![0]).toMatchObject({
      maxRetries: getAgentConfig().llm_max_retries,
    });
    expect(r).toMatchObject({ streamed: true });
  });
});
