// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe catch-up configuration loader: `config/stripe-catchup.yaml`, read
 * by `scripts/stripe-catchup.ts` only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/stripe-catchup.yaml`. */
export const stripeCatchUpConfigSchema = z.object({
  lookback_hours: z.number().int().positive().default(96),
});

/**
 * How far before the stop the catch-up lists events from.
 * @returns Hours.
 * @throws {Error} When the file is missing or malformed.
 */
export function getStripeCatchUpLookbackHours(): number {
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config", "stripe-catchup.yaml"), "utf-8");
  return stripeCatchUpConfigSchema.parse(parse(raw) as unknown).lookback_hours;
}
