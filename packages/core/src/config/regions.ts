// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Region settings loader (inner#1955): reads `config/regions.yaml`, the
 * waits, intervals and sizes of the calls between regions.
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
    storage_usage_sync_interval_ms: millis.default(30000),
    slug_reservation_sweep_interval_ms: millis.default(60000),
    slug_reservation_stale_ms: millis.default(600000),
    transfer_accepting_sweep_interval_ms: millis.default(60000),
    transfer_accepting_stale_ms: millis.default(60000),
    studio_creation_sweep_interval_ms: millis.default(60000),
    studio_creation_stale_ms: millis.default(120000),
    slug_reservation_sweep_batch: z.number().int().positive().default(50),
    outbox_relay_batch: z.number().int().positive().default(100),
    storage_usage_report_batch: z.number().int().positive().default(500),
    maintenance_forward_timeout_ms: millis.default(300000),
    hold_cleanup_retry_attempts: z.number().int().positive().default(12),
    hold_cleanup_retry_base_ms: millis.default(5000),
    region_api_body_max_bytes: z.number().int().positive().default(4 * 1024 * 1024),
  })
  .refine((c) => c.outbox_relay_interval_ms + c.profile_cache_ttl_ms <= 60_000, {
    message: "outbox_relay_interval_ms + profile_cache_ttl_ms must stay within 60000 so a rename reaches every region within a minute",
  });

/** The region waits and intervals in milliseconds, and the sizes in items or bytes. */
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
