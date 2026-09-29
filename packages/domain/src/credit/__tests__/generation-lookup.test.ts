// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();
const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createQueue: () => ({ add: queueAdd }),
  getAgentConfig: () => ({ usage_lookup_delay_ms: 30_000, usage_lookup_attempts: 6 }),
}));

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

import { handOffLookups, lookupGeneration } from "@domain/credit/generation-lookup.js";

beforeEach(() => {
  httpRequestMock.mockReset();
  queueAdd.mockClear();
});

describe("asking OpenRouter what a generation cost", () => {
  it("reads total_cost and the native token buckets off the answer", async () => {
    httpRequestMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "gen-1",
            total_cost: 0.0042,
            native_tokens_prompt: 100,
            native_tokens_cached: 40,
            native_tokens_completion: 20,
            native_tokens_reasoning: 5,
          },
        }),
        { status: 200 },
      ),
    );
    await expect(lookupGeneration("gen-1", "key")).resolves.toEqual({
      costUsd: 0.0042,
      tokens: { input: 100, cachedInput: 40, output: 20, reasoning: 5 },
    });
    const [url, init] = httpRequestMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer key" });
  });

  it("answers undefined while the generation is not there yet", async () => {
    httpRequestMock.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(lookupGeneration("gen-1", "key")).resolves.toBeUndefined();
  });

  it("throws on any other refusal", async () => {
    httpRequestMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(lookupGeneration("gen-1", "key")).rejects.toThrow("401");
  });
});

describe("handing calls to the later lookup", () => {
  const operation = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };

  it("queues one delayed job per generation, keyed by its id", async () => {
    await handOffLookups(["gen-1", "gen-2"], operation, { model: "google/gemini-2.5-flash", description: "Agent chat" });
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(queueAdd).toHaveBeenCalledWith(
      "lookup",
      { ...operation, generationId: "gen-1", model: "google/gemini-2.5-flash", source: "model", description: "Agent chat" },
      expect.objectContaining({ jobId: "gen-1", delay: 30_000, attempts: 6 }),
    );
  });

  it("queues nothing when there is nothing to look up", async () => {
    await handOffLookups([], operation, { model: "google/gemini-2.5-flash", description: "Agent chat" });
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
