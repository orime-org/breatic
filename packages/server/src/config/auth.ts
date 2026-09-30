// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sign-up code settings from `config/auth.yaml`: how long a code lives, how
 * many comparisons it allows, and how soon the same address can get another.
 *
 * Mirrors the `limits.ts` loader: a yaml file under `config/` validated by a
 * Zod schema and memoized.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

const positiveInt = z.number().int().positive();

/** Schema for `config/auth.yaml`. */
export const authConfigSchema = z.object({
  signup_code: z
    .object({
      ttl_seconds: positiveInt.default(600),
      max_attempts_per_code: positiveInt.default(5),
      resend_cooldown_seconds: positiveInt.default(60),
    })
    .default({ ttl_seconds: 600, max_attempts_per_code: 5, resend_cooldown_seconds: 60 }),
});

/** The sign-up code settings, in the units the service works in. */
export interface SignupCodeConfig {
  ttlSeconds: number;
  maxAttemptsPerCode: number;
  resendCooldownSeconds: number;
}

let _cached: SignupCodeConfig | null = null;

/**
 * Load and cache the sign-up code settings.
 * @returns The validated settings (memoized after the first read).
 * @throws {z.ZodError} if a value is malformed (non-positive / non-integer).
 */
export function getSignupCodeConfig(): SignupCodeConfig {
  if (_cached) return _cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config", "auth.yaml"), "utf-8");
  const { signup_code: c } = authConfigSchema.parse(parse(raw) as unknown);
  _cached = {
    ttlSeconds: c.ttl_seconds,
    maxAttemptsPerCode: c.max_attempts_per_code,
    resendCooldownSeconds: c.resend_cooldown_seconds,
  };
  return _cached;
}
