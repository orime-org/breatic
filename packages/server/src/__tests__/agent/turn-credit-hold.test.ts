// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A chat turn holds what its next model call may cost before it makes it, and
 * settles what it actually spent at the end (inner#1611).
 *
 * The hold before each call is what the turn has already spent, plus what its
 * calls still waiting for a price may cost, plus the dearest the next call can
 * be. A turn whose hold cannot grow stops.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  env: { PAYMENT_ENABLED: true, CREDIT_MULTIPLIER: 1 },
  resizeHold: vi.fn(),
  extendHold: vi.fn(),
  placeHold: vi.fn(),
  releaseHold: vi.fn(),
  chargeOnceForGeneration: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: h.env,
  getAgentConfig: () => ({ credit_hold_ttl_ms: 1_800_000, max_output_tokens: 1_000 }),
  getUsagePricing: () => ({
    models: { "m/one": { input_cache_hit_per_mtok: 1, input_cache_miss_per_mtok: 10, output_per_mtok: 100 } },
    services: { brave_web_search: { per_request: 0 }, brave_image_search: { per_request: 0 } },
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
}));

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  creditHoldService: {
    resizeHold: h.resizeHold,
    extendHold: h.extendHold,
    placeHold: h.placeHold,
    releaseHold: h.releaseHold,
  },
  creditLotService: { chargeOnceForGeneration: h.chargeOnceForGeneration },
}));

const { openTurnHold, settleHeldUsage } = await import("@server/agent/turn-credit-hold.js");

/**
 * A recorder with a fixed spend and calls waiting for a price.
 * @param spent - Credits recorded so far.
 * @param awaiting - Generation ids still waiting for a price.
 * @param settles - What settling comes to.
 * @returns The recorder.
 */
function recorder(spent: number, awaiting: string[] = [], settles = spent) {
  return {
    operation: { operationKey: "turn:c1:3", feature: "chat_turn" as const, actorUserId: "u1", projectId: "p1" },
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    awaitingLookup: () => awaiting,
    spent: () => spent,
    settle: vi.fn(async () => settles),
  };
}

/** One call of model m/one with 1000 input tokens: 1000*10/1e6 + 1000*100/1e6 dollars = 0.11, in credits 11. */
const ONE_CALL = 11;

beforeEach(() => {
  vi.clearAllMocks();
  h.env.PAYMENT_ENABLED = true;
  h.resizeHold.mockResolvedValue(true);
  h.extendHold.mockResolvedValue(true);
  h.placeHold.mockResolvedValue(undefined);
  h.releaseHold.mockResolvedValue(undefined);
  h.chargeOnceForGeneration.mockResolvedValue({ billed: true, charged: 4, shortfall: 0, studioId: "s", lotIds: [] });
});

describe("openTurnHold", () => {
  it("holds the dearest the next call can be, on top of what the turn has spent", async () => {
    const hold = openTurnHold({ projectId: "p1", userId: "u1", key: "turn:c1:3", usage: recorder(3), model: "m/one", cacheTtl: null });
    expect(await hold.coverNextCall(1_000)).toBe(true);
    expect(h.resizeHold).toHaveBeenCalledWith({
      projectId: "p1",
      actorUserId: "u1",
      referenceId: "turn:c1:3",
      amount: 3 + ONE_CALL,
      ttlMs: 1_800_000,
    });
    expect(hold.exhausted).toBe(false);
  });

  it("keeps calls still waiting for a price held at the dearest call seen", async () => {
    const hold = openTurnHold({ projectId: "p1", userId: "u1", key: "k", usage: recorder(0, ["g1", "g2"]), model: "m/one", cacheTtl: null });
    await hold.coverNextCall(1_000);
    expect(h.resizeHold).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 2 * ONE_CALL + ONE_CALL }));
    expect(hold.lookupHoldCredits()).toBe(ONE_CALL);
  });

  it("says the turn is out of credits once the hold cannot grow", async () => {
    h.resizeHold.mockResolvedValue(false);
    const hold = openTurnHold({ projectId: "p1", userId: "u1", key: "k", usage: recorder(0), model: "m/one", cacheTtl: null });
    expect(await hold.coverNextCall(1_000)).toBe(false);
    expect(hold.exhausted).toBe(true);
  });

  it("lets a paying tool grow the hold", async () => {
    const hold = openTurnHold({ projectId: "p1", userId: "u1", key: "k", usage: recorder(0), model: "m/one", cacheTtl: null });
    expect(await hold.extend(2)).toBe(true);
    expect(h.extendHold).toHaveBeenCalledWith({ referenceId: "k", delta: 2, ttlMs: 1_800_000 });
  });

  it("holds nothing and prices nothing while payments are off", async () => {
    h.env.PAYMENT_ENABLED = false;
    const hold = openTurnHold({ projectId: "p1", userId: "u1", key: "k", usage: recorder(0), model: "unpriced/model", cacheTtl: "1h" });
    expect(await hold.coverNextCall(1_000_000)).toBe(true);
    expect(await hold.extend(2)).toBe(true);
    expect(h.resizeHold).not.toHaveBeenCalled();
    expect(h.extendHold).not.toHaveBeenCalled();
  });
});

