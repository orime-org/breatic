// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one rule a fold takes history by (inner#1567, design 6.4.1).
 *
 * Only whole turns before the current one may be taken, oldest first. A fold
 * always takes at least one, because it runs only when the request did not
 * fit, and it stops as soon as what remains is at or under the target line.
 * Nothing to take is the only way to come back with no watermark.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planConsolidation } from "@server/agent/consolidation-window.js";

/**
 * Turns as the planner sees them, numbered from `firstTurn`.
 * @param sizes - Each turn's size in tokens, oldest first.
 * @param firstTurn - The index of the oldest turn.
 * @returns The turns.
 */
function turns(sizes: readonly number[], firstTurn = 1): { turnIndex: number; tokens: number }[] {
  return sizes.map((tokens, i) => ({ turnIndex: firstTurn + i, tokens }));
}

describe("planConsolidation", () => {
  it("takes the oldest turns until what remains is at or under the target", () => {
    const plan = planConsolidation({
      turns: turns([100, 100, 100, 100, 100]),
      assembled: 1_000,
      target: 750,
      currentTurn: 6,
    });
    expect(plan).toEqual({ newWatermark: 3, remaining: 700 });
  });

  it("stops exactly on the target line", () => {
    const plan = planConsolidation({
      turns: turns([100, 100, 100, 100]),
      assembled: 1_000,
      target: 800,
      currentTurn: 5,
    });
    expect(plan).toEqual({ newWatermark: 2, remaining: 800 });
  });

  it("takes one turn even when the request is already under the target", () => {
    const plan = planConsolidation({
      turns: turns([100, 100, 100]),
      assembled: 500,
      target: 750,
      currentTurn: 4,
    });
    expect(plan).toEqual({ newWatermark: 1, remaining: 400 });
  });

  it("never takes the current turn, even when every earlier turn was not enough", () => {
    const plan = planConsolidation({
      turns: turns([100, 100, 5_000]),
      assembled: 6_000,
      target: 750,
      currentTurn: 3,
    });
    expect(plan).toEqual({ newWatermark: 2, remaining: 5_800 });
  });

  it("does not take turns after the current one", () => {
    const plan = planConsolidation({
      turns: turns([100, 100, 100, 100]),
      assembled: 10_000,
      target: 0,
      currentTurn: 3,
    });
    expect(plan).toEqual({ newWatermark: 2, remaining: 9_800 });
  });

  it("lands the watermark on the stored turn index", () => {
    const plan = planConsolidation({
      turns: turns([300, 300, 300], 7),
      assembled: 1_200,
      target: 700,
      currentTurn: 10,
    });
    expect(plan).toEqual({ newWatermark: 8, remaining: 600 });
  });

  it("returns no watermark when there is no history at all", () => {
    expect(planConsolidation({ turns: [], assembled: 900_000, target: 100, currentTurn: 1 })).toEqual({
      newWatermark: null,
      remaining: 900_000,
    });
  });

  it("returns no watermark when the only turn on hand is the current one", () => {
    expect(planConsolidation({ turns: turns([800_000], 4), assembled: 900_000, target: 100, currentTurn: 4 })).toEqual({
      newWatermark: null,
      remaining: 900_000,
    });
  });

  it("takes the minimal oldest-first prefix of the turns before the current one", () => {
    const history = fc
      .uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 25 })
      .map((indices) => [...indices].sort((a, b) => a - b))
      .chain((indices) =>
        fc.tuple(
          fc.constant(indices),
          fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: indices.length, maxLength: indices.length }),
        ),
      )
      .map(([indices, sizes]) => indices.map((turnIndex, i) => ({ turnIndex, tokens: sizes[i]! })));

    fc.assert(
      fc.property(
        history,
        fc.integer({ min: 0, max: 61 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (turnList, currentTurn, fixedCost, target) => {
          const assembled = fixedCost + turnList.reduce((sum, t) => sum + t.tokens, 0);
          const plan = planConsolidation({ turns: turnList, assembled, target, currentTurn });
          const takeable = turnList.filter((t) => t.turnIndex < currentTurn);

          if (takeable.length === 0) {
            expect(plan).toEqual({ newWatermark: null, remaining: assembled });
            return;
          }

          const watermark = plan.newWatermark;
          expect(watermark).not.toBeNull();
          if (watermark === null) return;
          expect(watermark).toBeLessThan(currentTurn);
          expect(takeable.map((t) => t.turnIndex)).toContain(watermark);

          const taken = takeable.filter((t) => t.turnIndex <= watermark);
          const takenTokens = taken.reduce((sum, t) => sum + t.tokens, 0);
          expect(plan.remaining).toBe(assembled - takenTokens);

          // Minimal: one turn fewer would still have been over the target.
          if (taken.length > 1) {
            expect(plan.remaining + taken[taken.length - 1]!.tokens).toBeGreaterThan(target);
          }
          // It stops only on the target or when nothing is left to take.
          expect(plan.remaining <= target || taken.length === takeable.length).toBe(true);
        },
      ),
    );
  });
});
