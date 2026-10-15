// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Credit-pack refund disposition time limits.
 *
 * Loads `config/credit-refund.yaml`. Every key is required: a default
 * standing in for a renamed or dropped key would run the refund loop on a
 * number nobody chose.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Room the lease leaves after the Stripe calls of an attempt, for writing the answer back. */
const LEASE_HEADROOM_MS = 10_000;

const positiveInt = z.number().int().positive();

/** The file's shape, exported so its validation can be asserted. */
export const creditRefundSchema = z
  .object({
    stripe_call_timeout_ms: positiveInt,
    lease_seconds: positiveInt,
    loop_interval_seconds: positiveInt,
    backoff_base_seconds: positiveInt,
    backoff_max_seconds: positiveInt,
    max_attempts: positiveInt,
    stale_sending_minutes: positiveInt,
    reconcile_window_days: positiveInt,
  })
  // A resumed attempt calls Stripe three times under its lease (list,
  // create, list). A lease that ran out while its holder still waited would
  // let a second instance claim the disposition and throw the answer away.
  .refine(
    (c) => 3 * c.stripe_call_timeout_ms + LEASE_HEADROOM_MS < c.lease_seconds * 1000,
    {
      message:
        "3 * stripe_call_timeout_ms + 10000 must be less than lease_seconds * 1000",
      path: ["stripe_call_timeout_ms", "lease_seconds"],
    },
  );

/** The refund time limits, in the names the code uses. */
export interface CreditRefundConfig {
  stripeCallTimeoutMs: number;
  leaseSeconds: number;
  loopIntervalSeconds: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  maxAttempts: number;
  staleSendingMinutes: number;
  reconcileWindowDays: number;
}

let _cached: CreditRefundConfig | null = null;

/**
 * The refund time limits, read and validated once.
 * @returns The parsed configuration.
 * @throws {Error} When the file is missing or malformed.
 */
export function getCreditRefundConfig(): CreditRefundConfig {
  if (_cached) return _cached;
  const configPath = resolve(MONOREPO_ROOT, "config/credit-refund.yaml");
  const raw = creditRefundSchema.parse(parse(readFileSync(configPath, "utf-8")));
  _cached = {
    stripeCallTimeoutMs: raw.stripe_call_timeout_ms,
    leaseSeconds: raw.lease_seconds,
    loopIntervalSeconds: raw.loop_interval_seconds,
    backoffBaseSeconds: raw.backoff_base_seconds,
    backoffMaxSeconds: raw.backoff_max_seconds,
    maxAttempts: raw.max_attempts,
    staleSendingMinutes: raw.stale_sending_minutes,
    reconcileWindowDays: raw.reconcile_window_days,
  };
  return _cached;
}
