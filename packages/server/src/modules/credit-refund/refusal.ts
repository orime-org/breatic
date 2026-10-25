// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { t } from "@breatic/shared";

/** The exact JSON emitted by the internal API for a refusal. */
export interface RefusalBody {
  code: string;
  detail?: string;
  reason?: string;
}

/** A refund refusal, optionally carrying an already committed response. */
export class RefundRefusal extends Error {
  readonly status: 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  readonly code: string;
  readonly detailKey: string | undefined;
  readonly reason: string | undefined;
  readonly responseBody: RefusalBody | undefined;

  /**
   * Name the refusal.
   * @param status - The HTTP status.
   * @param code - The stable code the caller branches on.
   * @param detailKey - `server.internal.<detailKey>` is the detail; absent for none.
   * @param reason - For `stripe_blocks`: which part of Stripe's state stops it.
   * @param responseBody - A previously committed literal response.
   */
  constructor(
    status: RefundRefusal["status"],
    code: string,
    detailKey?: string,
    reason?: string,
    responseBody?: RefusalBody,
  ) {
    super(code);
    this.name = "RefundRefusal";
    this.status = status;
    this.code = code;
    this.detailKey = detailKey;
    this.reason = reason;
    this.responseBody = responseBody;
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

/**
 * Render a new refusal once, or replay its committed literal JSON.
 * @param refusal - The refusal to render.
 * @returns Its actual response body.
 */
export function refusalBodyOf(refusal: RefundRefusal): RefusalBody {
  return refusal.responseBody ?? {
    code: refusal.code,
    ...(refusal.detailKey !== undefined && { detail: t(`server.internal.${refusal.detailKey}`) }),
    ...(refusal.reason !== undefined && { reason: refusal.reason }),
  };
}