describe("settleHeldUsage", () => {
  const CHARGE = { projectId: "p1", actorUserId: "u1", description: "Agent chat", model: "m/one", provider: "openrouter" };

  it("holds each call still waiting for a price, hands them off, then charges and releases in one", async () => {
    const order: string[] = [];
    h.placeHold.mockImplementation(async () => void order.push("place"));
    const handOff = vi.fn(async () => void order.push("handOff"));
    const result = await settleHeldUsage({
      usage: recorder(4, ["g1"]),
      holdKey: "turn:c1:3",
      chargeKey: "turn:c1:3",
      lookupHoldCredits: 7,
      handOff,
      charge: CHARGE,
    });
    expect(order).toEqual(["place", "handOff"]);
    expect(h.placeHold).toHaveBeenCalledWith({ projectId: "p1", actorUserId: "u1", referenceId: "turn:c1:3:gen:g1", amount: 7, ttlMs: 1_800_000 });
    expect(h.chargeOnceForGeneration).toHaveBeenCalledWith("turn:c1:3", { ...CHARGE, amount: 4, releaseHold: "turn:c1:3" });
    expect(h.releaseHold).not.toHaveBeenCalled();
    expect(result.credits).toBe(4);
  });

  it("releases the hold when nothing was spent", async () => {
    await settleHeldUsage({ usage: recorder(0), holdKey: "h", chargeKey: "c", lookupHoldCredits: 0, handOff: async () => undefined, charge: CHARGE });
    expect(h.chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledWith("h");
  });

  it("releases the hold when the charge key was already billed", async () => {
    h.chargeOnceForGeneration.mockResolvedValue(null);
    await settleHeldUsage({ usage: recorder(4), holdKey: "h", chargeKey: "c", lookupHoldCredits: 0, handOff: async () => undefined, charge: CHARGE });
    expect(h.releaseHold).toHaveBeenCalledWith("h");
  });

  it("releases the hold and passes the error on when the charge fails", async () => {
    h.chargeOnceForGeneration.mockRejectedValue(new Error("db down"));
    await expect(
      settleHeldUsage({ usage: recorder(4), holdKey: "h", chargeKey: "c", lookupHoldCredits: 0, handOff: async () => undefined, charge: CHARGE }),
    ).rejects.toThrow("db down");
    expect(h.releaseHold).toHaveBeenCalledWith("h");
  });

  it("still settles when placing a lookup hold fails, and logs it", async () => {
    h.placeHold.mockRejectedValue(new Error("db blip"));
    await settleHeldUsage({ usage: recorder(4, ["g1"]), holdKey: "h", chargeKey: "c", lookupHoldCredits: 7, handOff: async () => undefined, charge: CHARGE });
    expect(h.chargeOnceForGeneration).toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ referenceId: "turn:c1:3:gen:g1" }), "credit_hold_place_failed");
  });
});
