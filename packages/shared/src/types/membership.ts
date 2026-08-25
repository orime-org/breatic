// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Membership tiers (ratified 2026-07-30).
 *
 * A tier decides capacity and collaboration scale — how much storage, how
 * many team studios, projects, members, and simultaneous writable
 * connections. It never decides what a person can create: every generation
 * feature and every model is available on every tier.
 *
 * The tier lives on the account. Which tier governs a studio's limits is a
 * separate question with a settled answer: the tier of that studio's current
 * admin, so a transfer moves the studio onto the new admin's tier.
 *
 * Not to be confused with the `tier` already in this codebase around
 * payments (`config/pricing.yaml`, `payment.service.ts`) — those are credit
 * PACKS, an unrelated leg of the product. Membership is always spelled out
 * as `membershipTier` in code for that reason.
 */

import { z } from "zod";

/**
 * The tiers an account can be on.
 *
 * The first three are the ratified priced tiers. `self_hosted` is a
 * deployment shape rather than an entry on the price list: whoever runs a
 * self-hosted install gets the numbers written in that install's
 * `config/membership.yaml`, and tightens them by editing that file.
 * `enterprise` is the negotiated one, agreed per customer.
 *
 * This is every tier a `users.membership_tier` row may legally hold, and the
 * database's CHECK constraint lists exactly these five. It is NOT the set of
 * tiers whose ceilings come out of the config file — that is
 * {@link CONFIGURED_MEMBERSHIP_TIERS}, and the two are different on purpose.
 */
export const MEMBERSHIP_TIERS = [
  "base",
  "pro",
  "team",
  "self_hosted",
  "enterprise",
] as const;

/** One of the tiers an account can be on. */
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

/**
 * The tiers whose ceilings are written in `config/membership.yaml`.
 *
 * Enterprise is absent, and that absence is the whole point. Its numbers are
 * agreed per customer, so there is no single set of them to put in a config
 * file; they will be read from the database when that work happens. Writing a
 * set before then would hand an account put on that tier a quota nobody
 * negotiated, and nothing would surface it.
 *
 * So the tier is legal to store and impossible to price: the constraint
 * accepts the word, and asking for its ceilings fails loudly, naming the
 * account. Narrowing every ceiling lookup to this subset is what makes the
 * compiler insist that each one says out loud what it does about enterprise,
 * rather than indexing a config object and getting `undefined`.
 */
export const CONFIGURED_MEMBERSHIP_TIERS = [
  "base",
  "pro",
  "team",
  "self_hosted",
] as const;

/** A tier whose ceilings can be read from `config/membership.yaml`. */
export type ConfiguredMembershipTier =
  (typeof CONFIGURED_MEMBERSHIP_TIERS)[number];

/**
 * One ceiling.
 *
 * A plain non-negative integer, always compared as `count >= limit`. There is
 * no "unlimited" value and no sentinel — a deployment that does not want to
 * cap something writes a number nobody reaches (9999, or 100 TiB for bytes).
 * That is what keeps zero meaning zero: `base.team_studios` is 0 because that
 * tier genuinely cannot create a team studio, and the same comparison refuses
 * it without a special case anywhere.
 */
const limitSchema = z.number().int().nonnegative();

/**
 * The six ceilings every tier carries.
 *
 * `concurrent_editors` counts simultaneous WRITABLE CONNECTIONS to one
 * document, not people: one account with four browser tabs open holds four of
 * them. The ratified decision words this as "people", which is imprecise —
 * user 2026-08-12 confirmed connections is what gets enforced, and that the
 * decision's wording is what needs correcting.
 *
 * Field names are the YAML's, so this shape and the file cannot drift.
 *
 * It lives here rather than beside the loader because the membership panel
 * renders these numbers: web now needs the shape, which is this package's
 * entry test. The loader stays in core — reading a file is not a shape.
 */
export const tierLimitsSchema = z.object({
  team_studios: limitSchema,
  projects_per_studio: limitSchema,
  concurrent_editors: limitSchema,
  studio_members: limitSchema,
  project_members: limitSchema,
  storage_bytes: limitSchema,
});

/**
 * One tier's ceilings.
 *
 * Inferred from the schema rather than declared beside it, so there is no
 * second list of field names to fall out of step with the first.
 */
export type MembershipLimits = z.infer<typeof tierLimitsSchema>;

/**
 * The tiers a person can compare themselves against and move between.
 *
 * Not {@link CONFIGURED_MEMBERSHIP_TIERS}, which also carries `self_hosted` —
 * that one is a deployment shape rather than something anybody buys.
 * `enterprise` is absent for a different reason: its ceilings are negotiated
 * per customer and are not in the config file at all.
 */
