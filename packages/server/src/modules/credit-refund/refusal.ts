// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A request the refund disposition refuses, with the code and status the
 * internal API answers it with (inner#1410 §4.6). Thrown inside a write
 * transaction it also rolls that transaction back, so a refused request
 * stores no disposition and no key; the refund copies written before it stay
 * (§6.4).
 */
export class RefundRefusal extends Error {
  readonly status: 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  readonly code: string;
  readonly detailKey: string | undefined;
  readonly reason: string | undefined;

  /**
   * Name the refusal.
   * @param status - The HTTP status.
   * @param code - The stable code the caller branches on.
   * @param detailKey - `server.internal.<detailKey>` is the detail; absent for none.
   * @param reason - For `stripe_blocks`: which part of Stripe's state stops it.
   */
  constructor(
    status: RefundRefusal["status"],
    code: string,
    detailKey?: string,
    reason?: string,
  ) {
    super(code);
    this.name = "RefundRefusal";
    this.status = status;
    this.code = code;
    this.detailKey = detailKey;
    this.reason = reason;
  }
}

/**
 * A Stripe read failed: the refund list (`copyStripe`) or the charge's
 * `disputed` (`readDisputed`), both through `readStripe` in
 * disposition.service.ts. No disposition and no key is stored; refunds copied
 * before a failed `disputed` read stay (§6.4).
 * @returns The 503.
 */
export function stripeUnavailable(): RefundRefusal {
  return new RefundRefusal(503, "stripe_unavailable");
}
