// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Classifying one Stripe answer to `refunds.create` (inner#1410 §5.4).
 *
 * Two steps around a Stripe read: the create call's answer, then — when
 * that alone proves nothing — the refund found by metadata is classified by
 * its status, or the answer's own event stands when none is found. Only the first request can prove
 * Stripe created nothing (E6): Stripe caches no result for an error raised
 * before execution begins, so a later 4xx may follow a refund an earlier
 * attempt did create.
 */

import type { StripeRefundStatus } from "@server/modules/credit-refund/types.js";

/** The refund object part the classification reads. */
export interface RefundRef {
  id: string;
  status: StripeRefundStatus;
}

/** What one `refunds.create` call came back with. */
export type CreateAnswer =
  | { kind: "refund"; refund: RefundRef }
  | {
      kind: "stripe_error";
      httpStatus: number;
      type?: string | undefined;
      code?: string | undefined;
      shouldRetry?: boolean | undefined;
    }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "other_error" };

/** The event a lookup that finds nothing settles on. */
export type PendingEvent = "E7" | "E9" | "E17";

/** What to do with a create answer. */
export type CreateVerdict =
  | { kind: "refund"; refund: RefundRef }
  | { kind: "event"; event: "E6" | "E8" }
  | { kind: "lookup"; ifNotFound: PendingEvent };

/** Codes Stripe uses for a request it refused before executing, worth retrying. */
const RETRY_CODES = new Set(["rate_limit", "lock_timeout"]);

/** Statuses a first request can answer with only when nothing was created. */
const NOTHING_CREATED_STATUSES = new Set([400, 401, 403, 404]);

/**
 * Read a create call's answer in the design's fixed order: a refund object;
 * `Stripe-Should-Retry: true`; the error code; the HTTP status.
 * @param answer - What the call came back with.
 * @param attemptCount - Calls made before this one (0 for the first).
 * @returns A refund to classify, a final event, or a lookup to make.
 */
export function classifyCreateAnswer(answer: CreateAnswer, attemptCount: number): CreateVerdict {
  switch (answer.kind) {
    case "refund":
      return { kind: "refund", refund: answer.refund };
    case "timeout":
    case "network":
      return { kind: "lookup", ifNotFound: "E7" };
    case "other_error":
      return { kind: "lookup", ifNotFound: "E17" };
    case "stripe_error":
      return classifyStripeError(answer, attemptCount);
  }
}

/**
 * The error branch of {@link classifyCreateAnswer}.
 * @param e - The Stripe error answer.
 * @param attemptCount - Calls made before this one.
 * @returns The verdict.
 */
function classifyStripeError(
  e: Extract<CreateAnswer, { kind: "stripe_error" }>,
  attemptCount: number,
): CreateVerdict {
  if (e.shouldRetry === true) return { kind: "lookup", ifNotFound: "E7" };
  if (e.code !== undefined && RETRY_CODES.has(e.code)) return { kind: "lookup", ifNotFound: "E7" };
  if (e.code === "charge_already_refunded") return { kind: "lookup", ifNotFound: "E9" };
  if (e.httpStatus === 409 || e.httpStatus === 429) return { kind: "lookup", ifNotFound: "E7" };
  if (e.httpStatus >= 500) return { kind: "event", event: "E8" };
  if (
    attemptCount === 0 &&
    NOTHING_CREATED_STATUSES.has(e.httpStatus) &&
    e.type !== "idempotency_error"
  ) {
    return { kind: "event", event: "E6" };
  }
  return { kind: "lookup", ifNotFound: "E17" };
}

/**
 * The event a refund object stands for. A succeeded refund splits on the
 * settle verdict, which the caller computes for the disposition's kind.
 * @param status - The refund's status.
 * @param settle - Whether the disposition can settle now.
 * @returns E2..E6.
 */
export function eventForRefund(
  status: StripeRefundStatus,
  settle: "settle" | "wait" | "attention",
): "E2" | "E3" | "E4" | "E5" | "E6" {
  switch (status) {
    case "succeeded":
      return settle === "settle" ? "E2" : settle === "wait" ? "E3" : "E4";
    case "pending":
    case "requires_action":
      return "E5";
    case "failed":
    case "canceled":
      return "E6";
  }
}
