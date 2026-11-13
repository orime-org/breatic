// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Usage pricing loader (#296).
 *
 * Reads `config/usage-pricing.yaml`: what the agent's paid service calls cost
 * when the service answering them reports no cost of its own, per request.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const price = z.number().nonnegative();

const servicePriceSchema = z.object({ per_request: price });

const usagePricingSchema = z.object({
  services: z.object({
    brave_web_search: servicePriceSchema,
    brave_image_search: servicePriceSchema,
  }),
});

/** Validated usage prices, in US dollars. */
export type UsagePricing = z.infer<typeof usagePricingSchema>;

let _cached: Readonly<UsagePricing> | null = null;

/**
 * Validate a parsed pricing table.
 * @param raw - The parsed YAML.
 * @returns The validated table, frozen.
 * @throws {z.ZodError} When a price is missing, negative or malformed.
 */
export function parseUsagePricing(raw: unknown): Readonly<UsagePricing> {
  return Object.freeze(usagePricingSchema.parse(raw));
}

/**
 * Load the usage prices from YAML.
 * @returns Frozen, validated prices, memoized after the first read.
 * @throws {z.ZodError} When a price is missing, negative or malformed.
 */
export function getUsagePricing(): Readonly<UsagePricing> {
  if (_cached) return _cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/usage-pricing.yaml"), "utf-8");
  _cached = parseUsagePricing(parse(raw) as unknown);
  return _cached;
}
