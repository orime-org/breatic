// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Referral program settings, from `config/referral.yaml` (inner#1868).
 *
 * Mirrors the `legal.ts` loader: a yaml file under `config/` validated by a
 * Zod schema and memoized.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/referral.yaml`. */
export const referralConfigSchema = z.object({
  first_period_discount_percent: z.number().int().min(1).max(99).default(20),
});

/** The validated contents of `config/referral.yaml`. */
export type ReferralConfig = z.infer<typeof referralConfigSchema>;

let _cached: ReferralConfig | null = null;

/**
 * Load and cache the referral settings.
 * @returns The validated settings (memoized after the first read).
 * @throws {z.ZodError} if the percent is not a whole number from 1 to 99.
 */
export function getReferralConfig(): ReferralConfig {
  if (_cached) return _cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config", "referral.yaml"), "utf-8");
  _cached = referralConfigSchema.parse((parse(raw) as unknown) ?? {});
  return _cached;
}
