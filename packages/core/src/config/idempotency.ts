// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Run-once request configuration loader.
 *
 * Loads the running lease from a service's `idempotency.yaml`; how long a finished answer is kept is shared with the browser
 * and lives in `@breatic/shared`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

/** Schema for `config/idempotency.yaml`. */
export const idempotencyConfigSchema = z.object({
  // Renewed every third of the lease; under 30 ms the renewal timer and the
  // Redis round trip are the same size.
  running_lease_ms: z.number().int().min(30).default(30_000),
});

/** Parsed files, one per configuration directory. */
const cached = new Map<string, z.infer<typeof idempotencyConfigSchema>>();

/**
 * Load and cache `idempotency.yaml` from one configuration directory.
 * @param configDir - The directory holding the file.
 * @returns The validated config (memoized per directory).
 * @throws {z.ZodError} if a value is malformed.
 */
function loadConfig(configDir: string): z.infer<typeof idempotencyConfigSchema> {
  const hit = cached.get(configDir);
  if (hit) return hit;
  const raw = readFileSync(resolve(configDir, "idempotency.yaml"), "utf-8");
  const parsed = idempotencyConfigSchema.parse(parse(raw) as unknown);
  cached.set(configDir, parsed);
  return parsed;
}

/**
 * How long a running record lives without a renewal.
 * @param configDir - The service's configuration directory; the product's
 *   `config/` when absent.
 * @returns Milliseconds.
 * @throws {z.ZodError} if the file is malformed.
 */
export function getRunningLeaseMs(configDir: string = resolve(MONOREPO_ROOT, "config")): number {
  return loadConfig(configDir).running_lease_ms;
}
