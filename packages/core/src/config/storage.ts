// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage YAML configuration loader.
 *
 * Reads `config/storage.yaml`: the browser-side upload knobs, the figures
 * the ingest Worker runs on, and the studio-avatar byte cap.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MIN_PART_SIZE_BYTES, assertUploadWindows } from "@breatic/shared";
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
export const storageConfigSchema = z
  .object({
  upload: z
    .object({
      /** Hard upload cap in bytes; the ticket endpoint rejects larger files (413). */
      max_upload_bytes: z.number().int().positive().default(2147483648),
      /** Browser TICKET attempts including the first. A part is retried by the shared HTTP transport, which compiles its own count. */
      client_max_attempts: z.number().int().positive().default(3),
      /** Base backoff (ms) between browser TICKET retry attempts. */
      client_retry_base_delay_ms: z.number().int().min(0).default(1000),
      /** Floor for the part stall guard. Despite the name it does not time any API request: the ticket is timed by the axios client. */
      client_request_timeout_ms: z.number().int().positive().default(30000),
      /** Part stall guard rate: per-attempt timeout = max(floor, size/rate). */
      client_put_min_bytes_per_sec: z.number().int().positive().default(65536),
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
       * How long an upload may go without a new part arriving, in seconds. The
       * Durable Object pushes its alarm out by this much on every part, so an
       * upload that keeps moving is never cut off however large the file is,
       * and one that stops is judged dead this long after its last part.
       */
      alarm_idle_seconds: z.number().int().positive().default(600),
      /**
       * How long a session token stays usable, in seconds. One token covers
       * two waits — the longest gap the alarm tolerates between parts, and the
       * chain completing an upload runs — which is why it is checked against
       * both below rather than picked on its own.
       */
      session_token_ttl_seconds: z.number().int().positive().default(1200),
    })
    .prefault({}),

  avatar: z
    .object({
      /**
       * Hard cap on an avatar upload, in bytes. Unlike a project asset, an
       * avatar arrives THROUGH the server (it never goes near the Worker), so
       * this bound is also the bound on what the process buffers for one
       * request — and it is the only thing the server measures about the
       * picture, which is not the same as the only thing it checks: the bytes
       * are also sniffed to decide the stored extension, and a signature with
       * no entry in that table is refused.
       */
      max_bytes: z.number().int().positive().default(2097152),
    })
    .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    // Across sections, because the part size is an ingest knob while the
    // deadline each part is delivered under comes from the upload ones. Both
    // relations fail an upload that is doing nothing wrong when they are the
    // wrong way round, and neither is visible from inside either section.
    try {
      assertUploadWindows({
        partSizeBytes: cfg.ingest.part_size_bytes,
        alarmIdleSeconds: cfg.ingest.alarm_idle_seconds,
        sessionTokenTtlSeconds: cfg.ingest.session_token_ttl_seconds,
        ticketExpiresSeconds: cfg.ingest.ticket_expires_seconds,
        requestTimeoutMs: cfg.upload.client_request_timeout_ms,
        minBytesPerSec: cfg.upload.client_put_min_bytes_per_sec,
      });
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
        path: ["ingest"],
      });
    }
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
