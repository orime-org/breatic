// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pricing tier configuration loader.
 *
 * Loads credit purchase tiers from `config/pricing.yaml` and resolves
 * the correct Stripe Price ID based on the current environment.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { env, MONOREPO_ROOT } from "@breatic/core";

const tierSchema = z.object({
  name: z.string(),
  credits: z.number().int().positive(),
  price_cents: z.number().int().positive(),
  // Lower-cased where the file enters the system. Stripe answers in lower
  // case and `fulfillPayment` compares the two, so a tier written `USD` —
  // which is how ISO 4217 is normally written — would disagree with Stripe on
  // every purchase: the money is taken and no credits are granted. Normalising
  // here rather than at the comparison keeps what is stored on the payment
  // comparable for a refund too.
  currency: z.string().toLowerCase().default("usd"),
  stripe_price_id: z.object({
    test: z.string(),
    live: z.string(),
  }),
});

const reconcileSchema = z.object({
  batch_size: z.number().int().positive().default(3),
  min_age_seconds: z.number().int().positive().default(120),
});

/** The price file's shape, exported so its normalisation can be asserted. */
export const pricingSchema = z.object({
  tiers: z.array(tierSchema),
  reconcile: reconcileSchema.default({ batch_size: 3, min_age_seconds: 120 }),
  stale_sending_minutes: z.number().int().positive().default(10),
  confirm_timeout_ms: z.number().int().positive().default(15000),
});

/** Resolved pricing tier with the correct Stripe Price ID for this environment. */
export interface PricingTier {
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
  stripePriceId: string;
}

/** The two bounds one reconcile pass runs inside. */
export interface ReconcileBounds {
  batchSize: number;
  minAgeSeconds: number;
}

let _cachedFile: z.infer<typeof pricingSchema> | null = null;
let _cachedTiers: PricingTier[] | null = null;

/**
 * The parsed file, read once.
 *
 * Four accessors ask this file different questions, and one of them is asked
 * per row of a page of purchases. Reading and parsing it per question would
 * put a synchronous file read and a full YAML parse on the event loop for
 * each of them.
 * @returns The parsed file.
 * @throws {Error} When the file is missing or malformed.
 */
function loadPricingFile(): z.infer<typeof pricingSchema> {
  if (_cachedFile) return _cachedFile;
  const configPath = resolve(MONOREPO_ROOT, "config/pricing.yaml");
  _cachedFile = pricingSchema.parse(parse(readFileSync(configPath, "utf-8")));
  return _cachedFile;
}

/**
 * Load and resolve pricing tiers from YAML config.
 *
 * Selects `test` or `live` Stripe Price ID based on `ENV`:
 * - `dev` / `staging` → `test`
 * - `prod` → `live`
 * @returns Array of resolved pricing tiers
 */
export function getPricingTiers(): PricingTier[] {
  if (_cachedTiers) return _cachedTiers;

  const isLive = env.ENV === "prod";

  _cachedTiers = loadPricingFile().tiers.map((t) => ({
    name: t.name,
    credits: t.credits,
    priceCents: t.price_cents,
    currency: t.currency,
    stripePriceId: isLive ? t.stripe_price_id.live : t.stripe_price_id.test,
  }));

  return _cachedTiers;
}

/**
 * Find a pack by its face value in cents.
 *
 * The face value is what a checkout request names a pack by. The `name` in the
 * price file identifies a tier to whoever edits it and appears in the message
 * for a tier with no price id; no screen reads it, and it is free to be
 * reworded.
 * @param priceCents - The listed price, before tax.
 * @returns The matching tier, or undefined
 */
export function findTierByPriceCents(
  priceCents: number,
): PricingTier | undefined {
  return getPricingTiers().find((t) => t.priceCents === priceCents);
}

/**
 * Find a tier by its Stripe Price ID.
 *
 * Used during webhook handling to determine how many credits to grant.
 * @param priceId - Stripe Price ID from the checkout session
 * @returns The matching tier, or undefined
 */
export function findTierByPriceId(priceId: string): PricingTier | undefined {
  return getPricingTiers().find((t) => t.stripePriceId === priceId);
}

/**
 * How many payments one reconcile pass takes, and how old they must be.
 * @returns Both bounds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getReconcileBounds(): ReconcileBounds {
  const { reconcile } = loadPricingFile();
  return {
    batchSize: reconcile.batch_size,
    minAgeSeconds: reconcile.min_age_seconds,
  };
}

/**
 * How long the page waits for the confirmation endpoint.
 * @returns That wait in milliseconds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getConfirmTimeoutMs(): number {
  return loadPricingFile().confirm_timeout_ms;
}

/**
 * How long a confirmation may sit in `sending` before a resend is offered.
 * @returns That wait in minutes.
 * @throws {Error} When the file is missing or malformed.
 */
export function getStaleSendingMinutes(): number {
  return loadPricingFile().stale_sending_minutes;
}

/** Reset cached tiers (for testing). */
export function resetPricingCache(): void {
  _cachedFile = null;
  _cachedTiers = null;
}
