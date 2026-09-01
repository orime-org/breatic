// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much history one consolidation takes away (#148, N1).
 *
 * The stopping condition is "until what is left is at or under the keep line",
 * not "after taking a fixed amount". A turn has no upper bound — forty model
 * calls under one question, each tool result stored whole — so a fixed amount
 * cannot promise the reassembled payload lands under the budget, and the
 * promise is the point.
 *
 * The unit is what each turn contributes to the assembled `messages`, the same
 * ruler the 850,000 line is read with.
 */

import { describe, it, expect } from "vitest";
import { planConsolidation } from "../../agent/consolidation-window.js";

const BUDGET = 850_000;
const KEEP = 500_000;

/**
 * Turns as the planner sees them: an index and what that turn costs the
 * assembled payload.
 * @param sizes - Each turn's assembled size, oldest first.
 * @param firstTurn - The index of the oldest turn.
 * @returns The turns.
 */
function turns(sizes: readonly number[], firstTurn = 1) {
  return sizes.map((chars, i) => ({ turnIndex: firstTurn + i, chars }));
}

/**
 * A request stated the way the two lines are reasoned about: a fixed cost that
 * the fold cannot touch, plus the turns it can.
 * @param fixedCost - Prompt, tools, memory and this turn's question.
 * @param turnList - The turns on hand, oldest first.
 * @returns The request, with the total the planner reads worked out.
 */
function request(fixedCost: number, turnList: ReturnType<typeof turns>) {
  return {
    assembled: fixedCost + turnList.reduce((sum, t) => sum + t.chars, 0),
    turns: turnList,
    budget: BUDGET,
    keep: KEEP,
  };
}

describe("planning how much a consolidation takes", () => {
  it("takes nothing when the payload is already under the budget", () => {
    const plan = planConsolidation(request(20_000, turns([10_000, 10_000, 10_000])));

    expect(plan.newWatermark).toBeNull();
    expect(plan.takenTurns).toEqual([]);
  });

  it("leaves the payload alone when it lands exactly on the budget", () => {
    // The rule is "over the budget", so the line itself passes. 83 turns of
    // 10,000 plus 20,000 fixed is 850,000 on the nose.
    const plan = planConsolidation(request(20_000, turns(Array.from({ length: 83 }, () => 10_000))));

    expect(plan.newWatermark).toBeNull();
  });

  it("takes from the oldest end until what remains is at or under the keep line", () => {
    // 30 turns of 30,000 = 900,000, plus 20,000 fixed = 920,000 assembled.
    // Taking the oldest 15 leaves 450,000 + 20,000 = 470,000.
    const plan = planConsolidation(request(20_000, turns(Array.from({ length: 30 }, () => 30_000))));

    expect(plan.newWatermark).not.toBeNull();
    expect(plan.remainingChars).toBeLessThanOrEqual(KEEP);
    // It stops as soon as the line is met: one turn fewer would still be over.
    const oneFewer = plan.remainingChars + 30_000;
    expect(oneFewer).toBeGreaterThan(KEEP);
  });

  it("takes about 350,000 in the ordinary case, which is the difference of the two lines", () => {
    const plan = planConsolidation(
      // 85 turns of 10,000 plus 20,000 fixed = 870,000, just over the budget.
      // Reaching the keep line means taking 370,000, which is 37 turns.
      request(20_000, turns(Array.from({ length: 85 }, () => 10_000))),
    );

    expect(plan.newWatermark).not.toBeNull();
    const taken = 870_000 - plan.remainingChars;
    expect(taken).toBeGreaterThanOrEqual(340_000);
    expect(taken).toBeLessThanOrEqual(370_000);
  });

  it("takes far more than 350,000 when one recent turn is enormous", () => {
    // A single turn that ran forty steps and stored every tool result.
    const plan = planConsolidation(request(20_000, turns([...Array.from({ length: 40 }, () => 10_000), 900_000])));

    expect(plan.newWatermark).not.toBeNull();
    // A fixed 350,000 would stop after the small turns and leave the payload
    // above the budget; this one keeps going.
    expect(plan.remainingChars).toBeLessThanOrEqual(KEEP);
  });

  it("marks the boundary by turn, and takes whole turns only", () => {
    const sizes = Array.from({ length: 30 }, () => 30_000);
    const plan = planConsolidation(request(20_000, turns(sizes, 7)));

    // The turns taken are a prefix of the history, in order, starting at the
    // oldest one the watermark left behind.
    expect(plan.takenTurns[0]).toBe(7);
    for (const [i, t] of plan.takenTurns.entries()) {
      expect(t).toBe(7 + i);
    }
    expect(plan.newWatermark).toBe(plan.takenTurns[plan.takenTurns.length - 1]);
  });

  it("takes everything it has when even that does not reach the keep line", () => {
    // Fixed cost alone is over the keep line: nothing left to take after the
    // history is gone, and the plan says so rather than looping.
    const plan = planConsolidation(request(600_000, turns([100_000, 100_000, 100_000, 100_000])));

    expect(plan.newWatermark).not.toBeNull();
    expect(plan.takenTurns).toEqual([1, 2, 3, 4]);
    expect(plan.remainingChars).toBe(600_000);
  });

  it("takes nothing when there is no history to take", () => {
    const plan = planConsolidation(request(900_000, []));

    expect(plan.newWatermark).toBeNull();
    expect(plan.takenTurns).toEqual([]);
  });
});