export const COMPARABLE_MEMBERSHIP_TIERS = ["base", "pro", "team"] as const;

/** A tier that appears on the price list. */
export type ComparableMembershipTier =
  (typeof COMPARABLE_MEMBERSHIP_TIERS)[number];

const COMPARABLE_TIER_SET: ReadonlySet<string> = new Set(
  COMPARABLE_MEMBERSHIP_TIERS,
);

/** A tier somebody pays a monthly subscription for. */
export type SubscribableMembershipTier = Exclude<
  ComparableMembershipTier,
  "base"
>;

/**
 * The tiers a subscription can be bought for (#106).
 *
 * The price list minus the free tier: `base` is what an account falls back to
 * when it subscribes to nothing, so there is no plan to sell for it.
 *
 * Derived from {@link COMPARABLE_MEMBERSHIP_TIERS} rather than written out
 * again, so a fourth priced tier lands here by itself — and, because
 * `config/subscription.yaml` is required to carry a plan for every member of
 * this list, the missing plan is named on the first read instead of reaching
 * Stripe as an undefined price id.
 */
export const SUBSCRIBABLE_MEMBERSHIP_TIERS =
  COMPARABLE_MEMBERSHIP_TIERS.filter(
    (tier): tier is SubscribableMembershipTier => tier !== "base",
  );

/**
 * Whether a tier is one of the priced ones.
 *
 * Exists so that no caller has to write the membership out again to ask. A
 * hand-written `tier === 'base' || tier === 'pro' || …` narrows just as well
 * and reads just as clearly, which is exactly what makes it dangerous: adding
 * a fourth priced tier would leave it silently answering `false` while every
 * other consumer of {@link COMPARABLE_MEMBERSHIP_TIERS} adapts or fails to
 * compile.
 * @param tier - Any tier an account can be on.
 * @returns Whether it appears on the price list, narrowing the argument.
 */
export function isComparableMembershipTier(
  tier: MembershipTier,
): tier is ComparableMembershipTier {
  return COMPARABLE_TIER_SET.has(tier);
}

/** One row of the tier comparison table. */
export interface TierOffer {
  /** Which tier this row describes. */
  readonly tier: ComparableMembershipTier;
  /** That tier's six ceilings, read from `config/membership.yaml`. */
  readonly limits: MembershipLimits;
  /**
   * What it costs per month, in the smallest currency unit.
   *
   * Null for the free tier, and null on every row when this deployment sells
   * nothing: a self-hosted install has no prices, and inventing "$0" there
   * would be a claim about a shop that does not exist.
   */
  readonly priceCents: number | null;
  /** ISO 4217 code for `priceCents`, null wherever that is null. */
  readonly currency: string | null;
}

/**
 * Which situation an account's subscription puts it in (#106 §6.5.1).
 *
 * Not Stripe's status: `active` covers three situations that offer different
 * actions — running normally, ending at the period boundary, and waiting on an
 * upgrade's invoice — and the panel shows something different for each.
 *
 * In shared because it is part of the panel's contract. The reading that
 * produces it is backend-only and lives in core.
 */
export const SUBSCRIPTION_SITUATIONS = [
  "none",
  "firstPaymentUnsettled",
  "active",
  "cancelling",
  "upgradePending",
  "retrying",
  "unexpected",
] as const;

/** One of the situations an account's subscription can put it in. */
export type SubscriptionSituation = (typeof SUBSCRIPTION_SITUATIONS)[number];

/**
 * The situations in which an account holds a subscription it can act on.
 *
 * One list, read by both ends. The server refuses a cancel outside it and the
 * panel must not offer one, and when the two kept their own copies the panel
 * drew a cancel button for `firstPaymentUnsettled` that the server answered
 * "you have no membership" to.
 *
 * `firstPaymentUnsettled` is absent on purpose: Stripe cannot update a
 * subscription whose first invoice has not settled, so there is nothing to
 * cancel or change — those accounts start a fresh checkout instead.
 */
export const ACTIONABLE_SUBSCRIPTION_SITUATIONS = [
  "active",
  "cancelling",
  "upgradePending",
  "retrying",
] as const;

const ACTIONABLE_SITUATION_SET: ReadonlySet<string> = new Set(
  ACTIONABLE_SUBSCRIPTION_SITUATIONS,
);

/**
 * Whether the account holds a subscription it can cancel, resume or change.
 * @param situation - The situation its subscription puts it in.
 * @returns Whether there is a subscription to act on.
 */
