// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether one purchase can be asked about — the one copy.
 *
 * Two readers ask this. The server turns each answer into its own status code
 * and sentence; the refunds screen lists every purchase and, where the rule
 * gives an answer, names that answer in its own words in place of the button.
 * Stated twice, the two
 * drifted: the screen kept the window clause and dropped the clause that
 * reopens it after a refusal, so a buyer who asked once and then waited past
 * the thirtieth day stopped seeing a purchase they still had the right to
 * ask about.
 */

import { withinRefundWindow } from "@shared/refund-window.js";
import type { CreditLotLifecycle } from "@shared/types/entities.js";

/** Lifecycles in which a purchase is on its way out of the account. */
export const REFUND_LIFECYCLES: ReadonlySet<CreditLotLifecycle> = new Set([
  "refund_pending",
  "refunding",
  "refunded",
]);

/** Why a purchase cannot be asked about right now. */
export type RefundRefusal =
  | "already_asked"
  | "still_designated"
  | "already_spent"
  | "window_closed";

/** What the rule reads off one purchase. */
export interface RefundCandidate {
  /** Where it stands. */
  lifecycle: CreditLotLifecycle;
  /**
   * Whether it points at a studio at all.
   *
   * A boolean rather than the id, because the id has two readings: the column
   * as it stands, and the projection the list hands the browser, where a
   * purchase pointed at a deleted studio reads as pointed nowhere. Passing the
   * id let the two readers disagree about the same purchase — the screen
   * offered an ask the server then refused.
   */
  designated: boolean;
  /**
   * Whether a credit was ever drawn from it.
   *
   * Read off the ledger, not off the balance. The promise turns on whether a
   * credit was ever drawn, and the ledger is the record of that; the balance
   * is a projection of it, so it answers the narrower question of what is
   * left. `depleted` is spent to nothing, which the ledger answers for as
   * well — naming that lifecycle here would be a second way to say the same
   * thing.
   */
  everSpent: boolean;
  /** How many earlier asks were refused. */
  refundAttempts: number;
  /** When it was paid for. */
  createdAt: Date | string;
}

/**
 * Why this purchase cannot be asked about, or null when it can.
 *
 * The answers come in the order a buyer can act on them. Where the purchase
 * stands comes first. Then the two nothing can be done about — what was drawn
 * from it, and whether the window has shut. The designation comes last
 * because it is the only one the buyer can undo: reaching it means every
 * other condition is already met, so undoing it is worth their trouble.
 * @param lot - The purchase.
 * @param now - The instant to judge the window against.
 * @returns The reason, or null when the ask is allowed.
 */
export function refundRefusal(
  lot: RefundCandidate,
  now: Date,
): RefundRefusal | null {
  if (REFUND_LIFECYCLES.has(lot.lifecycle)) {
    return "already_asked";
  }
  if (lot.everSpent) {
    return "already_spent";
  }
  // The window runs from the first ask. The only path that raises
  // `refundAttempts` is an ask that was turned down, and asking checks the
  // window, so how long the decision took afterwards does not cost the buyer
  // the right — Directive 2011/83/EU art. 11(2) turns on the moment the
  // consumer sent the notice.
  if (lot.refundAttempts === 0 && !withinRefundWindow(lot.createdAt, now)) {
    return "window_closed";
  }
  if (lot.designated) {
    return "still_designated";
  }
  return null;
}
