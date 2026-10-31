// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage YAML configuration loader.
 *
 * Reads `config/storage.yaml`: the browser-side upload knobs and the figures
 * the ingest Worker runs on.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MIN_PART_SIZE_BYTES } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

/**
 * The shape `config/storage.yaml` is parsed against.
 *
 * Every number is written ONCE, at its own key. Sections use `prefault({})`
 * rather than `default({...})`, and the difference is not stylistic: zod's
 * `default` substitutes its value and hands it back, while `prefault`
 * substitutes and then parses, so an empty object flows through the key
 * defaults below. Measured, with `max_upload_bytes` defaulting to 2147483648:
 *
 * ```
 * z.object({ … }).prefault({}) .parse(undefined)  ->  { max_upload_bytes: 2147483648 }
 * z.object({ … }).default({})  .parse(undefined)  ->  { }
 * ```
 *
 * Repeating the numbers in a section-level `default` invites two failures.
 * The two copies drift apart, and nothing notices, because the shipped yaml
 * always supplies a value (`config/storage.yaml` is tracked, the Dockerfile
 * copies the whole `config/` directory, compose mounts nothing over it, and
 * the path is derived from the filesystem with no env override). Worse, a
 * section-level default that OMITS a key yields `undefined` at runtime for a
 * property typed `number`, because that object is never parsed. `prefault`
 * removes the place either mistake could be made.
 *
 * A section written as a bare `upload:` key is YAML null, which is rejected
 * rather than defaulted, under either spelling. Commenting a section's body
 * out is a config error here, not a fallback.
 *
 * Exported for tests only, and not re-exported from the package barrel — the
 * one thing application code should reach for is {@link getStorageConfig}.
 */
export const storageConfigSchema = z
  .object({
  upload: z
    .object({
      /** Hard upload cap in bytes; the ticket endpoint rejects larger files (413). */
      max_upload_bytes: z.number().int().positive().default(2147483648),
      /** Browser attempts including the first, for the ticket request and the finish. A part is retried by the shared HTTP transport, which compiles its own count. */
      client_max_attempts: z.number().int().positive().default(3),
      /** Base backoff (ms) between those same browser attempts. */
      client_retry_base_delay_ms: z.number().int().min(0).default(1000),
      /**
       * How long one part may go without a byte moving, in seconds, before it
       * is cut and sent again (inner#1367). An idle window: a slow part that
       * keeps moving is never cut. 60 is where Uppy's maintainers moved their
       * 30-second default after it cut uploads on slow links.
       */
      upload_idle_timeout_seconds: z.number().int().positive().default(60),
      /**
       * How long the browser waits between asking how its uploads ended, in
       * seconds; sent as `Retry-After` on every status answer (inner#1367).
       */
      upload_status_poll_seconds: z.number().int().positive().default(2),
    })
    .prefault({}),

  ingest: z
    .object({
      /**
       * One part of a multipart upload, in bytes. R2 refuses a non-final part
       * under 5 MiB; `signUploadTicket` enforces the same floor when it signs
       * a multi-part ticket, so a config below it would fail at request time
       * rather than at load.
       */
      part_size_bytes: z
        .number()
        .int()
        .min(
          MIN_PART_SIZE_BYTES,
          `part_size_bytes must be at least ${MIN_PART_SIZE_BYTES} — R2 refuses a non-final part below 5 MiB, so every multi-part upload would be rejected mid-flight.`,
        )
        .default(8388608),
      /**
       * How long the browser has to START the upload, in seconds. Checked once
       * by the ingest Worker; an upload already running is never cut off by it.
       */
      ticket_expires_seconds: z.number().int().positive().default(300),
      /**
       * The quality a JPEG or lossy WebP is re-encoded at when the ingest
       * Worker turns a picture shown at an EXIF orientation upright
       * (inner#1367). Turning a JPEG re-encodes it.
       */
      upright_jpeg_quality: z.number().int().min(1).max(100).default(90),
    })
    .prefault({}),

  /**
   * Transfer uploads (inner#1006): a request body too large for the API,
   * moved through storage. Sizes count the whole transfer file, signature
   * line included.
   */
  transfer: z
    .object({
      /** Largest transfer file each route that accepts one may reference. */
      route_max_bytes: z
        .object({
          chat_message: z.number().int().positive().default(4194304),
          canvas_paste: z.number().int().positive().default(25165824),
          node_history_snapshot: z.number().int().positive().default(25165824),
        })
        .prefault({}),
      /** How long, in seconds, a finished transfer may be referenced (once). */
      reference_ttl_seconds: z.number().int().positive().default(3600),
      /** How long, in seconds, one user's in-flight transfer read holds its lock. */
      read_lock_seconds: z.number().int().positive().default(60),
      /** How long, in seconds, a reference waits for that lock before answering 429. */
      read_lock_wait_seconds: z.number().int().positive().default(10),
      /** How long, in milliseconds, a waiting reference sleeps between tries for the lock. */
      read_lock_retry_ms: z.number().int().positive().default(100),
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