export function holdsActionableSubscription(
  situation: SubscriptionSituation,
): boolean {
  return ACTIONABLE_SITUATION_SET.has(situation);
}

/** What the panel may offer for the upgrade entrance (design §13). */
export type UpgradeOffer = "offered" | "pending" | "withheld";

/** Which of the three subscription actions an account can take right now. */
export interface SubscriptionActionAvailability {
  /**
   * Whether a higher tier can be chosen — and if not, why not.
   *
   * `pending` is S4: an upgrade is already bought and waiting on its invoice,
   * so the entrance shows as in progress rather than inviting a second one.
   * `withheld` is S5: the server refuses to sell more while a card is already
   * failing, so offering it would only produce a refusal.
   */
  readonly upgrade: UpgradeOffer;
  /** Whether the membership can be set to end at the period boundary. */
  readonly cancel: boolean;
  /** Whether a scheduled ending can be taken back. */
  readonly resume: boolean;
}

/**
 * What an account may do about its subscription, decided once for both ends.
 *
 * The server refuses anything outside this and the panel draws nothing
 * outside it. Keeping one copy each is what produced two defects at once: a
 * "resume" button on an account behind on payment, which the server always
 * refused because it asked whether the situation was `cancelling` while the
 * panel asked whether a cancellation was scheduled — and those disagree for
 * exactly the account that is both — and an upgrade button during the retry
 * window, which design §13 says not to draw and the server answers 409 to.
 *
 * `resume` asks whether an ending is scheduled rather than whether the
 * situation is `cancelling`, because that is what taking it back means. An
 * account whose card is failing AND who asked to stop is both `retrying` and
 * scheduled to end; the situation reading can only name one of those, and the
 * one it names is not the one this question is about.
 * @param state - The situation the account's subscription puts it in.
 * @param cancelAtPeriodEnd - Whether it is set to end at the period boundary.
 * @returns Which of the three actions are available.
 */
export function subscriptionActions(
  state: SubscriptionSituation,
  cancelAtPeriodEnd: boolean,
): SubscriptionActionAvailability {
  const actionable = holdsActionableSubscription(state);
  return {
    upgrade:
      state === "retrying"
        ? "withheld"
        : state === "upgradePending"
          ? "pending"
          : "offered",
    cancel: actionable && !cancelAtPeriodEnd,
    resume: actionable && cancelAtPeriodEnd,
  };
}

/** What the panel shows about an account's subscription. */
export interface SubscriptionSummary {
  /** Which situation it is in — {@link SubscriptionSituation}, not Stripe's word. */
  readonly state: SubscriptionSituation;
  /** The tier it has been paid for, which is not always the tier in force. */
  readonly tier: MembershipTier;
  /** When the paid period ends, ISO 8601, or null before the first payment. */
  readonly currentPeriodEnd: string | null;
  /** Whether it is set to end when that period runs out. */
  readonly cancelAtPeriodEnd: boolean;
  /** Where to pay an outstanding invoice, when there is one. */
  readonly payableInvoiceUrl: string | null;
}

/** What one account has spent of the two allowances counted account-wide. */
export interface AccountUsage {
  /** How many team studios this account currently administers. */
  readonly teamStudios: number;
  /** Live bytes across the studios this account controls. */
  readonly storageBytes: number;
}

/**
 * Everything the membership panel shows, in one answer.
 *
 * The contract of `GET /api/v1/account/membership`, which is why it is here
 * rather than beside the service that assembles it: both ends read this shape,
 * and a second declaration on the web side is how the two would drift.
 */
export interface AccountMembership {
  /** The tier stored on this account. */
  readonly tier: MembershipTier;
  /**
   * That tier's six ceilings, or `null` for `enterprise`.
   *
   * `null` says "this tier's ceilings do not come from configuration", which
   * is a real state rather than a failure: they are agreed per customer, and
   * asking for them throws on purpose so that nobody can quietly invent a set.
   * A read that genuinely fails still fails.
   */
  readonly limits: MembershipLimits | null;
  /** How much of the account-level allowances is spent. */
  readonly usage: AccountUsage;
  /** The tiers offered for comparison, in ascending order. */
  readonly catalog: readonly TierOffer[];
  /**
   * What the account's subscription is doing.
   *
   * Null means one thing and one thing only: this deployment sells no
   * subscriptions. That is what makes the panel hide every subscription
   * control on a self-hosted install without the front end needing to know
   * why. An account that simply has not bought one gets a summary saying so
   * (`state: "none"`) — it is the state the offers exist for.
   */
  readonly subscription: SubscriptionSummary | null;
}
