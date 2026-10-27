// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much history one consolidation takes away (inner#1567, design 6.4.1).
 *
 * One rule for every fold, whatever set it off: from the oldest whole turn
 * before the current one, take at least one, then keep taking while what
 * remains is still over the target line. A fold runs only when the request
 * did not fit, so taking nothing is never the answer while there is
 * something to take; and the current turn is never taken, so a resumed
 * segment, which reads its own turn as history, keeps it.
 */

/** One turn and what it costs the assembled payload. */
export interface TurnCost {
  /** The turn's index, as the store filed it. */
  turnIndex: number;
  /** What this turn adds to the assembled request, in tokens. */
  tokens: number;
}

/** What the planner was asked. */
export interface ConsolidationRequest {
  /** What the whole request measures as it stands, history included. */
  assembled: number;
  /** The unconsolidated turns, oldest first. */
  turns: readonly TurnCost[];
  /** A fold takes until what remains is at or under this. */
  target: number;
  /** The turn being answered; only turns before it may be taken. */
  currentTurn: number;
}

/** What one fold would do. */
export interface ConsolidationPlan {
  /** What the request measures once the taken turns are gone. */
  remaining: number;
  /**
   * The last turn taken, which is where the watermark lands; `null` only when
   * there is no turn before the current one to take.
   */
  newWatermark: number | null;
}

/**
 * Decide how far back one fold goes.
 * @param request - The assembled total, the turns on hand, the target line and the current turn.
 * @returns The plan; `newWatermark` is null when nothing can be taken.
 * @throws {never} Never.
 */
export function planConsolidation(request: ConsolidationRequest): ConsolidationPlan {
  const { assembled, turns, target, currentTurn } = request;
  let remaining = assembled;
  let newWatermark: number | null = null;
  // Oldest first and without a gap, so the watermark alone says which turns
  // were taken: the ones at or below it.
  for (const turn of turns) {
    if (turn.turnIndex >= currentTurn) break;
    if (newWatermark !== null && remaining <= target) break;
    newWatermark = turn.turnIndex;
    remaining -= turn.tokens;
  }
  return { remaining, newWatermark };
}
