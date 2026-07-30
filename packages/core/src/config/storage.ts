// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Storage YAML configuration loader.
 *
 * Reads `config/storage.yaml` for download retry parameters (#1625 Slice 2).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const storageConfigSchema = z.object({
  download: z
    .object({
      /** Total download attempts including the first. */
      max_attempts: z.number().int().positive().default(3),
      /** Base backoff (ms); effective ceiling = base * attempt, then jittered. */
      retry_base_delay_ms: z.number().int().min(0).default(500),
    })
    .default({ max_attempts: 3, retry_base_delay_ms: 500 }),
  upload: z
    .object({
      /** Hard upload cap in bytes; presign rejects larger files (413). */
      max_upload_bytes: z.number().int().positive().default(2147483648),
      // Retry count and backoff base are absent by design: they are fixed in
      // the shared HTTP transport so browser and backend cannot diverge.
      /** Per-attempt browser API request timeout (ms); PUT timeout floor. */
      client_request_timeout_ms: z.number().int().positive().default(30000),
      /** PUT stall guard rate: per-attempt timeout = max(floor, size/rate). */
      client_put_min_bytes_per_sec: z.number().int().positive().default(65536),
      /** Presigned PUT URL expiry (s); the cloud PUT window (#1826, §3.2). */
      presign_expires_seconds: z.number().int().positive().default(300),
    })
    .default({
      max_upload_bytes: 2147483648,
      client_request_timeout_ms: 30000,
      client_put_min_bytes_per_sec: 65536,
      presign_expires_seconds: 300,
    }),
});

/** Validated storage configuration type. */
export type StorageConfig = z.infer<typeof storageConfigSchema>;

let _cached: Readonly<StorageConfig> | null = null;

/**
 * Load storage configuration from YAML.
 * @returns Frozen, validated config object
 */
export function getStorageConfig(): Readonly<StorageConfig> {
  if (_cached) return _cached;

  const configPath = resolve(MONOREPO_ROOT, "config/storage.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = storageConfigSchema.parse(parsed);

  _cached = Object.freeze(config);
  return _cached;
}
