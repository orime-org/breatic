// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Storage YAML configuration loader.
 *
 * Reads `config/storage.yaml`: download retry parameters, the browser-side
 * upload knobs and presign window, and the studio-avatar byte cap.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

/**
 * The shape `config/storage.yaml` is parsed against.
 *
 * Every number is written ONCE, at its own key. Sections use `prefault({})`
 * rather than `default({...})`, and the difference is not stylistic: zod's
 * `default` substitutes its value and hands it back, while `prefault`
 * substitutes and then parses, so an empty object flows through the key
 * defaults below. Measured, with `max_bytes` defaulting to 2097152:
 *
 * ```
 * z.object({ … }).prefault({}) .parse({})  ->  { max_bytes: 2097152 }
 * z.object({ … }).default({})  .parse({})  ->  { }
 * ```
 *
 * Repeating the numbers in a section-level `default` is what this replaces,
 * and it had already gone wrong once: `avatar.max_bytes` said 2 MiB at its key
 * and 1 MiB in its section for a while. Nothing failed — the shipped yaml
 * always supplies a value, and no deployment reaches these defaults
 * (`config/storage.yaml` is tracked, the Dockerfile copies the whole `config/`
 * directory, compose mounts nothing over it, and the path is derived from the
 * filesystem with no env override) — so the disagreement simply sat there.
 *
 * The failure mode that repetition invites is worse than disagreement: a
 * section-level default that OMITS a key yields `undefined` at runtime for a
 * property typed `number`, because that object is never parsed. For
 * `avatar.max_bytes` that reaches `readBoundedBody(c, undefined)`, whose
 * `length > maxBytes` comparisons are then false for every input — the byte
 * cap disappears while the type still says it is there. `prefault` removes the
 * place that mistake could be made.
 *
 * A section written as a bare `avatar:` key is YAML null, which is rejected
 * rather than defaulted, under either spelling. Commenting a section's body
 * out is a config error here, not a fallback.
 *
 * Exported for tests only, and not re-exported from the package barrel — the
 * one thing application code should reach for is {@link getStorageConfig}.
 */
export const storageConfigSchema = z.object({
  download: z
    .object({
      /** Total download attempts including the first. */
      max_attempts: z.number().int().positive().default(3),
      /** Base backoff (ms); effective ceiling = base * attempt, then jittered. */
      retry_base_delay_ms: z.number().int().min(0).default(500),
    })
    .prefault({}),
  upload: z
    .object({
      /** Hard upload cap in bytes; presign rejects larger files (413). */
      max_upload_bytes: z.number().int().positive().default(2147483648),
      /** Browser PRESIGN attempts including the first. The PUT is retried by the shared HTTP transport, which compiles its own count. */
      client_max_attempts: z.number().int().positive().default(3),
      /** Base backoff (ms) between browser PRESIGN retry attempts. */
      client_retry_base_delay_ms: z.number().int().min(0).default(1000),
      /** Floor for the PUT stall guard. Despite the name it does not time any API request: presign is timed by the axios client. */
      client_request_timeout_ms: z.number().int().positive().default(30000),
      /** PUT stall guard rate: per-attempt timeout = max(floor, size/rate). */
      client_put_min_bytes_per_sec: z.number().int().positive().default(65536),
      /** Presigned PUT URL expiry (s); the cloud PUT window (#1826, §3.2). */
      presign_expires_seconds: z.number().int().positive().default(300),
    })
    .prefault({}),

  avatar: z
    .object({
      /**
       * Hard cap on an avatar upload, in bytes. Unlike a project asset, an
       * avatar arrives THROUGH the server (no presigned direct upload), so
       * this bound is also the bound on what the process buffers for one
       * request — and it is the only thing the server measures about the
       * picture, which is not the same as the only thing it checks: the bytes
       * are also sniffed to decide the stored extension, and a signature with
       * no entry in that table is refused.
       */
      max_bytes: z.number().int().positive().default(2097152),
    })
    .prefault({}),
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
