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
import { env, MONOREPO_ROOT } from "./env.js";

const tierSchema = z.object({
  name: z.string(),
  credits: z.number().int().positive(),
  price_cents: z.number().int().positive(),
  currency: z.string().default("usd"),
  description: z.string().default(""),
  stripe_price_id: z.object({
    test: z.string(),
    live: z.string(),
  }),
});

const pricingSchema = z.object({
  tiers: z.array(tierSchema),
});

/** Resolved pricing tier with the correct Stripe Price ID for this environment. */
export interface PricingTier {
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
  description: string;
  stripePriceId: string;
}

let _cachedTiers: PricingTier[] | null = null;

/**
 * Load and resolve pricing tiers from YAML config.
 *
 * Selects `test` or `live` Stripe Price ID based on `ENV`:
 * - `dev` / `staging` → `test`
 * - `prod` → `live`
 *
 * @returns Array of resolved pricing tiers
 */
export function getPricingTiers(): PricingTier[] {
  if (_cachedTiers) return _cachedTiers;

  const configPath = resolve(MONOREPO_ROOT, "config/pricing.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = pricingSchema.parse(parse(raw));

  const isLive = env.ENV === "prod";

  _cachedTiers = parsed.tiers.map((t) => ({
    name: t.name,
    credits: t.credits,
    priceCents: t.price_cents,
    currency: t.currency,
    description: t.description,
    stripePriceId: isLive ? t.stripe_price_id.live : t.stripe_price_id.test,
  }));

  return _cachedTiers;
}

/**
 * Find a tier by name (case-insensitive).
 *
 * @param name - Tier name (e.g. "Pro")
 * @returns The matching tier, or undefined
 */
export function findTierByName(name: string): PricingTier | undefined {
  return getPricingTiers().find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * Find a tier by its Stripe Price ID.
 *
 * Used during webhook handling to determine how many credits to grant.
 *
 * @param priceId - Stripe Price ID from the checkout session
 * @returns The matching tier, or undefined
 */
export function findTierByPriceId(priceId: string): PricingTier | undefined {
  return getPricingTiers().find((t) => t.stripePriceId === priceId);
}

/** Reset cached tiers (for testing). */
export function resetPricingCache(): void {
  _cachedTiers = null;
}
