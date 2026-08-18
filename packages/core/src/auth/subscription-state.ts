// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import type { MembershipTier } from "@breatic/shared";

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

/**
 * The situations an account can be in, one per row of design §6.5.1.
 *
 * `unexpected` covers `trialing` and `paused`, which nothing we do can
 * produce. It is kept apart from `none` so that it can be logged where it
 * surfaces, and it earns no tier and blocks no purchase, so an account cannot
 * be stranded by a state we never meant to create.
 */
export type SubscriptionSituation =
  | "none"
  | "firstPaymentUnsettled"
  | "active"
  | "cancelling"
  | "upgradePending"
  | "retrying"
  | "unexpected";

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
}

/**
 * The statuses under which a subscription is still ours to act on.
 *
 * `trialing` and `paused` are absent although Stripe considers them current:
 * we set no trial, so neither can arise from anything we do, and treating one
 * as live would leave a state we never produce standing between an account
 * and subscribing.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "incomplete",
  "active",
  "past_due",
]);

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
 * At most one row may be live at a time; that invariant is held at write time
 * (design §6.5.5) by checking for a live row before creating another, and by
 * upgrading through Stripe's update rather than by starting a second
 * subscription. Should two ever be live, the first in the given order wins,
 * and callers pass rows newest first.
 * @param records - Every subscription row stored for the account.
 * @returns The situation and the row it was read from.
 */
export function subscriptionSituation<T extends SubscriptionRecord>(
  records: readonly T[],
): SituationReading<T> {
  const live = records.find((record) => LIVE_STATUSES.has(record.status));
  if (live) return { situation: situationOfLiveRecord(live), record: live };

  const unexpected = records.find(
    (record) => !ENDED_STATUSES.has(record.status),
  );
  if (unexpected) return { situation: "unexpected", record: unexpected };

  return { situation: "none", record: null };
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
