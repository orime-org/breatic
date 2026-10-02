// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an account's subscription rows: which situation it is in, and which
 * tier that situation earns (task #106, design §6.5.1).
 *
 * Stripe has one `active`, and we need three. An account that has scheduled a
 * cancellation and one whose upgrade invoice is still unpaid are both `active`
 * at Stripe, yet each may do different things next and each is owed a
 * different tier. Collapsing them left cells of the transition table
 * unwritten, which is where the design review kept finding holes.
 *
 * The tier is a second question rather than a field of the first, because two
 * situations that differ in what the account may do can still earn the same
 * tier: `past_due` keeps the paid tier while Stripe retries the card, a
 * ratified decision (2026-08-18) matching what Notion, Figma and Slack do.
 *
 * Pure reading of rows the caller already holds. Nothing here talks to Stripe
 * or to the database.
 */

import { COMPARABLE_MEMBERSHIP_TIERS } from "@breatic/shared";
import type {
  BillingPeriod,
  MembershipTier,
  SubscriptionSituation,
} from "@breatic/shared";

/**
 * The eight statuses a Stripe subscription can hold.
 *
 * Spelled out rather than imported from the SDK so that this module stays a
 * pure reading of our own rows, and so an unknown value arriving from Stripe
 * fails at the boundary that parses it rather than here.
 */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

/** One of the statuses a Stripe subscription can hold. */
export type StripeSubscriptionStatus =
  (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/**
 * One stored subscription, in the shape this reading needs.
 *
 * An account may own many of these: every ended subscription stays as a
 * ledger entry, so "does this account subscribe" is a question about statuses
 * and never about whether a row exists.
 */
export interface SubscriptionRecord {
  /** Stripe's id for the subscription, unique across all rows. */
  readonly stripeSubscriptionId: string;
  /**
   * Stripe's own status, stored verbatim.
   *
   * Typed as a plain string rather than {@link StripeSubscriptionStatus}
   * because that is what the column holds: a status added upstream reaches
   * this reading before any of our code knows the word. The narrow union
   * belongs on the writing side, where the SDK supplies the value.
   */
  readonly status: string;
  /** The tier this subscription has been paid for. */
  readonly tier: MembershipTier;
  /**
   * How often it is billed.
   *
   * Beside the tier because the two together are what somebody bought: the
   * same tier is sold monthly and yearly at two prices, and which one a row
   * holds decides the price shown, the renewal date and what it may move to.
   */
  readonly period: BillingPeriod;
  /** Whether the plan is set to end when the paid period runs out. */
  readonly cancelAtPeriodEnd: boolean;
  /** Whether an upgrade is waiting on its invoice being paid. */
  readonly hasPendingUpdate: boolean;
  /**
   * When the paid period ends.
   *
   * Null until the first invoice settles: a subscription that has never been
   * paid for has no period.
   */
  readonly currentPeriodEnd: Date | null;
}

// The situations themselves are declared in `@breatic/shared`: they are part
// of the membership panel's contract, so both ends read one list. What lives
// here is the reading that produces one, which is backend-only.
export type { SubscriptionSituation };

/**
 * A situation together with the row it was read from.
 *
 * Generic in the row so a caller reading whole stored subscriptions gets one
 * back, rather than the narrower shape this reading needs.
 */
export interface SituationReading<T extends SubscriptionRecord = SubscriptionRecord> {
  /** Which situation the account is in. */
  readonly situation: SubscriptionSituation;
  /** The row the situation was read from, or null when there is none. */
  readonly record: T | null;
  /**
   * Every row still marked live but past its deadline, highest-ranked first;
   * empty when none is.
   *
   * Such a row is read as ended — its deadline passing without a word from
   * Stripe means the event that ended it never reached us — but it is reported
   * here because what Stripe actually holds is still unknown, and an action
   * that charges money asks Stripe about each of them before selling another.
   */
  readonly lapsed: readonly T[];
}

/** The moment a reading is taken at, and how long a renewing row is trusted. */
export interface SituationClock {
  /** The moment the rows are read at. */
  readonly now: Date;
  /**
   * How long after its period end a row that may still be renewing keeps
   * counting as live: Stripe retries a failed renewal for this long.
   */
  readonly staleAfterMs: number;
}

/**
 * Whether a live row is past the moment its silence means it has ended.
 *
 * A cancelling row ends at its period end: nothing renews it. A row that may
 * still renew gets the retry window first, because Stripe is collecting for it
 * the whole time. An unsettled first invoice has no period to judge.
 * @param record - A row whose status is in {@link LIVE_STATUSES}.
 * @param clock - The moment and the renewal window.
 * @returns Whether the row is past its deadline.
 */
function hasLapsed(record: SubscriptionRecord, clock: SituationClock): boolean {
  if (record.status === "incomplete" || record.currentPeriodEnd === null) {
    return false;
  }
  const grace = record.cancelAtPeriodEnd ? 0 : clock.staleAfterMs;
  return clock.now.getTime() > record.currentPeriodEnd.getTime() + grace;
}

/**
 * The statuses under which a subscription is still ours to act on.
 *
 * `trialing` and `paused` are absent although Stripe considers them current:
 * we set no trial, so neither can arise from anything we do, and treating one
 * as live would leave a state we never produce standing between an account
 * and subscribing.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "active",
  "past_due",
] as const;

const LIVE_STATUSES: ReadonlySet<string> = new Set(LIVE_SUBSCRIPTION_STATUSES);

/**
 * The statuses under which a subscription is over.
 *
 * Named explicitly rather than inferred as "not live", so that a status added
 * upstream lands in neither set and reads as unexpected. Reading an unknown
 * status as ended would be the harmful direction: the account is still being
 * billed, and the panel would offer to start a second subscription.
 */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

/**
 * Works out which situation one live subscription puts the account in.
 * @param record - A row whose status is in {@link LIVE_STATUSES}.
 * @returns The situation, never `none` or `unexpected`.
 */
function situationOfLiveRecord(
  record: SubscriptionRecord,
): SubscriptionSituation {
  if (record.status === "incomplete") return "firstPaymentUnsettled";
  if (record.status === "past_due") return "retrying";
  // A scheduled cancellation outranks an unpaid upgrade: the plan is ending,
  // and that is what decides which offers the panel may make. The unpaid
  // upgrade stays readable through the record itself.
  if (record.cancelAtPeriodEnd) return "cancelling";
  if (record.hasPendingUpdate) return "upgradePending";
  return "active";
}

/**
 * Reads which subscription situation an account is in.
 *
 * Normally one row is live and there is nothing to choose. Two can be, and
 * this table cannot prevent it: it mirrors Stripe, one row per subscription
 * Stripe reports, and Stripe will hold two live subscriptions for one customer
 * — two checkout sessions completing at once is enough. (Stripe's own
 * "limit customers to one subscription" setting is what stops the second from
 * being sold; a constraint here could only decide what happens once it exists,
 * and every answer available to a constraint is "the write fails".)
 *
 * So the choice is made here, by {@link compareLive}, in an order that does
 * not depend on which row happened to be inserted first. Asking the caller to
 * pass rows "newest first" was not an order at all: `created_at` defaults to
 * `now()`, which in PostgreSQL is the TRANSACTION's start time, so rows
 * written together tie, and a random-UUID primary key breaks no tie either.
 *
 * A live row past its deadline ({@link hasLapsed}) is set aside before the
 * choice and read as ended. Judging it after the choice would let a lapsed
 * Team row outrank the PRO bought to replace it, and the account would read
 * as base while paying for PRO.
 * @param records - Every subscription row stored for the account.
 * @param clock - The moment the rows are read at, and the renewal window.
 * @returns The situation, the row it was read from, and the lapsed rows.
 */
export function subscriptionSituation<T extends SubscriptionRecord>(
  records: readonly T[],
  clock: SituationClock,
): SituationReading<T> {
  const liveRows = records.filter((record) => LIVE_STATUSES.has(record.status));
  const lapsed = liveRows
    .filter((record) => hasLapsed(record, clock))
    .sort(compareLive);

  const live = liveRows
    .filter((record) => !lapsed.includes(record))
    .sort(compareLive)[0];
  if (live) {
    return { situation: situationOfLiveRecord(live), record: live, lapsed };
  }

  const unexpected = records.find(
    (record) =>
      !ENDED_STATUSES.has(record.status) && !lapsed.includes(record),
  );
  if (unexpected) return { situation: "unexpected", record: unexpected, lapsed };

  return { situation: "none", record: null, lapsed };
}

/**
 * Whether a live subscription has actually bought the account anything yet.
 *
 * `incomplete` means the first invoice has not settled: the subscription
 * exists at Stripe, it is live in the sense that it can still be paid, and it
 * has bought nothing — {@link tierForSituation} gives it `base`.
 * @param record - A live subscription.
 * @returns Whether it is currently earning the account its tier.
 */
function isEarning(record: SubscriptionRecord): boolean {
  return record.status !== "incomplete";
}

/**
 * Which of two live subscriptions governs the account.
 *
 * Four keys, each one total where the one before it ties, so the answer never
 * depends on the order rows arrived in.
 *
 * Whether the subscription has been paid for at all comes FIRST, above the
 * tier. Ordering by tier alone let an `incomplete` Team subscription — one
 * nobody has paid a cent for — outrank a running PRO, and since an unsettled
 * first invoice earns `base`, the account holding it dropped to the free tier
 * while being billed for PRO. An unpaid subscription cannot outrank a paid one
 * whatever tier it names.
 *
 * Then the tier, because where two are both paid the person is paying for
 * both: giving them the lower one would charge for a tier and withhold it.
 * Then the later paid period, because that is the one their money reaches
 * further into. Then the subscription id, which is Stripe's and unique — not a
 * tie-break anybody would defend on its merits, but two subscriptions of the
 * same tier ending at the same moment are interchangeable, and leaving it
 * undecided is what put this reading at the mercy of insertion order in the
 * first place.
 * @param a - One live subscription.
 * @param b - The other.
 * @returns Negative when `a` governs, positive when `b` does.
 */
function compareLive(a: SubscriptionRecord, b: SubscriptionRecord): number {
  const byEarning = Number(isEarning(b)) - Number(isEarning(a));
  if (byEarning !== 0) return byEarning;

  const byTier =
    COMPARABLE_MEMBERSHIP_TIERS.indexOf(b.tier as never) -
    COMPARABLE_MEMBERSHIP_TIERS.indexOf(a.tier as never);
  if (byTier !== 0) return byTier;

  const byPeriod =
    (b.currentPeriodEnd?.getTime() ?? 0) - (a.currentPeriodEnd?.getTime() ?? 0);
  if (byPeriod !== 0) return byPeriod;

  return a.stripeSubscriptionId < b.stripeSubscriptionId ? -1 : 1;
}

/**
 * Reads which membership tier a situation earns.
 * @param situation - The situation the account is in.
 * @param record - The row that situation was read from, if any.
 * @returns The tier the account is entitled to right now.
 */
export function tierForSituation(
  situation: SubscriptionSituation,
  record: SubscriptionRecord | null,
): MembershipTier {
  switch (situation) {
    // `upgradePending` earns the tier already paid for, never the one being
    // upgraded to: the new tier's ceilings arrive when its invoice does.
    // `retrying` keeps it too — ratified 2026-08-18, because while Stripe
    // retries a failed charge it is still collecting for us.
    case "active":
    case "cancelling":
    case "upgradePending":
    case "retrying":
      return record?.tier ?? "base";
    // A first invoice that has not settled has bought nothing yet, and the two
    // states we never create have bought nothing either.
    case "firstPaymentUnsettled":
    case "none":
    case "unexpected":
      return "base";
  }
}
