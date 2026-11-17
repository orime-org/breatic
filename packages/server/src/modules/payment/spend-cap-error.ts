// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Refusals a route answers with a reason the web client branches on,
 * including the monthly spend limit (inner#1968, design 3.10).
 */

import { AppError } from "@breatic/core";
import type { creditHoldService } from "@breatic/domain";
import { formatCredits, getActiveLocale, t } from "@breatic/shared";

/** A refusal the web client tells apart by `error.reason`. */
export class ReasonedError extends AppError {
  /**
   * Build the refusal.
   * @param statusCode - Its HTTP status.
   * @param message - The sentence, already translated.
   * @param reason - What the client branches on.
   */
  constructor(statusCode: number, message: string, readonly reason: string) {
    super(statusCode, message);
  }
}

/** Work refused by a studio's monthly spend limit (inner#1968, design 3.10). */
export class SpendCapReachedError extends ReasonedError {
  /** The person's own limit, or the studio's total. */
  readonly scope: creditHoldService.SpendCapHit["scope"];
  /** The limit, as a decimal string. */
  readonly limit: string;
  /** When the month resets, as ISO text. */
  readonly resetsAt: string;

  /**
   * Build the refusal.
   * @param cap - The limit the work would pass.
   */
  constructor(cap: creditHoldService.SpendCapHit) {
    super(
      402,
      cap.scope === "member"
        ? t("server.spend_cap.member", { limit: formatCredits(cap.limit, getActiveLocale()) })
        : t("server.spend_cap.studio"),
      "spend_cap_reached",
    );
    this.name = "SpendCapReachedError";
    this.scope = cap.scope;
    this.limit = cap.limit;
    this.resetsAt = cap.resetsAt;
  }
}
