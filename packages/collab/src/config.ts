// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Collab server YAML configuration loader.
 *
 * Reads `config/collab.yaml` and returns validated, typed config.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// NOTE: no `port` here. The WebSocket port moved to the core env schema
// (`COLLAB_PORT`) alongside the other service ports — this file is behaviour
// knobs only. See config/collab.yaml's header (#1831).
const collabConfigSchema = z.object({
  // Document lifecycle
  unload_immediately: z.boolean().default(true),
  debounce: z.number().int().positive().default(2000),
  max_debounce: z.number().int().positive().default(10000),

  // How often the transport pings every connection. crossws defaults its
  // `idleTimeout` option to 30 seconds and Hocuspocus never passes that
  // option, so this states the transport's behaviour rather than setting it;
  // an integration test
  // measures the real interval. Both liveness expiries are derived from it —
  // see `getConnectionTimings`.
  connection_ping_interval_ms: z.number().int().positive().default(30_000),

  // Document size limit
  max_document_bytes: z.number().int().min(0).default(10_485_760), // 10 MB

  // Connection limits.
  //
  // The per-document ceiling on WRITABLE connections is not here: it comes
  // from the membership tier of the studio that owns the project
  // (`concurrent_editors` in config/membership.yaml), so it differs per
  // project and cannot be a process-wide constant (#88).
  //
  // Documents one socket must carry, which several library ceilings are
  // derived from — see infra/socket-ceilings.ts and collab.yaml. Not
  // `min(0)`: the library compares the pending count with `>=`, so zero would
  // close every socket on its first document.
  max_documents_per_socket: z.number().int().positive().default(1000),

  // Throttle (coarse per-IP DoS backstop; loopback is exempt)
  throttle_enabled: z.boolean().default(true),
  throttle_max_attempts: z.number().int().positive().default(200),
  // ban length in MINUTES — the throttle extension multiplies by 60*1000, so
  // this is NOT milliseconds (the 60000-read-as-ms bug = a 41.7-day ban).
  throttle_ban_time: z.number().int().positive().default(1),

  // Logging
  quiet: z.boolean().default(true),

  // Timed store (#40). Storing is driven by a timer rather than by edits,
  // so a failed write is retried and has no consequence for the editor.
  store_interval_ms: z.number().int().positive().default(10_000),
  store_rescue_dir: z.string().default("logs/collab/rescue"),
  store_alert_email: z.string().default(""),
  store_alert_window_ms: z.number().int().positive().default(600_000),
  store_alert_timeout_ms: z.number().int().positive().default(3_000),
});

/** Validated collab configuration type. */
export type CollabConfig = z.infer<typeof collabConfigSchema>;

let _cached: Readonly<CollabConfig> | null = null;

/**
 * Load collab's behaviour configuration from YAML.
 *
 * Pure YAML — no env involved. The WebSocket port used to be declared here as
 * a plain YAML key with a schema default, which put one service port in a
 * different place from the other three (they were already in the core env
 * schema) and left it unsettable from `.env`. It moved to the core env schema
 * in #1831, so this loader is back to one job: behaviour knobs.
 * @returns Frozen, validated config object
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function getCollabConfig(): Readonly<CollabConfig> {
  if (_cached) return _cached;

  const configPath = resolve(import.meta.dirname, "../../../config/collab.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;

  _cached = Object.freeze(collabConfigSchema.parse(parsed));
  return _cached;
}

/** The ping interval and the two expiries derived from it, in milliseconds. */
export interface ConnectionTimings {
  /** How often the transport pings each connection. */
  pingIntervalMs: number;
  /** How long a seat in the per-document registry is believed. */
  seatExpiryMs: number;
  /** How long an "online" presence record is believed. */
  presenceStaleAfterMs: number;
}

/**
 * How long a connection is believed once it stops answering.
 *
 * A seat and a presence record answer the same question — is this connection
 * still there — so both are believed for the same span, and both are derived
 * here rather than written down twice. Two ping periods, because that is how
 * long the transport itself can take: its sweep runs once per period and both
 * terminates the sockets that showed no sign of life since the previous one
 * and pings the rest, so the last pong can be almost a whole period old when
 * the sweep that arms a socket runs.
 * @returns The declared interval and the two expiries.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function getConnectionTimings(): ConnectionTimings {
  const pingIntervalMs = getCollabConfig().connection_ping_interval_ms;
  return {
    pingIntervalMs,
    seatExpiryMs: pingIntervalMs * 2,
    presenceStaleAfterMs: pingIntervalMs * 2,
  };
}
