// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long a purchase stays refundable — the one copy.
 *
 * A purchase can be refunded within 30 UTC calendar days of being paid for,
 * the thirtieth day included in full. Two readers state that rule to the
 * buyer: the confirmation email prints the day it closes on, and the refunds
 * screen leaves out purchases whose window has shut. They compute it here so
 * an email cannot name a date the screen has already gone past.
 *
 * Days, not hours. A purchase made at 23:59 gets the same closing date as one
 * made at 00:01 the same day, and that date runs to its own last millisecond.
 */

/** UTC calendar days a purchase stays refundable, the last one included. */
const REFUND_WINDOW_DAYS = 30;

/** Milliseconds in a day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One instant's UTC calendar day.
 *
 * Built from the UTC fields rather than sliced off an ISO string, and
 * comparable with `<=` because `YYYY-MM-DD` sorts the way dates do.
 * @param at - The instant. Text keeps the microseconds a database column
 *   holds, which a `Date` would drop.
 * @returns That day, as `YYYY-MM-DD`.
 */
function utcDay(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/**
 * The UTC calendar day a purchase's refund window closes on.
 *
 * The whole of this day is still inside the window; it shuts when the next
 * one starts.
 * @param paidAt - When the purchase was paid for.
 * @returns That day, as `YYYY-MM-DD`.
 */
function refundDeadlineDay(paidAt: Date | string): string {
  const at = paidAt instanceof Date ? paidAt : new Date(paidAt);
  return utcDay(new Date(at.getTime() + REFUND_WINDOW_DAYS * MS_PER_DAY));
}

/**
 * The instant a purchase's refund window closes.
 *
 * The last millisecond of the thirtieth UTC day, which the confirmation email
 * prints in the buyer's own zone beside UTC — the same way it prints the
 * purchase time. Read east of UTC it falls on the next morning, read west of
 * it on the same afternoon, and a buyer who is told only a bare date has no
 * way to know which of those they were given.
 *
 * The purchase's own time of day does not travel with it: two purchases made
 * on the same UTC day get the same closing instant.
 * @param paidAt - When the purchase was paid for.
 * @returns That instant.
 */
export function refundWindowCloses(paidAt: Date | string): Date {
  return new Date(`${refundDeadlineDay(paidAt)}T23:59:59.999Z`);
}

/**
 * Whether a purchase is still inside its refund window.
 *
 * Compares calendar days rather than instants, so the closing day counts in
 * full: a purchase paid for at 10:00 is still refundable at 23:59 on the
 * thirtieth day.
 * @param paidAt - When the purchase was paid for.
 * @param now - The instant to judge against.
 * @returns Whether the window is still open.
 */
export function withinRefundWindow(paidAt: Date | string, now: Date): boolean {
  return utcDay(now) <= refundDeadlineDay(paidAt);
}
