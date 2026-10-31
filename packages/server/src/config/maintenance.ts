// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Validated, tracked operational limits for explicit recurring reclamation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT, type MaintenanceConfig } from "@breatic/core";
const positive = z.number().int().positive();

/**
 * Every execution parameter is explicit in the tracked file.
 */
export const maintenanceSchema = z.object({
  enabled: z.boolean(), loop_interval_seconds: positive, check_interval_seconds: positive, batch_size: positive.max(100), concurrency:positive.max(100), lease_seconds: positive, protection_seconds: z.number().int().nonnegative(), preview_ttl_seconds: positive, storage_timeout_ms: positive
}).strict().refine(c => c.lease_seconds * 1000 > 4 * c.storage_timeout_ms + 10000, {
  message: "lease must exceed four storage deadlines plus writeback headroom"
});
let cached: MaintenanceConfig | null = null;

/**
 * Load and validate the maintenance limits once.
 * @returns Execution configuration.
 * @throws {Error} On a missing or malformed configuration file.
 */
export function getMaintenanceConfig(): MaintenanceConfig {
  if (cached)
    return cached;
  const v = maintenanceSchema.parse(parse(readFileSync(resolve(MONOREPO_ROOT, "config/maintenance.yaml"), "utf8")));
  cached = {
    enabled: v.enabled, loopIntervalSeconds: v.loop_interval_seconds, checkIntervalSeconds: v.check_interval_seconds, batchSize: v.batch_size, concurrency:v.concurrency, leaseSeconds: v.lease_seconds, protectionSeconds: v.protection_seconds, previewTtlSeconds: v.preview_ttl_seconds, storageTimeoutMs: v.storage_timeout_ms
  };
  return cached;
}
