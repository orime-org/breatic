// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much history one consolidation takes away.
 *
 * It takes from the oldest end until what is left is at or under the keep
 * line. Written that way rather than as a fixed amount because a turn has no
 * upper bound: `stopWhen: stepCountIs(40)` lets one question run forty model
 * calls and every tool result is stored whole, so a single recent turn can be
 * larger than any fixed figure. Stopping on "what remains" makes "under the
 * budget after this" a property of the loop rather than an argument about how
 * fast a conversation grows.
 *
 * In the ordinary case the two lines are 850,000 and 500,000 and a pass takes
 * about the 350,000 between them.
 */

/** One turn and what it costs the assembled payload. */
export interface TurnCost {
  /** The turn's index, as the store filed it. */
  turnIndex: number;
  /** What this turn contributes to the assembled `messages`, in characters. */
  chars: number;
}

/** What the planner was asked. */
export interface ConsolidationRequest {
  /** What the whole request measures as it stands, history included. */
  assembled: number;
  /** The unconsolidated turns, oldest first. */
  turns: readonly TurnCost[];
  /** Over this, a pass runs. */
  budget: number;
  /** A pass takes until what remains is at or under this. */
  keep: number;
}

/** What one pass would do. */
export interface ConsolidationPlan {
  /** The turns this pass takes, oldest first. */
  takenTurns: number[];
  /** What the payload measures once they are gone. */
  remainingChars: number;
  /**
   * Where the watermark lands, and `null` when this pass does nothing.
   *
   * One field answers both questions because they have one answer: a payload
   * over the budget is by that fact over the keep line as well (the keep line
   * is the lower of the two), so the loop below always takes at least one
   * turn once it runs at all.
   */
  newWatermark: number | null;
}

/**
 * Decide whether to consolidate and how far back to go.
 * @param request - The assembled total, the turns on hand, and the two lines.
 * @returns The plan; `newWatermark` is null when nothing needs doing.
 */
export function planConsolidation(request: ConsolidationRequest): ConsolidationPlan {
  const { assembled, turns, budget, keep } = request;

  const nothing: ConsolidationPlan = {
    takenTurns: [],
    remainingChars: assembled,
    newWatermark: null,
  };

  if (assembled <= budget) return nothing;
  // Over the budget with no history to give: the fixed cost alone is the
  // whole payload, and there is nothing this pass could take.
  if (turns.length === 0) return nothing;

  const takenTurns: number[] = [];
  let remainingChars = assembled;

  for (const turn of turns) {
    if (remainingChars <= keep) break;
    takenTurns.push(turn.turnIndex);
    remainingChars -= turn.chars;
  }

  return {
    takenTurns,
    remainingChars,
    newWatermark: takenTurns[takenTurns.length - 1] ?? null,
  };
}
