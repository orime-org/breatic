// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A finished generation waiting on its bill (inner#1743): when each lookup happens, how long the credits stay
 * held, what the lookups found, and what the task is billed once they are done.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cost } from "@breatic/provider";

const h = vi.hoisted(() => ({ lookup: vi.fn(), warn: vi.fn() }));

vi.mock("@breatic/core", () => ({
  env: { CREDIT_MULTIPLIER: 1 },
  logger: { warn: h.warn },
  getNodeTaskConfig: () => ({ cost_wait_delay_ms: 1_000, cost_wait_attempts: 3 }),
}));
vi.mock("@breatic/domain", async () => ({
  creditsForUsd: (await import("../../../../domain/src/credit/usage-cost.js")).creditsForUsd,
  provider: () => ({ cost: { lookup: h.lookup } }),
}));

import { billedCredits, costWaitOf, holdUntil, lookUp, nextLookupAt, openWait, pricedCosts } from "@worker/handlers/cost-wait.js";

const LOOKUP = { upstream: "fal", predictionId: "p-1" };
const PENDING: Cost = { state: "pending", lookup: LOOKUP };
const NOW = 1_000_000;

beforeEach(() => {
  h.lookup.mockReset();
  h.warn.mockReset();
});

describe("pricedCosts", () => {
  it("prices what is known, keeps what is pending, and counts a missing cost as nothing, saying so", () => {
    const priced = pricedCosts("task-1", [
      { state: "known", usd: 0.1, source: "billing" },
      PENDING,
      { state: "missing", reason: "no billing" },
    ]);

    expect(priced).toEqual({ credits: 10, pending: [PENDING] });
    expect(h.warn).toHaveBeenCalledWith({ taskId: "task-1", reason: "no billing" }, "cost_unavailable");
  });
});

describe("the wait", () => {
  it("looks up after the first delay, then after twice the last, ending after the configured lookups", () => {
    const wait = openWait(12.5, "fal", NOW);

    expect(wait).toEqual({ credits: 12.5, attempts: 0, servedBy: "fal", windowEndsAt: NOW + 7_000 });
    expect(nextLookupAt(wait, NOW)).toBe(NOW + 1_000);
    expect(nextLookupAt({ ...wait, attempts: 2 }, NOW)).toBe(NOW + 4_000);
  });

  it("holds the credits past the window by the longest interval, and past now when the window is over", () => {
    const wait = openWait(0, "fal", NOW);

    expect(holdUntil(wait, NOW)).toEqual(new Date(NOW + 7_000 + 4_000));
    expect(holdUntil(wait, NOW + 60_000)).toEqual(new Date(NOW + 60_000 + 4_000));
  });

  it("reads back what the completion wrote, and nothing from a result that is not waiting", () => {
    const wait = openWait(1, "fal", NOW);

    expect(costWaitOf({ outputs: [], costWait: wait, pendingCosts: [{ lookup: LOOKUP }] })).toEqual({ wait, pending: [{ lookup: LOOKUP }] });
    expect(costWaitOf({ outputs: [] })).toBeNull();
    expect(costWaitOf(null)).toBeNull();
  });
});

describe("lookUp", () => {
  it("asks only about the costs not yet answered, and tells the upstream when it is the last time", async () => {
    h.lookup.mockResolvedValue({ state: "known", usd: 0.2, source: "billing" });
    const answered = { lookup: { upstream: "fal", predictionId: "p-0" }, cost: { state: "known", usd: 0.1, source: "billing" } as Cost };

    const found = await lookUp([answered, { lookup: LOOKUP }], true);

    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.lookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: true });
    expect(found).toEqual([answered, { lookup: LOOKUP, cost: { state: "known", usd: 0.2, source: "billing" } }]);
  });

  it("asks again about a cost still pending", async () => {
    h.lookup.mockResolvedValue(PENDING);

    expect(await lookUp([{ lookup: LOOKUP, cost: PENDING }], false)).toEqual([{ lookup: LOOKUP, cost: PENDING }]);
    expect(h.lookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: false });
  });
});

describe("billedCredits", () => {
  it("adds what the lookups found to what was known, counting one never answered as nothing, saying so", () => {
    const wait = openWait(10, "fal", NOW);
    const credits = billedCredits("task-1", wait, [
      { lookup: LOOKUP, cost: { state: "known", usd: 0.05, source: "billing" } },
      { lookup: { upstream: "fal", predictionId: "p-2" }, cost: PENDING },
      { lookup: { upstream: "fal", predictionId: "p-3" }, cost: { state: "missing", reason: "gone" } },
    ]);

    expect(credits).toBe(15);
    expect(h.warn).toHaveBeenCalledTimes(2);
  });
});
