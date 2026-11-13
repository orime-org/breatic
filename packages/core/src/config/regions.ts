// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Region timing loader (inner#1955): reads `config/regions.yaml`, the waits
 * and intervals of the calls between regions.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const millis = z.number().int().positive();

/**
 * The shape `config/regions.yaml` is parsed against.
 *
 * Exported for tests only; application code reads {@link getRegionsConfig}.
 */
export const regionsConfigSchema = z
  .object({
    global_api_timeout_ms: millis.default(5000),
    region_probe_timeout_ms: millis.default(2000),
    cross_region_fanout_timeout_ms: millis.default(2000),
    outbox_relay_interval_ms: millis.default(1000),
    profile_cache_ttl_ms: millis.default(30000),
    limits_cache_ttl_ms: millis.default(60000),
    transfer_accepting_sweep_interval_ms: millis.default(60000),
    transfer_accepting_stale_ms: millis.default(60000),
    studio_creation_sweep_interval_ms: millis.default(60000),
    studio_creation_stale_ms: millis.default(120000),
  })
  .refine((c) => c.outbox_relay_interval_ms + c.profile_cache_ttl_ms <= 60_000, {
    message: "outbox_relay_interval_ms + profile_cache_ttl_ms must stay within 60000 so a rename reaches every region within a minute",
  });

/** The region waits and intervals, in milliseconds. */
export type RegionsConfig = z.infer<typeof regionsConfigSchema>;

let cached: RegionsConfig | null = null;

/**
 * Reads and validates `config/regions.yaml` once.
 * @returns The region waits and intervals.
 * @throws {Error} When the file is missing or malformed.
 */
export function getRegionsConfig(): RegionsConfig {
  if (cached) return cached;
  const configPath = resolve(MONOREPO_ROOT, "config/regions.yaml");
  cached = regionsConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
  return cached;
}
