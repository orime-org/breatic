// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DomainModule from "@breatic/domain";

const enqueueUsageLookup = vi.hoisted(() => vi.fn(async () => undefined));
const provider = vi.hoisted(() => ({ name: "openrouter" }));

vi.mock("@server/agent/usage-lookup-queue.js", () => ({ enqueueUsageLookup }));
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, resolveProvider: () => provider.name };
});

import type { UsageRecorder } from "@breatic/domain";
import { watchModelCalls } from "@server/agent/interrupted-call.js";

const USAGE = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { reasoningTokens: 0 },
};

/**
 * A recorder that keeps the model calls it was told about.
 * @returns The recorder.
 */
function recorder(): UsageRecorder & { recordModelCall: ReturnType<typeof vi.fn> } {
  return {
    operation: { operationKey: "turn:c1:2", feature: "chat_turn", actorUserId: "u-1", projectId: "p-1" },
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    settle: vi.fn(async () => 0),
  };
}

const HANDED_OFF = {
  model: "google/gemini-2.5-flash",
  operationKey: "turn:c1:2",
  feature: "chat_turn",
  source: "model",
  actorUserId: "u-1",
  projectId: "p-1",
  description: "Agent chat",
};

beforeEach(() => {
  enqueueUsageLookup.mockClear();
  provider.name = "openrouter";
});

describe("watching a stream's model calls", () => {
  it("asks the stream for raw chunks", () => {
    const watch = watchModelCalls(recorder(), { model: "google/gemini-2.5-flash", description: "Agent chat" });
    expect(watch.streamOptions.includeRawChunks).toBe(true);
  });

  it("records a call that ended with its cost, and hands nothing off", async () => {
    const usage = recorder();
    const watch = watchModelCalls(usage, { model: "google/gemini-2.5-flash", description: "Agent chat" });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    const metadata = { openrouter: { usage: { cost: 0.01 } } };
    watch.callEnded({ responseId: "gen-7", usage: USAGE, providerMetadata: metadata });
    // A slow reader receives the call's last raw chunk after it ended.
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });

    await watch.handOff();

    expect(usage.recordModelCall).toHaveBeenCalledWith({
      source: "model",
      model: "google/gemini-2.5-flash",
      provider: "openrouter",
      usage: USAGE,
      providerMetadata: metadata,
    });
    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });

  it("hands an OpenRouter call that ended without a cost to the lookup", async () => {
    const usage = recorder();
    const watch = watchModelCalls(usage, { model: "google/gemini-2.5-flash", description: "Agent chat" });
    watch.callEnded({ responseId: "gen-8", usage: USAGE, providerMetadata: undefined });

    await watch.handOff();

    expect(usage.recordModelCall).not.toHaveBeenCalled();
    expect(enqueueUsageLookup).toHaveBeenCalledWith({ ...HANDED_OFF, generationId: "gen-8" });
  });

  it("hands a call cut off before it ended to the lookup", async () => {
    const watch = watchModelCalls(recorder(), { model: "google/gemini-2.5-flash", description: "Agent chat" });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-9" } } });

    await watch.handOff();

    expect(enqueueUsageLookup).toHaveBeenCalledWith({ ...HANDED_OFF, generationId: "gen-9" });
  });

  it("records a model reached directly at the price table, and hands nothing off", async () => {
    provider.name = "deepseek";
    const usage = recorder();
    const watch = watchModelCalls(usage, { model: "deepseek/deepseek-v4-pro", description: "Agent chat" });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    watch.callEnded({ responseId: "r-1", usage: USAGE, providerMetadata: undefined });

    await watch.handOff();

    expect(usage.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek/deepseek-v4-pro", provider: "deepseek" }),
    );
    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });

  it("ignores chunks that are not raw", async () => {
    const watch = watchModelCalls(recorder(), { model: "google/gemini-2.5-flash", description: "Agent chat" });
    watch.streamOptions.onChunk({ chunk: { type: "text-delta" } });

    await watch.handOff();

    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });
});
