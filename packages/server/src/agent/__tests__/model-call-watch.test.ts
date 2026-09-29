// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DomainModule from "@breatic/domain";

const handOffLookups = vi.hoisted(() => vi.fn(async () => undefined));
const provider = vi.hoisted(() => ({ name: "openrouter" }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, resolveProvider: () => provider.name, handOffLookups };
});

import type { UsageRecorder } from "@breatic/domain";
import { watchModelCalls } from "@server/agent/model-call-watch.js";

const USAGE = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { reasoningTokens: 0 },
};

const OPERATION = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };
const CALL = { model: "google/gemini-2.5-flash", description: "Agent chat" };

/**
 * A recorder that keeps the model calls it was told about.
 * @param awaiting - What it says is waiting for the lookup.
 * @returns The recorder.
 */
function recorder(awaiting: string[] = []): UsageRecorder & { recordModelCall: ReturnType<typeof vi.fn> } {
  return {
    operation: OPERATION,
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    awaitingLookup: () => awaiting,
    settle: vi.fn(async () => 0),
  };
}

beforeEach(() => {
  handOffLookups.mockClear();
  provider.name = "openrouter";
});

describe("watching a stream's model calls", () => {
  it("asks the stream for raw chunks", () => {
    const watch = watchModelCalls(recorder(), CALL);
    expect(watch.streamOptions.includeRawChunks).toBe(true);
  });

  it("records a call that ended under the generation id it ended with", () => {
    const usage = recorder();
    const watch = watchModelCalls(usage, CALL);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    const metadata = { openrouter: { usage: { cost: 0.01 } } };
    watch.callEnded({ responseId: "gen-7", usage: USAGE, providerMetadata: metadata });

    expect(usage.recordModelCall).toHaveBeenCalledWith({
      source: "model",
      model: CALL.model,
      provider: "openrouter",
      usage: USAGE,
      providerMetadata: metadata,
      generationId: "gen-7",
    });
  });

  // A stream whose first chunk is an in-band error never passes the id on to
  // the SDK, so the end event carries the SDK's own id.
  it("records a call under the id its chunks carried when the end carries the SDK's own", () => {
    const usage = recorder();
    const watch = watchModelCalls(usage, CALL);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-8", error: {} } } });
    watch.callEnded({ responseId: "aitxt-1", usage: USAGE, providerMetadata: undefined });

    expect(usage.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-8" }));
  });

  it("hands off what the recorder could not price, and a call cut off before it ended", async () => {
    const watch = watchModelCalls(recorder(["gen-8"]), CALL);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-9" } } });

    await watch.handOff();

    expect(handOffLookups).toHaveBeenCalledWith(["gen-8", "gen-9"], OPERATION, CALL);
  });

  it("does not hand off a call that ended, when its last chunk arrives afterwards", async () => {
    const watch = watchModelCalls(recorder(), CALL);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    watch.callEnded({ responseId: "gen-7", usage: USAGE, providerMetadata: undefined });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });

    await watch.handOff();

    expect(handOffLookups).toHaveBeenCalledWith([], OPERATION, CALL);
  });

  it("hands off nothing for a model reached directly", async () => {
    provider.name = "deepseek";
    const usage = recorder();
    const watch = watchModelCalls(usage, { model: "deepseek/deepseek-v4-pro", description: "Agent chat" });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    watch.callEnded({ responseId: "r-1", usage: USAGE, providerMetadata: undefined });

    await watch.handOff();

    expect(usage.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek/deepseek-v4-pro", provider: "deepseek" }),
    );
    expect(handOffLookups).not.toHaveBeenCalled();
  });

  it("ignores chunks that are not raw", async () => {
    const watch = watchModelCalls(recorder(), CALL);
    watch.streamOptions.onChunk({ chunk: { type: "text-delta" } });

    await watch.handOff();

    expect(handOffLookups).toHaveBeenCalledWith([], OPERATION, CALL);
  });
});
