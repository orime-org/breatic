// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Rate-limit configuration loader.
 *
 * Loads per-action abuse throttles from `config/rate-limits.yaml`:
 * every route that throttles (auth, studio, assets) reads its
 * `{ max, windowSeconds }` from here instead of hardcoding the numbers.
 * The key DIMENSION (IP vs user id) stays in code per action; only the
 * counts are tuned in yaml.
 *
 * Mirrors the `limits.ts` / `pricing.ts` / `text-tools.ts` business-
 * config loaders: a yaml file under `config/` validated by a Zod schema
 * and memoized. See `docs/CONFIGURATION.md` for the params catalog.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** One action's window: `max` requests per `window_seconds`. */
const oneLimitSchema = z.object({
  max: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
});

/** Schema for `config/rate-limits.yaml` — a map of action → window. */
export const rateLimitsConfigSchema = z.record(z.string(), oneLimitSchema);

let _cached: z.infer<typeof rateLimitsConfigSchema> | null = null;

/**
 * Load and cache the rate-limit config from `config/rate-limits.yaml`.
 * @returns The validated action → window map (memoized after first read).
 * @throws {z.ZodError} if any entry is malformed.
 */
function loadConfig(): z.infer<typeof rateLimitsConfigSchema> {
  if (_cached) return _cached;
  const dir = resolve(MONOREPO_ROOT, "config");
  const raw = readFileSync(resolve(dir, "rate-limits.yaml"), "utf-8");
  _cached = rateLimitsConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}

/**
 * Resolve one action's rate limit. Throws (fail-loud) when the action
 * is absent — a missing entry must not silently disable a throttle.
 * @param action - The throttle action name (matches the yaml key + the
 *   Redis prefix, e.g. `login` / `presign` / `asset-report`).
 * @returns `{ max, windowSeconds }` for the action.
 * @throws {Error} when the action has no config entry.
 */
export function getRateLimit(action: string): {
  max: number;
  windowSeconds: number;
} {
  const entry = loadConfig()[action];
  if (!entry) {
    throw new Error(
      `Rate limit for action "${action}" is not configured in config/rate-limits.yaml`,
    );
  }
  return { max: entry.max, windowSeconds: entry.window_seconds };
}
