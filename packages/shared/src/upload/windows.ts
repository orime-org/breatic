// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one part of an upload may take (#173).
 *
 * Two sides read this. The browser sizes each part's deadline with it, and the
 * ticket endpoint checks that the window the Durable Object waits in is wider
 * than the whole worst case — otherwise an upload that is still retrying a
 * part gets judged dead and every part already written is dropped.
 *
 * Both answers come from the same arithmetic on purpose. Two copies would
 * disagree the first time either side's figures moved.
 */

import { MAX_RETRIES, BASE_DELAY_MS } from "@shared/http/constants.js";

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
  const deliveries = MAX_RETRIES + 1;
  let backoff = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    backoff += BASE_DELAY_MS * 2 ** attempt;
  }
  return deliveries * partDeadlineMs(sizeBytes, cfg) + backoff;
}

/** Every figure an upload's windows are decided by, all from `config/storage.yaml`. */
export interface UploadWindows extends PartDeadlineConfig {
  /** One part of a multipart upload, in bytes. */
  partSizeBytes: number;
  /** How long the Durable Object waits for a part before judging the upload dead. */
  alarmIdleSeconds: number;
  /** How long a session token stays usable after the part that issued it. */
  sessionTokenTtlSeconds: number;
}

/**
 * Refuse figures whose windows are narrower than what they have to hold.
 *
 * Both relations here are one-directional and easy to get backwards, and
 * getting either backwards fails an upload that is doing nothing wrong: a
 * short idle window drops parts a browser is still retrying, and a short
 * token turns the part after a long wait into a 401. They are checked where
 * the ticket is minted rather than left to be discovered by a user.
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
  if (windows.sessionTokenTtlSeconds <= windows.alarmIdleSeconds) {
    throw new Error(
      `session_token_ttl_seconds ${windows.sessionTokenTtlSeconds} does not ` +
        `outlast alarm_idle_seconds ${windows.alarmIdleSeconds}`,
    );
  }
}
