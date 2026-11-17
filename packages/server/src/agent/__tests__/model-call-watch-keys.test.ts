// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stream's calls whose cost is not in hand, on an account's key (inner#1953): the later lookup is handed the key
 * row's id, so it asks with that key and no other, and is never charged; on the deployment's keys it is charged as
 * before and names no key row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DomainModule from "@breatic/domain";
import type { PendingCost } from "@breatic/provider";

const handOffLookups = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, provider: () => ({ llm: { costOf: vi.fn(), servedBy: vi.fn(() => "openrouter") } }), handOffLookups };
});

import type { UsageRecorder } from "@breatic/domain";
import { watchModelCalls } from "@server/agent/model-call-watch.js";

const OPERATION = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };
const CUT_OFF: PendingCost = { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-9" } };

/**
 * A recorder with nothing of its own waiting.
 * @returns The recorder.
 */
function recorder(): UsageRecorder {
  return {
    operation: OPERATION,
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    awaitingLookup: () => [],
    settle: vi.fn(async () => 0),
    settleForCharge: vi.fn(async () => ({ credits: 0, writeFailures: [] })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handing off a cut-off call's lookup", () => {
  it("names the account's key row and asks for no charge", async () => {
    const watch = watchModelCalls(recorder(), { model: "m", description: "Agent chat", keyId: "key-1" } as never, () => [CUT_OFF]);

    await watch.handOff();

    expect(handOffLookups).toHaveBeenCalledWith(expect.any(Array), OPERATION, { description: "Agent chat", charge: false, keyId: "key-1" });
  });

  it("is charged and names no key row on the deployment's keys", async () => {
    const watch = watchModelCalls(recorder(), { model: "m", description: "Agent chat", keyId: null } as never, () => [CUT_OFF]);

    await watch.handOff();

    const options = (handOffLookups.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options).toMatchObject({ charge: true });
    expect(options.keyId ?? null).toBeNull();
  });
});
