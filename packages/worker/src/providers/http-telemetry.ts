// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Turning the shared transport's retry events into worker log lines.
 *
 * The transport itself never logs — library packages must not — so every
 * application that drives it supplies a sink. The worker drives it from two
 * places (the provider transports and the local asset download) and each had
 * written its own sink, including its own copy of the one judgement that is
 * not obvious: WHICH refusals are worth a line at all.
 *
 * That judgement lives here now. The event names still differ per caller, and
 * deliberately so — an on-call engineer reading `asset_download_gave_up` knows
 * our own object store is the suspect, while `provider_http_gave_up` points at
 * a vendor. Different owners, different fixes. What must not differ is the
 * rule, because one rule kept in two places is a rule that drifts.
 */

import { logger } from "@breatic/core";
import type { HttpRetryEvent } from "@breatic/shared";

/** The log event names one caller wants for its two outcomes. */
export interface HttpEventNames {
  /** Emitted when an attempt is about to be replayed. */
  retry: string;
  /** Emitted when the transport declined or spent its replays. */
  gaveUp: string;
}

/**
 * Whether an exhaustion is worth a log line.
 *
 * A plain 404 or a request nobody ever intended to replay is the caller's
 * business, not a transport incident — logging those buries the ones that
 * matter. Everything else means a replay was declined or spent, which is
 * exactly what an on-call engineer is looking for.
 * @param reason - Why the transport stopped.
 * @returns True when the outcome deserves a line.
 */
function worthLogging(reason: string): boolean {
  return reason !== "client_error" && reason !== "nothing_to_retry";
}

/**
 * Build a sink that routes this caller's transport events to the logger.
 * @param names - The event names this caller logs under.
 * @returns A sink to hand to the transport's `onEvent`.
 */
export function httpEventLogger(names: HttpEventNames): (event: HttpRetryEvent) => void {
  return (event: HttpRetryEvent): void => {
    if (event.type === "retry") {
      logger.warn(
        {
          provider: event.label,
          url: event.url,
          attempt: event.attempt,
          delay: event.delayMs,
          reason: event.reason,
          status: event.status,
        },
        names.retry,
      );
      return;
    }
    if (!worthLogging(event.reason)) return;
    logger.warn(
      {
        provider: event.label,
        url: event.url,
        attempts: event.attempts,
        reason: event.reason,
        status: event.status,
        // Present only when the transport refused because the server asked
        // for a longer wait than this caller's ceiling. It is the figure the
        // server named, and it is the one thing an engineer cannot recover
        // from the rest of the line.
        ...(event.retryAfterMs !== undefined && { retryAfterMs: event.retryAfterMs }),
      },
      names.gaveUp,
    );
  };
}
