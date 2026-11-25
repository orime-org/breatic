// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How the product talks to the billing service (inner#1993 §3.1, §5.2):
 * loads `config/commerce.yaml`, read by the server's calls to the billing
 * service (timeouts, the membership price cache, the outbox relay) and the
 * worker's daily lot-mirror reconcile.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const positiveInt = z.number().int().positive();

/** Schema for `config/commerce.yaml`. */
export const commerceConfigSchema = z.object({
  call_timeout_ms: positiveInt.default(30_000),
  quick_call_timeout_ms: positiveInt.default(3000),
  catalog_cache_seconds: positiveInt.default(300),
  relay_interval_ms: positiveInt.default(5000),
  relay_batch: positiveInt.default(100),
  relay_call_timeout_ms: positiveInt.default(10_000),
  relay_max_attempts: positiveInt.default(50),
  relay_backoff_base_seconds: positiveInt.default(10),
  relay_backoff_max_seconds: positiveInt.default(3600),
  lot_mirror_reconcile_cron: z.string().min(1).default("0 3 * * *"),
  lot_mirror_reconcile_window_days: positiveInt.default(30),
});

export type CommerceConfig = z.infer<typeof commerceConfigSchema>;

let cached: CommerceConfig | null = null;

/**
 * The billing service settings, read and validated once.
 * @returns The parsed configuration.
 * @throws {Error} When the file is missing or malformed.
 */
export function getCommerceConfig(): CommerceConfig {
  if (cached) return cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/commerce.yaml"), "utf-8");
  cached = commerceConfigSchema.parse(parse(raw) as unknown);
  return cached;
}
