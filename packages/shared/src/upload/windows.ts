// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one part of an upload may take (#173).
 *
 * Two sides read this. The browser sizes each part's deadline with it, and
 * loading `config/storage.yaml` checks that a session token outlasts the
 * longest chain it can be carried through — otherwise the delivery that would
 * have succeeded comes back a 401, and the operator who typed the figure reads
 * about it at load.
 *
 * Both answers come from the same arithmetic on purpose. Two copies would
 * disagree the first time either side's figures moved.
 */

import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_MS,
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
 * ceiling rather than a likely figure. It is one of the two chains a session
 * token has to outlast: the token the previous part issued is what the whole
 * of this one is carried on.
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

/** Every figure an upload's windows are decided by, all from `config/storage.yaml`. */
export interface UploadWindows extends PartDeadlineConfig {
  /** One part of a multipart upload, in bytes. */
  partSizeBytes: number;
  /**
   * How long a session token stays usable after the part that issued it. One
   * token is carried through a whole part's retry chain and through the chain
   * completing runs, so it has to outlast the longer of the two.
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
 * Every relation here is one-directional and easy to get backwards, and getting
 * one backwards fails an upload that is doing nothing wrong: a deadline no
 * timer can hold stops a part before it is sent, and a short token turns the
 * request after a long wait into a 401. They are checked when the config loads rather than
 * left to be discovered by a user.
 * @param windows - The figures, as the config holds them.
 * @throws {Error} When a window cannot hold what it has to.
 */
export function assertUploadWindows(windows: UploadWindows): void {
  // What the browser hands the transport is one part's deadline, and the
  // transport refuses a deadline no timer can hold rather than clamping it —
  // before the first delivery. So a pair of knobs able to produce such a figure
  // does not weaken the guard, it takes every upload down with an error written
  // for a programmer. Neither knob is anything the person uploading chose, so
  // the refusal belongs here, where the operator who typed the number reads it.
  const deadlineMs = partDeadlineMs(windows.partSizeBytes, windows);
  if (deadlineMs > MAX_TIMER_MS) {
    const lowestRate = Math.ceil((windows.partSizeBytes * 1000) / MAX_TIMER_MS);
    throw new Error(
      windows.requestTimeoutMs > MAX_TIMER_MS
        ? `client_request_timeout_ms ${windows.requestTimeoutMs} is past the ` +
          `${MAX_TIMER_MS}ms a timer can hold; it floors every part's ` +
          `deadline, so no part could be sent`
        : `client_put_min_bytes_per_sec ${windows.minBytesPerSec} gives one ` +
          `${windows.partSizeBytes}-byte part a deadline of ${deadlineMs}ms, ` +
          `past the ${MAX_TIMER_MS}ms a timer can hold; no part could be ` +
          `sent. Raise it to at least ${lowestRate}, or lower part_size_bytes`,
    );
  }

  // Two chains one token is carried through: the part it was issued for, whose
  // retries all present it, and the chain completing runs. It has to outlast
  // the longer of them — one expiring partway turns the delivery that would
  // have succeeded into a 401.
  const mustOutlastMs = Math.max(
    partRetryBudgetMs(windows.partSizeBytes, windows),
    completeRetryBudgetMs(),
  );
  if (windows.sessionTokenTtlSeconds * 1000 <= mustOutlastMs) {
    throw new Error(
      `session_token_ttl_seconds ${windows.sessionTokenTtlSeconds} is under ` +
        `the ${Math.ceil(mustOutlastMs / 1000)}s it has to outlast — one ` +
        `part's whole delivery chain, and the chain completing an upload runs`,
    );
  }
  // Deleting what it knew is also what stops the Durable Object recognising
  // the key as already used. A ticket that outlives that could open a second
  // multipart upload over an object the ledger already describes, and the
  // sha256 on that row would stop describing the bytes.
  if (windows.ticketExpiresSeconds * 1000 >= mustOutlastMs) {
    throw new Error(
      `ticket_expires_seconds ${windows.ticketExpiresSeconds} outlives the ` +
        `${Math.ceil(mustOutlastMs / 1000)}s a finished upload is remembered ` +
        `for, so a ticket could reopen a key already registered`,
    );
  }
}
