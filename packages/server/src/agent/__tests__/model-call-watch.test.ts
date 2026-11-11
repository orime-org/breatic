// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DomainModule from "@breatic/domain";
import type { Cost, PendingCost } from "@breatic/provider";

const handOffLookups = vi.hoisted(() => vi.fn(async () => undefined));
const costOf = vi.hoisted(() => vi.fn((): Cost => ({ state: "known", usd: 0.01, source: "reported" })));
const servedBy = vi.hoisted(() => vi.fn((): string | undefined => "openrouter"));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, provider: () => ({ llm: { costOf, servedBy } }), handOffLookups };
});

import type { UsageRecorder } from "@breatic/domain";
import { watchModelCalls } from "@server/agent/model-call-watch.js";

const USAGE = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 15,
};

const OPERATION = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };
const CALL = { model: "google/gemini-2.5-flash", description: "Agent chat" };
const HANDED_OFF = { ...CALL, charge: true };
const LOOKUP = { upstream: "openrouter", generationId: "gen-8" };

/**
 * A recorder that keeps the model calls it was told about.
 * @param awaiting - What it says is waiting for the lookup.
 * @returns The recorder.
 */
function recorder(awaiting: { upstream: string; [key: string]: unknown }[] = []): UsageRecorder & { recordModelCall: ReturnType<typeof vi.fn> } {
  return {
    operation: OPERATION,
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    awaitingLookup: () => awaiting,
    settle: vi.fn(async () => 0),
    settleForCharge: vi.fn(async () => ({ credits: 0, writeFailures: [] })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("watching a stream's model calls", () => {
  it("records a call that ended at what provider says it cost, under the upstream that served it", () => {
    const usage = recorder();
    const watch = watchModelCalls(usage, CALL, () => []);
    const metadata = { breatic: { upstream: "openrouter" }, openrouter: { usage: { cost: 0.01 } } };
    watch.callEnded({ usage: USAGE, providerMetadata: metadata });

    expect(costOf).toHaveBeenCalledWith({ model: CALL.model, usage: USAGE, providerMetadata: metadata });
    expect(usage.recordModelCall).toHaveBeenCalledWith({
      source: "model",
      model: CALL.model,
      upstream: "openrouter",
      cost: { state: "known", usd: 0.01, source: "reported" },
    });
    expect(watch.served()).toBe("openrouter");
  });

  it("serves no upstream before any call ended", () => {
    expect(watchModelCalls(recorder(), CALL, () => []).served()).toBeUndefined();
  });

  it("hands off what the recorder could not price, and each call cut off before it ended", async () => {
    const cutOff: PendingCost = { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-9" } };
    const watch = watchModelCalls(recorder([LOOKUP]), CALL, () => [cutOff]);

    await watch.handOff();

    expect(handOffLookups).toHaveBeenCalledWith([LOOKUP, cutOff.lookup], OPERATION, HANDED_OFF);
  });

  it("records a cut-off call nothing can look up as missing, under the upstream that billed it", async () => {
    const usage = recorder();
    const missing: PendingCost = { state: "missing", reason: "the stream was cut before its finish", upstream: "deepseek" };
    const watch = watchModelCalls(usage, CALL, () => [missing]);

    await watch.handOff();

    expect(usage.recordModelCall).toHaveBeenCalledWith({
      source: "model",
      model: CALL.model,
      upstream: "deepseek",
      cost: { state: "missing", reason: "the stream was cut before its finish" },
    });
    expect(watch.served()).toBe("deepseek");
    expect(handOffLookups).not.toHaveBeenCalled();
  });

  it("queues nothing when every cost was in hand", async () => {
    const watch = watchModelCalls(recorder(), CALL, () => []);
    watch.callEnded({ usage: USAGE, providerMetadata: undefined });

    await watch.handOff();

    expect(handOffLookups).not.toHaveBeenCalled();
  });

  it("records a call whose metadata names no upstream as served by nobody", () => {
    servedBy.mockReturnValueOnce(undefined);
    const usage = recorder();
    watchModelCalls(usage, CALL, () => []).callEnded({ usage: USAGE, providerMetadata: undefined });

    expect(usage.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ upstream: "" }));
  });
});
