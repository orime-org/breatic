// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A consolidation call the model turns away as too long is halved and sent
 * again, not given up (inner#1567, design 6.4.1, U1, V2, V4).
 *
 * How many tokens the window is cannot be known before it is sent, so the
 * consolidator trusts the provider's answer the way the main request does. On
 * an overflow it keeps the older half of the whole turns and moves the new
 * watermark back to the last one kept; with one turn left it halves that
 * turn's whole text. After `consolidation_shrink_attempts` halvings it stops
 * and takes the existing discard: the watermark passes the window, nothing is
 * written. A rejected call carries no usage and is not charged; the call that
 * succeeds is charged once, under the usual refKey.
 *
 * Halving whole turns needs the turns: the window arrives as ordered
 * `{ turnIndex, messages }` groups, because a resumed segment puts a second
 * user message inside one turn and a boundary cannot be read off the roles.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import { h2, h1AfterRetry, rateLimited } from "../helpers/overflow-turn.js";

const generateTextRetry = vi.fn();
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);
const commitConsolidation = vi.fn<(...args: unknown[]) => Promise<"written" | "superseded">>();
const discardConsolidation = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const buildContext = vi.fn(async () => ({ projectMemory: "", conversationMemory: "" }));

const SHRINK_ATTEMPTS = 3;

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      consolidation_shrink_attempts: SHRINK_ATTEMPTS,
    }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...base,
    generateTextRetry,
    getModel: (id: string) => ({ modelId: id }),
    resolveProvider: () => "test",
    callOptionsFor: actual.callOptionsFor,
    creditLotService: { chargeOnceForGeneration },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, memoryService: { commitConsolidation, discardConsolidation, buildContext } };
});

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");
const { logger } = await import("@breatic/core");

const CONVERSATION = "22222222-2222-4222-8222-222222222222";

/** What the model answers when the window fits. Settles to 400 credits in the recorder double. */
const GOOD_ANSWER = {
  text: JSON.stringify({ conversationUpdate: "folded", projectUpdate: null, historyEntry: "folded" }),
  usage: {
    inputTokens: 150,
    inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 0 },
    outputTokens: 250,
    outputTokenDetails: { reasoningTokens: 0 },
    totalTokens: 400,
  },
  providerMetadata: undefined,
  response: { id: "gen-7" },
};

/** Turn 5's reply: long, with a head and a tail to tell its halves apart. */
const LONG_REPLY = `TURN-5-HEAD ${"x".repeat(20_000)} TURN-5-TAIL`;

/**
 * One turn as the consolidator is handed it.
 * @param turnIndex - The turn.
 * @returns Its group.
 */
function group(turnIndex: number): { turnIndex: number; messages: ModelMessage[] } {
  if (turnIndex === 6) {
    // A turn that stopped at a questionnaire and resumed: two user messages.
    return {
      turnIndex,
      messages: [
        { role: "user", content: "TURN-6-ASKED" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "ask-6", toolName: "ask_user", input: { questions: [] } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "ask-6", toolName: "ask_user", output: { type: "json", value: { answers: [] } } }] },
        { role: "user", content: "TURN-6-RESUMED" },
        { role: "assistant", content: "TURN-6-SAID" },
      ],
    };
  }
  return {
    turnIndex,
    messages: [
      { role: "user", content: `TURN-${String(turnIndex)}-ASKED` },
      { role: "assistant", content: turnIndex === 5 ? LONG_REPLY : `TURN-${String(turnIndex)}-SAID` },
    ],
  };
}

/**
 * Fold turns 5 to 8, the watermark standing at 4.
 * @returns How the fold ended.
 */
async function consolidate(): Promise<string> {
  return consolidateWindow({
    userId: "11111111-1111-4111-8111-111111111111",
    conversationId: CONVERSATION,
    projectId: "33333333-3333-4333-8333-333333333333",
    turns: [5, 6, 7, 8].map(group),
    watermarkBefore: 4,
    newWatermark: 8,
  } as Parameters<typeof consolidateWindow>[0]);
}

/**
 * The prompt the consolidation model was handed on one call.
 * @param n - Which call, from 0.
 * @returns The prompt text.
 */
function promptOf(n: number): string {
  return String((generateTextRetry.mock.calls[n]?.[0] as { messages: Array<{ content: string }> } | undefined)?.messages[0]?.content);
}

