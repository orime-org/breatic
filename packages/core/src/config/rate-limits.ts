// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Rate-limit configuration loader.
 *
 * Loads per-action abuse throttles from a service's `rate-limits.yaml` (the
 * product's `config/` unless the caller names another directory): every
 * route that throttles reads its `{ max, windowSeconds }` from here instead
 * of hardcoding the numbers.
 * The key DIMENSION (see the yaml file's header) stays in code per action;
 * only the counts are tuned in yaml.
 *
 * A yaml file validated by a Zod schema and memoized per directory, like the
 * other config loaders.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

/** One action's window: `max` requests per `window_seconds`. */
const oneLimitSchema = z.object({
  max: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
});

/** Schema for `config/rate-limits.yaml` — a map of action → window. */
export const rateLimitsConfigSchema = z.record(z.string(), oneLimitSchema);

/** Parsed files, one per configuration directory. */
const cached = new Map<string, z.infer<typeof rateLimitsConfigSchema>>();

/**
 * Load and cache `rate-limits.yaml` from one configuration directory.
 * @param configDir - The directory holding the file.
 * @returns The validated action → window map (memoized per directory).
 * @throws {z.ZodError} if any entry is malformed.
 */
function loadConfig(configDir: string): z.infer<typeof rateLimitsConfigSchema> {
  const hit = cached.get(configDir);
  if (hit) return hit;
  const raw = readFileSync(resolve(configDir, "rate-limits.yaml"), "utf-8");
  const parsed = rateLimitsConfigSchema.parse(parse(raw) as unknown);
  cached.set(configDir, parsed);
  return parsed;
}

/**
 * Resolve one action's rate limit. Throws (fail-loud) when the action
 * is absent — a missing entry must not silently disable a throttle.
 * @param action - The throttle action name (matches the yaml key + the
 *   Redis prefix, e.g. `login` / `upload-ticket` / `asset-report`).
 * @param configDir - The service's configuration directory; the product's
 *   `config/` when absent.
 * @returns `{ max, windowSeconds }` for the action.
 * @throws {Error} when the action has no config entry.
 */
export function getRateLimit(
  action: string,
  configDir: string = resolve(MONOREPO_ROOT, "config"),
): {
  max: number;
  windowSeconds: number;
} {
  const entry = loadConfig(configDir)[action];
  if (!entry) {
    throw new Error(
      `Rate limit for action "${action}" is not configured in ${resolve(configDir, "rate-limits.yaml")}`,
    );
  }
  return { max: entry.max, windowSeconds: entry.window_seconds };
}
