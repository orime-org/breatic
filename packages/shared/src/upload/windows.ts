// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one part of an upload may take (#173).
 *
 * Two sides read this. The browser sizes each part's deadline with it, and
 * loading `config/storage.yaml` checks that the window the Durable Object
 * waits in is wider than the whole worst case — otherwise an upload that is
 * still retrying a part gets judged dead and every part already written is
 * dropped, and the operator who typed the figure reads about it at load.
 *
 * Both answers come from the same arithmetic on purpose. Two copies would
 * disagree the first time either side's figures moved.
 */

import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
} from "@shared/http/constants.js";

/**
 * The longest the transport can spend waiting between deliveries.
 *
 * Its own backoff is the smaller half of this: a server that names a wait is
 * waited for, up to the bound past which the transport stops instead of
 * substituting a figure of its own. So the bound is what a budget has to allow
 * for, whatever the transport would have picked unaided.
 */
const WAITS_BETWEEN_DELIVERIES_MS = MAX_RETRIES * MAX_RETRY_AFTER_MS;

/** The figures a part's deadline is sized from, as `config/storage.yaml` holds them. */
export interface PartDeadlineConfig {
  /** Floor for the stall guard, whatever the size says. */
  requestTimeoutMs: number;
  /** The transfer rate below which a delivery counts as stalled. */
  minBytesPerSec: number;
}

/**
 * One delivery's deadline: a stall guard rather than a deadline on the user.
 *
 * Sized to the bytes so a legitimately slow big part is never cut off, floored
 * so a tiny one still gets a usable window.
 * @param sizeBytes - What this delivery carries.
 * @param cfg - The figures the deadline is sized from.
 * @returns The deadline in milliseconds.
 */
export function partDeadlineMs(
  sizeBytes: number,
  cfg: PartDeadlineConfig,
): number {
  return Math.max(
    cfg.requestTimeoutMs,
    Math.ceil((sizeBytes / cfg.minBytesPerSec) * 1000),
  );
}

/**
 * The longest one part can occupy the browser before it gives up on it.
 *
 * Every delivery the transport makes may run to its deadline, and the waits
 * between them are full-jittered up to an exponential ceiling — so this is the
 * ceiling rather than a likely figure. It is what the Durable Object's idle
 * window has to be wider than: during a part's retries no part arrives, and an
 * alarm that fires in that gap drops every part already written.
 * @param sizeBytes - One part's size.
 * @param cfg - The figures the deadline is sized from.
 * @returns The worst-case milliseconds one part can take.
 */
export function partRetryBudgetMs(
  sizeBytes: number,
  cfg: PartDeadlineConfig,
): number {
  return (
    (MAX_RETRIES + 1) * partDeadlineMs(sizeBytes, cfg) +
    WAITS_BETWEEN_DELIVERIES_MS
  );
}

/**
 * The longest completing an upload can occupy the browser.
 *
 * It carries no bytes and names no deadline of its own, so every delivery runs
 * on the transport's default. What it carries instead is the token the last
 * part issued, and that token has to outlast this whole chain — one expiring
 * partway turns the delivery that would have succeeded into a 401.
 * @returns The worst-case milliseconds completing can take.
 */
export function completeRetryBudgetMs(): number {
  return (MAX_RETRIES + 1) * DEFAULT_TIMEOUT_MS + WAITS_BETWEEN_DELIVERIES_MS;
}

/**
 * How long a finished upload's answer stays available to a browser.
 *
 * The Durable Object holds what it decided until this passes, then lets go of
 * the instance. A browser is still entitled to ask through its transport's
 * whole redelivery budget, and the crop path reads its entire result off that
 * response — so the window covers both that budget and the gap a browser was
 * allowed to go quiet for.
 * @param alarmIdleSeconds - The gap the alarm tolerates between parts.
 * @returns The window in milliseconds.
 */
export function answerRetentionMs(alarmIdleSeconds: number): number {
  return Math.max(alarmIdleSeconds * 1000, completeRetryBudgetMs());
}

/** Every figure an upload's windows are decided by, all from `config/storage.yaml`. */
export interface UploadWindows extends PartDeadlineConfig {
  /** One part of a multipart upload, in bytes. */
  partSizeBytes: number;
  /** How long the Durable Object waits for a part before judging the upload dead. */
  alarmIdleSeconds: number;
  /**
   * How long a session token stays usable after the part that issued it. It
   * has to cover both the gap the alarm tolerates and the chain completing
   * runs, because one token is issued for both.
   */
  sessionTokenTtlSeconds: number;
  /**
   * How long a signed ticket stays usable. It has to run out before the
   * Durable Object lets go of a finished upload, because letting go is also
   * what makes the key look untouched again.
   */
  ticketExpiresSeconds: number;
}

/**
 * Refuse figures whose windows are narrower than what they have to hold.
 *
 * Both relations here are one-directional and easy to get backwards, and
 * getting either backwards fails an upload that is doing nothing wrong: a
 * short idle window drops parts a browser is still retrying, and a short
 * token turns the request after a long wait into a 401. They are checked when
 * the config loads rather than left to be discovered by a user.
 * @param windows - The figures, as the config holds them.
 * @throws {Error} When a window cannot hold what it has to.
 */
export function assertUploadWindows(windows: UploadWindows): void {
  const budgetMs = partRetryBudgetMs(windows.partSizeBytes, windows);
  if (windows.alarmIdleSeconds * 1000 < budgetMs) {
    throw new Error(
      `alarm_idle_seconds ${windows.alarmIdleSeconds} is under the ` +
        `${Math.ceil(budgetMs / 1000)}s one part can take to be delivered`,
    );
  }
  // Two things the token has to outlast, and it is issued once for both: the
  // gap the alarm tolerates between parts, and the chain completing runs.
  const mustOutlastMs = Math.max(
    windows.alarmIdleSeconds * 1000,
    completeRetryBudgetMs(),
  );
  if (windows.sessionTokenTtlSeconds * 1000 <= mustOutlastMs) {
    throw new Error(
      `session_token_ttl_seconds ${windows.sessionTokenTtlSeconds} is under ` +
        `the ${Math.ceil(mustOutlastMs / 1000)}s it has to outlast — the ` +
        `longest gap alarm_idle_seconds allows between parts, and the chain ` +
        `completing an upload runs`,
    );
  }
  // A finished upload's Durable Object holds its answer for this long and then
  // deletes everything it knew, which is also what stops it recognising the
  // key as already used. A ticket that outlives that could open a second
  // multipart upload over an object the ledger already describes, and the
  // sha256 on that row would stop describing the bytes.
  const retentionMs = answerRetentionMs(windows.alarmIdleSeconds);
  if (windows.ticketExpiresSeconds * 1000 >= retentionMs) {
    throw new Error(
      `ticket_expires_seconds ${windows.ticketExpiresSeconds} outlives the ` +
        `${Math.ceil(retentionMs / 1000)}s a finished upload is remembered ` +
        `for, so a ticket could reopen a key already registered`,
    );
  }
}
