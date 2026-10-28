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
import { COLLAB_FRAME_MAX_BYTES, COLLAB_PING_INTERVAL_MS, MAX_TIMER_MS } from "@breatic/shared";

/**
 * Room above the document cap for a message's own header (document name,
 * message type); real document names are under 100 bytes.
 */
const MESSAGE_HEADER_ALLOWANCE = 64 * 1024;

/**
 * The largest message one connection may reassemble.
 * @param cfg - The document cap and the reassembly budget.
 * @param cfg.max_document_bytes - The document cap, 0 for none.
 * @param cfg.reassembly_budget_bytes - The process reassembly budget.
 * @returns The per-connection cap in bytes.
 */
function deriveMaxMessageBytes(cfg: { max_document_bytes: number; reassembly_budget_bytes: number }): number {
  if (cfg.max_document_bytes === 0) return cfg.reassembly_budget_bytes;
  return Math.max(cfg.max_document_bytes + MESSAGE_HEADER_ALLOWANCE, COLLAB_FRAME_MAX_BYTES);
}

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
  connection_ping_interval_ms: z.number().int().positive().default(COLLAB_PING_INTERVAL_MS),

  // How often every connection's session is read again (inner#1548). Ended
  // sessions are announced and closed at once; this round catches what the
  // announcement could not reach, such as a session that simply expired.
  // Bounded by MAX_TIMER_MS: a timer turns a longer delay into 1 ms.
  session_recheck_interval_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(1_800_000),

  // Document size limit
  max_document_bytes: z.number().int().min(0).default(10_485_760), // 10 MB

  // Reassembly of messages larger than one WebSocket frame (inner#1585). The
  // per-connection cap is derived from max_document_bytes, see
  // `getReassemblyLimits`.
  reassembly_budget_bytes: z.number().int().gt(COLLAB_FRAME_MAX_BYTES).default(67_108_864),
  reassembly_idle_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(30_000),

  // Connection limits.
  //
  // Each document's writable connection ceiling comes from the owning
  // Studio's current admin membership reading. It resolves configured or
  // negotiated concurrent_editors and expiry together for each new handshake.

  // Throttle (coarse per-IP DoS backstop; loopback is exempt)
  throttle_enabled: z.boolean().default(true),
  throttle_max_attempts: z.number().int().positive().default(200),
  // ban length in MINUTES — shared-throttle.ts sets the ban key with EX
  // minutes*60, so this is NOT milliseconds (the 60000-read-as-ms bug = a 41.7-day ban).
  throttle_ban_time: z.number().int().positive().default(1),

  // Logging
  quiet: z.boolean().default(true),

  // Timed store (#40). Storing is driven by a timer rather than by edits,
  // so a failed write is retried and has no consequence for the editor.
  store_interval_ms: z.number().int().positive().default(10_000),

  // The shortest gap between two writes of one project's edit time from this
  // instance (inner#1020). Bounds how often stores reach the business database;
  // the studio list's "last edited" is at most this stale.
  project_edit_touch_interval_ms: z.number().int().positive().default(60_000),
  store_rescue_dir: z.string().default("logs/collab/rescue"),
  store_alert_email: z.string().default(""),
  store_alert_window_ms: z.number().int().positive().default(600_000),
  store_alert_timeout_ms: z.number().int().positive().default(3_000),
  event_max_held: z.number().int().positive().default(128),
  event_block_ms: z.number().int().positive().default(5000),
  event_doc_concurrency: z.number().int().positive().default(16),
  event_doc_lease_ms: z.number().int().positive().default(30_000),
  event_lease_retry_ms: z.number().int().positive().default(1000),
  event_handoff_poll_ms: z.number().int().positive().default(50),
  event_handoff_wait_ms: z.number().int().positive().default(5000),
  event_claim_interval_ms: z.number().int().positive().default(15_000),
  event_claim_idle_ms: z.number().int().positive().default(60_000),
  event_retry_min_ms: z.number().int().positive().default(10_000),
  event_retry_max_ms: z.number().int().positive().default(600_000),
  event_max_failures: z.number().int().positive().default(5),
  event_stop_deadline_ms: z.number().int().positive().default(3000),
  event_forget_idle_consumer_ms: z.number().int().positive().default(86_400_000),
  unload_store_retry_ms: z.number().int().positive().default(1200),
  unload_store_retry_interval_ms: z.number().int().positive().default(200),
  unload_rescue_reserve_ms: z.number().int().nonnegative().default(1000),
}).superRefine((cfg, ctx) => {
  // One account may hold one full message; the budget must leave room for
  // another member's full message beside it.
  if (cfg.max_document_bytes === 0) return;
  const floor = 2 * deriveMaxMessageBytes(cfg);
  if (cfg.reassembly_budget_bytes < floor) {
    ctx.addIssue({
      code: "custom",
      path: ["reassembly_budget_bytes"],
      message: `must be at least ${floor}, twice the largest message one connection may send`,
    });
  }
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

/** The limits on reassembling chunked messages, in bytes and milliseconds. */
export interface ReassemblyLimits {
  /** The largest single WebSocket frame. */
  frameMaxBytes: number;
  /** The largest message one connection, and one user, may reassemble. */
  maxMessageBytes: number;
  /** What all connections together may hold while reassembling. */
  budgetBytes: number;
  /** The longest wait between two chunks. */
  idleTimeoutMs: number;
}

/**
 * The reassembly limits, with the per-connection cap derived from the
 * document cap.
 * @returns The limits.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function getReassemblyLimits(): ReassemblyLimits {
  const cfg = getCollabConfig();
  return {
    frameMaxBytes: COLLAB_FRAME_MAX_BYTES,
    maxMessageBytes: deriveMaxMessageBytes(cfg),
    budgetBytes: cfg.reassembly_budget_bytes,
    idleTimeoutMs: cfg.reassembly_idle_timeout_ms,
  };
}
