// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Classifying one Stripe answer to `refunds.create` (inner#1410 §5.4).
 *
 * Two steps around a Stripe read: the create call's answer, then — when
 * that alone proves nothing — the refund found by metadata is classified by
 * its status, or the answer's own event stands when none is found. Only the
 * first request can prove Stripe created nothing (E6): Stripe caches no
 * result for an error raised before execution begins, so a later 4xx may
 * follow a refund an earlier attempt did create.
 */

import type { StripeRefundStatus } from "@server/modules/credit-refund/types.js";

/** What one `refunds.create` call came back with; a refund object is carried beside it. */
export type CreateAnswer =
  | { kind: "refund" }
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
  | { kind: "refund" }
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
 * @param attemptCount - The disposition's `attempt_count`: attempts that already ended without an answer (E7, E16, E17); 0 until one has.
 * @returns A refund to classify, a final event, or a lookup to make.
 */
export function classifyCreateAnswer(answer: CreateAnswer, attemptCount: number): CreateVerdict {
  switch (answer.kind) {
    case "refund":
      return { kind: "refund" };
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

/**
 * A stored create answer: an event row's detail. `httpStatus`, `type`,
 * `code`, `shouldRetry` and `refund.status` decide whether Stripe refused;
 * `refund.failureReason` and `message` are the text a person reads.
 */
export interface StoredCreateAnswer {
  [key: string]: unknown;
  refund?: { status?: string; failureReason?: string | null } | undefined;
  httpStatus?: number | undefined;
  type?: string | undefined;
  code?: string | undefined;
  shouldRetry?: boolean | undefined;
}

/** 400 codes that are not a refusal: retry it, or the money is already back. */
const NOT_REFUSAL_CODES = new Set([...RETRY_CODES, "charge_already_refunded"]);

/**
 * Whether a stored create answer is Stripe refusing this refund (§5.4, the
 * one definition): a refund object that failed or was canceled, or a 400 that
 * is not rate limiting, a lock timeout, an already-refunded charge, an
 * idempotency mismatch or a request Stripe says to retry. 401, 403 and 404
 * mean Stripe never executed the request, so they are not refusals.
 * @param detail - The answer as an event row's detail keeps it.
 * @returns True when Stripe refused.
 */
export function isStripeRefusal(detail: StoredCreateAnswer): boolean {
  if (detail.refund) return detail.refund.status === "failed" || detail.refund.status === "canceled";
  return (
    detail.httpStatus === 400 &&
    !(detail.code !== undefined && NOT_REFUSAL_CODES.has(detail.code)) &&
    detail.type !== "idempotency_error" &&
    detail.shouldRetry !== true
  );
}
