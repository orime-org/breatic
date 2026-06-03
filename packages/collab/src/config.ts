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
  max_connections_per_document: z.number().int().min(0).default(50),

  // Throttle
  throttle_enabled: z.boolean().default(true),
  throttle_max_attempts: z.number().int().positive().default(15),
  throttle_ban_time: z.number().int().positive().default(60000),

  // Logging
  quiet: z.boolean().default(true),
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