beforeEach(() => {
  vi.clearAllMocks();
  generateTextRetry.mockReset();
  commitConsolidation.mockResolvedValue("written");
  discardConsolidation.mockResolvedValue(true);
  chargeOnceForGeneration.mockResolvedValue(null);
});

describe("a consolidation call turned away as too long", () => {
  it("is sent again with the older half of the whole turns, and the watermark moves back to match", async () => {
    generateTextRetry.mockRejectedValueOnce(h2()).mockResolvedValueOnce(GOOD_ANSWER);

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(generateTextRetry).toHaveBeenCalledTimes(2);
    expect(promptOf(0)).toContain("TURN-8-SAID");
    for (const kept of ["TURN-5-ASKED", "TURN-5-HEAD", "TURN-6-ASKED", "TURN-6-RESUMED", "TURN-6-SAID"]) {
      expect(promptOf(1)).toContain(kept);
    }
    expect(promptOf(1)).not.toContain("TURN-7");
    expect(promptOf(1)).not.toContain("TURN-8");
    expect(commitConsolidation).toHaveBeenCalledTimes(1);
    expect(commitConsolidation.mock.calls[0]?.[0]).toMatchObject({ newWatermark: 6 });
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("halves the whole text of the one turn left once there is a single turn", async () => {
    generateTextRetry
      .mockRejectedValueOnce(h2())
      .mockRejectedValueOnce(h2())
      .mockRejectedValueOnce(h2())
      .mockResolvedValueOnce(GOOD_ANSWER);

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(generateTextRetry).toHaveBeenCalledTimes(4);
    // Four turns, two, one, then the one turn's text halved.
    expect(promptOf(1)).toContain("TURN-6-SAID");
    expect(promptOf(2)).toContain("TURN-5-TAIL");
    expect(promptOf(2)).not.toContain("TURN-6");
    expect(promptOf(3)).toContain("TURN-5-ASKED");
    expect(promptOf(3)).toContain("TURN-5-HEAD");
    expect(promptOf(3)).not.toContain("TURN-5-TAIL");
    expect(promptOf(3).length).toBeLessThan(promptOf(2).length - 9_000);
    expect(commitConsolidation.mock.calls[0]?.[0]).toMatchObject({ newWatermark: 5 });
  });

  it("is discarded after consolidation_shrink_attempts halvings: the watermark passes the window and nothing is written or charged", async () => {
    generateTextRetry.mockRejectedValue(h2());

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(generateTextRetry).toHaveBeenCalledTimes(1 + SHRINK_ATTEMPTS);
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 8);
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it("is still halved when the SDK wrapped the overflow in a RetryError", async () => {
    generateTextRetry.mockRejectedValueOnce(h1AfterRetry()).mockResolvedValueOnce(GOOD_ANSWER);

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(generateTextRetry).toHaveBeenCalledTimes(2);
    expect(discardConsolidation).not.toHaveBeenCalled();
    expect(commitConsolidation.mock.calls[0]?.[0]).toMatchObject({ newWatermark: 6 });
  });

  it("is told apart from any other failure, which still discards at once", async () => {
    generateTextRetry.mockRejectedValueOnce(rateLimited());
    const rateLimitOutcome = await consolidate();
    const rateLimitCalls = generateTextRetry.mock.calls.length;

    vi.clearAllMocks();
    generateTextRetry.mockReset();
    commitConsolidation.mockResolvedValue("written");
    discardConsolidation.mockResolvedValue(true);
    generateTextRetry.mockRejectedValueOnce(h2()).mockResolvedValueOnce(GOOD_ANSWER);
    const overflowOutcome = await consolidate();

    expect(rateLimitOutcome).toBe("discarded");
    expect(rateLimitCalls).toBe(1);
    expect(overflowOutcome).toBe("written");
    expect(generateTextRetry).toHaveBeenCalledTimes(2);
  });

  it("charges only the call that succeeded, once, under the window's refKey", async () => {
    generateTextRetry.mockRejectedValueOnce(h2()).mockRejectedValueOnce(h2()).mockResolvedValueOnce(GOOD_ANSWER);

    await consolidate();

    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe(`consolidate:${CONVERSATION}:4`);
    expect(chargeOnceForGeneration.mock.calls[0]?.[1]).toMatchObject({ amount: 400 });
  });
});
