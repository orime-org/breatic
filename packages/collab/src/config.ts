// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Collab server YAML configuration loader.
 *
 * Reads `config/collab.yaml` and returns validated, typed config.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const collabConfigSchema = z.object({
  port: z.number().int().positive().default(1234),

  // Document lifecycle
  unload_immediately: z.boolean().default(true),
  debounce: z.number().int().positive().default(2000),
  max_debounce: z.number().int().positive().default(10000),

  // Document size limit
  max_document_bytes: z.number().int().min(0).default(10_485_760), // 10 MB

  // Connection limits
  max_connections_per_document: z.number().int().min(0).default(100),

  // Throttle (coarse per-IP DoS backstop; loopback is exempt)
  throttle_enabled: z.boolean().default(true),
  throttle_max_attempts: z.number().int().positive().default(200),
  // ban length in MINUTES — the throttle extension multiplies by 60*1000, so
  // this is NOT milliseconds (the 60000-read-as-ms bug = a 41.7-day ban).
  throttle_ban_time: z.number().int().positive().default(1),

  // Logging
  quiet: z.boolean().default(true),

  // Handling lease (#1580) — collab is the ONLY consumer. See collab.yaml.
  handling_lease: z
    .object({
      // Default per-phase lease budget (ms). 1h.
      default_budget_ms: z.number().int().positive().default(3_600_000),
      // Per-operation execution-budget overrides (ms), keyed by node
      // `data.operation`. Empty = every op uses the default.
      budget_overrides: z.record(z.string(), z.number().int().positive()).default({}),
    })
    // zod v4 `.default()` takes the resolved OUTPUT shape, so spell it out.
    .default({ default_budget_ms: 3_600_000, budget_overrides: {} }),
});

/** Validated collab configuration type. */
export type CollabConfig = z.infer<typeof collabConfigSchema>;

let _cached: Readonly<CollabConfig> | null = null;

/**
 * Load collab configuration from YAML.
 * @returns Frozen, validated config object
 */
export function getCollabConfig(): Readonly<CollabConfig> {
  if (_cached) return _cached;

  const configPath = resolve(import.meta.dirname, "../../../config/collab.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = collabConfigSchema.parse(parsed);

  _cached = Object.freeze(config);
  return _cached;
}
