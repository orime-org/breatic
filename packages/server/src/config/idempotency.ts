// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Run-once request configuration loader.
 *
 * Loads the running lease from `config/idempotency.yaml`. Only the server
 * reads it; how long a finished answer is kept is shared with the browser
 * and lives in `@breatic/shared`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/idempotency.yaml`. */
export const idempotencyConfigSchema = z.object({
  // Renewed every third of the lease; under 30 ms the renewal timer and the
  // Redis round trip are the same size.
  running_lease_ms: z.number().int().min(30).default(30_000),
});

let _cached: z.infer<typeof idempotencyConfigSchema> | null = null;

/**
 * Load and cache `config/idempotency.yaml`.
 * @returns The validated config (memoized after the first read).
 * @throws {z.ZodError} if a value is malformed.
 */
function loadConfig(): z.infer<typeof idempotencyConfigSchema> {
  if (_cached) return _cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config", "idempotency.yaml"), "utf-8");
  _cached = idempotencyConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}

/**
 * How long a running record lives without a renewal.
 * @returns Milliseconds.
 * @throws {z.ZodError} if `config/idempotency.yaml` is malformed.
 */
export function getRunningLeaseMs(): number {
  return loadConfig().running_lease_ms;
}
