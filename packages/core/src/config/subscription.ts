// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Subscription plan configuration loader (task #106, design §12).
 *
 * Reads `config/subscription.yaml`: what each subscribable tier costs per
 * month, and which Stripe price sells it.
 *
 * Lives in core, beside the membership ceilings, because two callers in two
 * packages read this one file: server needs the price ids to talk to Stripe,
 * and core needs `stale_after_days` for the check that stops honouring a
 * subscription nobody has heard from (`membership.repo.ts`).
 *
 * A tier with no plan in the file is a loud failure naming that tier, on the
 * first read. The alternative — an `undefined` price id travelling to Stripe —
 * fails at checkout, in front of somebody trying to pay us.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  SUBSCRIBABLE_MEMBERSHIP_TIERS,
  type SubscribableMembershipTier,
} from "@breatic/shared";
import { env, MONOREPO_ROOT } from "@core/config/env.js";

const planSchema = z.object({
  price_cents: z.number().int().positive(),
  currency: z.string().default("usd"),
  stripe_price_id: z.object({
    test: z.string(),
    live: z.string(),
  }),
});

/**
 * The file's shape.
 *
 * `plans` is a loose record rather than a key per tier: which tiers must be
 * present is {@link SUBSCRIBABLE_MEMBERSHIP_TIERS}, and asserting it here
 * would be a second list to keep in step. {@link resolvePlans} is where every
 * member of that list is required to appear.
 */
export const subscriptionConfigSchema = z.object({
  plans: z.record(z.string(), planSchema),
  /**
   * How long a stored subscription may sit past its paid period before its
   * tier stops being honoured.
   *
   * A subscription that is really renewing has its period pushed forward by
   * Stripe, so a row still marked live long after its period ended means we
   * missed the event that ended it. Fourteen days is Stripe's own Smart
   * Retries window: within it, a `past_due` subscription is one Stripe is
   * still collecting for, and taking the tier away would punish somebody
   * whose card is about to go through.
   */
  stale_after_days: z.number().int().positive().default(14),
  /**
   * How long either path waits when it asks Stripe for a subscription's
   * current state — the panel's reconciliation and the webhook's fetch.
   *
   * One value for both, because both ask the same question and neither wants
   * to wait: the SDK's unbounded default is 80 seconds twice retried, which
   * holds a reader in front of a spinner on one path and, on the other, holds
   * a request Stripe has already written off and queued a redelivery for.
   */
  stripe_read_timeout_ms: z.number().int().positive().default(5000),
});

/** The file's contents, before a price id is chosen for this environment. */
export type SubscriptionConfigFile = z.infer<typeof subscriptionConfigSchema>;

/** One tier's monthly plan, with the price id this environment sells. */
export interface SubscriptionPlan {
  /** Monthly price in the smallest currency unit. */
  readonly priceCents: number;
  /** ISO 4217 code, lower case, as Stripe writes it. */
  readonly currency: string;
  /** The Stripe price this environment checks out against. */
  readonly stripePriceId: string;
}

/** Every subscribable tier's plan. */
export type SubscriptionPlans = Record<
  SubscribableMembershipTier,
  SubscriptionPlan
>;

let cachedFile: SubscriptionConfigFile | null = null;
let cachedPlans: SubscriptionPlans | null = null;

/**
 * Reads and caches the parsed file.
 * @returns The file's contents.
 * @throws {Error} When it is missing or malformed.
 */
function readFile(): SubscriptionConfigFile {
  if (cachedFile) return cachedFile;
  const configPath = resolve(MONOREPO_ROOT, "config/subscription.yaml");
  cachedFile = subscriptionConfigSchema.parse(
    parse(readFileSync(configPath, "utf-8")),
  );
  return cachedFile;
}

/**
 * Resolves the parsed file into one plan per subscribable tier.
 * @param file - The parsed contents of `config/subscription.yaml`.
 * @param isLive - Whether to take the live price id rather than the test one.
 * @returns A plan for every subscribable tier.
 * @throws {Error} When the file carries no plan for one of those tiers.
 */
export function resolvePlans(
  file: SubscriptionConfigFile,
  isLive: boolean,
): SubscriptionPlans {
  const entries = SUBSCRIBABLE_MEMBERSHIP_TIERS.map((tier) => {
    const plan = file.plans[tier];
    if (!plan) {
      throw new Error(
        `config/subscription.yaml has no plan for membership tier "${tier}"`,
      );
    }
    return [
      tier,
      {
        priceCents: plan.price_cents,
        currency: plan.currency,
        stripePriceId: isLive
          ? plan.stripe_price_id.live
          : plan.stripe_price_id.test,
      },
    ] as const;
  });
  return Object.fromEntries(entries) as SubscriptionPlans;
}

/**
 * Reads every subscribable tier's plan.
 * @returns A plan for every subscribable tier.
 * @throws {Error} When the file is missing, malformed, or lacks a tier's plan.
 */
export function getSubscriptionPlans(): SubscriptionPlans {
  if (cachedPlans) return cachedPlans;
  cachedPlans = resolvePlans(readFile(), env.ENV === "prod");
  return cachedPlans;
}

/**
 * Reads how long to wait when asking Stripe about a subscription.
 * @returns That wait in milliseconds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getStripeReadTimeoutMs(): number {
  return readFile().stripe_read_timeout_ms;
}

/**
 * Reads how long a subscription may sit past its paid period before its tier
 * stops being honoured.
 * @returns That window in days.
 * @throws {Error} When the file is missing or malformed.
 */
export function getSubscriptionStaleAfterDays(): number {
  return readFile().stale_after_days;
}

/**
 * Reads one tier's plan.
 * @param tier - The tier being sold.
 * @returns That tier's plan.
 * @throws {Error} When the file is missing, malformed, or lacks a tier's plan.
 */
export function getSubscriptionPlan(
  tier: SubscribableMembershipTier,
): SubscriptionPlan {
  return getSubscriptionPlans()[tier];
}

/**
 * Reads which tier a Stripe price sells.
 *
 * Used when a subscription arrives carrying a price rather than a tier, which
 * is every subscription Stripe tells us about.
 * @param priceId - A Stripe price id.
 * @returns The tier it sells, or null when no plan uses it.
 * @throws {Error} When the file is missing, malformed, or lacks a tier's plan.
 */
export function findSubscribableTierByPriceId(
  priceId: string,
): SubscribableMembershipTier | null {
  const plans = getSubscriptionPlans();
  return (
    SUBSCRIBABLE_MEMBERSHIP_TIERS.find(
      (tier) => plans[tier].stripePriceId === priceId,
    ) ?? null
  );
}

/** Forgets the cached plans, so a test can read the file again. */
export function resetSubscriptionConfigCache(): void {
  cachedFile = null;
  cachedPlans = null;
}
