// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Classifying one Stripe answer to `refunds.create` (inner#1410 §5.4).
 *
 * The classification is split in two pure steps, with a Stripe read the pure
 * code cannot make in between:
 *
 * 1. `classifyCreateAnswer` reads the create call's answer in the design's
 *    fixed order: a refund object goes by its status; otherwise
 *    `Stripe-Should-Retry: true`, then the error `code`, then the HTTP status.
 *    It answers a refund to classify, a final event (E6, E8), or "look the
 *    refund up by metadata, and if it is not there this is E7 / E9 / E17".
 *    The executor makes that lookup itself: a refund found by metadata is
 *    classified by status in step 2; otherwise the answer's own event stands
 *    (a lookup that itself fails is E16).
 * 2. `eventForRefund` turns a refund object into E2..E6. E2 / E3 / E4 split on
 *    the settle verdict, which the caller computes and passes in.
 *
 * The one thing that must never happen here is reading "Stripe did not
 * refund" (E6) out of an answer that cannot prove it: only the first request
 * (attempt_count = 0) can, because Stripe caches nothing for errors raised
 * before execution begins.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyCreateAnswer,
  eventForRefund,
  isStripeRefusal,
  type CreateAnswer,
} from "@server/modules/credit-refund/stripe-answer.js";
import type { StripeRefundStatus } from "@server/modules/credit-refund/types.js";

/** A Stripe error answer with only the given fields set. */
const err = (
  httpStatus: number,
  extra: { type?: string; code?: string; shouldRetry?: boolean } = {},
): CreateAnswer => ({ kind: "stripe_error", httpStatus, ...extra });

const FIRST = 0;
const LATER = 1;

// The answer and the verdict only say "a refund came back": the executor
// classifies the refund object createRefund returned beside the answer, so
// neither carries a copy of it that nothing reads.
describe("classifyCreateAnswer: a refund object is handed to the executor's status classification", () => {
  it("answers { kind: refund } and nothing else, first request or not", () => {
    expect(classifyCreateAnswer({ kind: "refund" }, FIRST)).toStrictEqual({ kind: "refund" });
    expect(classifyCreateAnswer({ kind: "refund" }, LATER)).toStrictEqual({ kind: "refund" });
  });
});

describe("classifyCreateAnswer: Stripe-Should-Retry true comes first", () => {
  it.each([400, 401, 403, 404, 402, 409, 424, 429, 500, 503])(
    "a %i with Should-Retry true is retried after a metadata lookup (E7), first request or not",
    (status) => {
      const expected = { kind: "lookup", ifNotFound: "E7" };
      expect(classifyCreateAnswer(err(status, { shouldRetry: true }), FIRST)).toEqual(expected);
      expect(classifyCreateAnswer(err(status, { shouldRetry: true }), LATER)).toEqual(expected);
    },
  );

  it("Should-Retry true wins over charge_already_refunded", () => {
    expect(
      classifyCreateAnswer(err(400, { code: "charge_already_refunded", shouldRetry: true }), FIRST),
    ).toEqual({ kind: "lookup", ifNotFound: "E7" });
  });

  it("Should-Retry true wins over an idempotency_error", () => {
    expect(
      classifyCreateAnswer(err(400, { type: "idempotency_error", shouldRetry: true }), FIRST),
    ).toEqual({ kind: "lookup", ifNotFound: "E7" });
  });
});

describe("classifyCreateAnswer: the error code comes second", () => {
  it.each(["rate_limit", "lock_timeout"])(
    "code %s is retried after a lookup (E7), even as a 400 on the first request",
    (code) => {
      expect(classifyCreateAnswer(err(400, { code }), FIRST)).toEqual({
        kind: "lookup",
        ifNotFound: "E7",
      });
      expect(classifyCreateAnswer(err(400, { code }), LATER)).toEqual({
        kind: "lookup",
        ifNotFound: "E7",
      });
      expect(classifyCreateAnswer(err(429, { code }), FIRST)).toEqual({
        kind: "lookup",
        ifNotFound: "E7",
      });
    },
  );

  it("code lock_timeout on a 5xx is still a retry, not E8", () => {
    expect(classifyCreateAnswer(err(500, { code: "lock_timeout" }), LATER)).toEqual({
      kind: "lookup",
      ifNotFound: "E7",
    });
  });

  it("charge_already_refunded is E9 when the lookup finds nothing, on any attempt", () => {
    expect(classifyCreateAnswer(err(400, { code: "charge_already_refunded" }), FIRST)).toEqual({
      kind: "lookup",
      ifNotFound: "E9",
    });
    expect(classifyCreateAnswer(err(400, { code: "charge_already_refunded" }), LATER)).toEqual({
      kind: "lookup",
      ifNotFound: "E9",
    });
  });
});

describe("classifyCreateAnswer: first-request 4xx that prove nothing was created (E6)", () => {
  it.each([400, 404, 401, 403])("a %i on the first request is E6", (status) => {
    expect(classifyCreateAnswer(err(status), FIRST)).toEqual({ kind: "event", event: "E6" });
  });

  it("a 400 with an ordinary code on the first request is E6", () => {
    expect(
      classifyCreateAnswer(err(400, { type: "invalid_request_error", code: "amount_too_large" }), FIRST),
    ).toEqual({ kind: "event", event: "E6" });
  });

  it("Should-Retry false does not stop a first-request 400 from being E6", () => {
    expect(classifyCreateAnswer(err(400, { shouldRetry: false }), FIRST)).toEqual({
      kind: "event",
      event: "E6",
    });
  });

  it.each([400, 404])("an idempotency_error %i on the first request is not E6 but E17", (status) => {
    expect(classifyCreateAnswer(err(status, { type: "idempotency_error" }), FIRST)).toEqual({
      kind: "lookup",
      ifNotFound: "E17",
    });
  });
});

describe("classifyCreateAnswer: retryable transport and status answers (E7)", () => {
  it.each([409, 429])("a %i is retried after a lookup (E7)", (status) => {
    expect(classifyCreateAnswer(err(status), FIRST)).toEqual({ kind: "lookup", ifNotFound: "E7" });
    expect(classifyCreateAnswer(err(status), LATER)).toEqual({ kind: "lookup", ifNotFound: "E7" });
  });

  it.each<CreateAnswer>([{ kind: "timeout" }, { kind: "network" }])(
    "a $kind is retried after a lookup (E7)",
    (answer) => {
      expect(classifyCreateAnswer(answer, FIRST)).toEqual({ kind: "lookup", ifNotFound: "E7" });
      expect(classifyCreateAnswer(answer, LATER)).toEqual({ kind: "lookup", ifNotFound: "E7" });
    },
  );
});

describe("classifyCreateAnswer: 5xx without Should-Retry true (E8)", () => {
  it.each([500, 502, 503, 504])("a %i is E8, with no lookup", (status) => {
    expect(classifyCreateAnswer(err(status), FIRST)).toEqual({ kind: "event", event: "E8" });
    expect(classifyCreateAnswer(err(status), LATER)).toEqual({ kind: "event", event: "E8" });
  });

  it("a 500 with Should-Retry false is still E8", () => {
    expect(classifyCreateAnswer(err(500, { shouldRetry: false }), LATER)).toEqual({
      kind: "event",
      event: "E8",
    });
  });
});

describe("classifyCreateAnswer: everything else is E17 after a lookup", () => {
  it.each([402, 424])("a %i is E17, first request or not", (status) => {
    expect(classifyCreateAnswer(err(status), FIRST)).toEqual({ kind: "lookup", ifNotFound: "E17" });
    expect(classifyCreateAnswer(err(status), LATER)).toEqual({ kind: "lookup", ifNotFound: "E17" });
  });

  it.each([400, 401, 403, 404])("a %i from the second request on is E17, not E6", (status) => {
    expect(classifyCreateAnswer(err(status), LATER)).toEqual({ kind: "lookup", ifNotFound: "E17" });
    expect(classifyCreateAnswer(err(status), 7)).toEqual({ kind: "lookup", ifNotFound: "E17" });
  });

  it("an idempotency_error later on is E17", () => {
    expect(classifyCreateAnswer(err(400, { type: "idempotency_error" }), LATER)).toEqual({
      kind: "lookup",
      ifNotFound: "E17",
    });
  });

  it("a non-Stripe exception is E17", () => {
    expect(classifyCreateAnswer({ kind: "other_error" }, FIRST)).toEqual({
      kind: "lookup",
      ifNotFound: "E17",
    });
  });
});

describe("classifyCreateAnswer: invariants over every error answer", () => {
  const errorAnswer = fc.record({
    httpStatus: fc.integer({ min: 400, max: 599 }),
    type: fc.option(
      fc.constantFrom("invalid_request_error", "api_error", "card_error", "idempotency_error"),
      { nil: undefined },
    ),
    code: fc.option(
      fc.constantFrom(
        "rate_limit",
        "lock_timeout",
        "charge_already_refunded",
        "amount_too_large",
        "resource_missing",
      ),
      { nil: undefined },
    ),
    shouldRetry: fc.option(fc.boolean(), { nil: undefined }),
  });

  it("only the first request can conclude that Stripe did not refund (E6)", () => {
    fc.assert(
      fc.property(errorAnswer, fc.integer({ min: 1, max: 100 }), (e, attempt) => {
        const out = classifyCreateAnswer({ kind: "stripe_error", ...e }, attempt);
        expect(out).not.toEqual({ kind: "event", event: "E6" });
      }),
    );
  });

  it("E6 only ever comes from a 400 / 401 / 403 / 404 without Should-Retry true", () => {
    fc.assert(
      fc.property(errorAnswer, (e) => {
        const out = classifyCreateAnswer({ kind: "stripe_error", ...e }, FIRST);
        if (out.kind === "event" && out.event === "E6") {
          expect([400, 401, 403, 404]).toContain(e.httpStatus);
          expect(e.shouldRetry).not.toBe(true);
          expect(e.type).not.toBe("idempotency_error");
          expect(["rate_limit", "lock_timeout", "charge_already_refunded"]).not.toContain(e.code);
        }
      }),
    );
  });

  it("Should-Retry true is always a lookup that defaults to E7", () => {
    fc.assert(
      fc.property(errorAnswer, fc.nat(20), (e, attempt) => {
        const out = classifyCreateAnswer({ kind: "stripe_error", ...e, shouldRetry: true }, attempt);
        expect(out).toEqual({ kind: "lookup", ifNotFound: "E7" });
      }),
    );
  });
});

describe("eventForRefund", () => {
  it("succeeded with the settle verdict satisfied is E2", () => {
    expect(eventForRefund("succeeded", "settle")).toBe("E2");
  });

  it("succeeded but another refund still in flight is E3", () => {
    expect(eventForRefund("succeeded", "wait")).toBe("E3");
  });

  it("succeeded but short of the paid amount or with a new external refund is E4", () => {
    expect(eventForRefund("succeeded", "attention")).toBe("E4");
  });

  it.each<StripeRefundStatus>(["pending", "requires_action"])(
    "%s is E5 whatever the verdict",
    (status) => {
      expect(eventForRefund(status, "settle")).toBe("E5");
      expect(eventForRefund(status, "wait")).toBe("E5");
      expect(eventForRefund(status, "attention")).toBe("E5");
    },
  );

  it.each<StripeRefundStatus>(["failed", "canceled"])("%s is E6 whatever the verdict", (status) => {
    expect(eventForRefund(status, "settle")).toBe("E6");
    expect(eventForRefund(status, "wait")).toBe("E6");
    expect(eventForRefund(status, "attention")).toBe("E6");
  });
});

/**
 * `isStripeRefusal(detail)` (v9 §5.4): the one definition of "Stripe refused
 * this refund", read off the detail a create-answer event row stores — the
 * refund object (`detail.refund`) or Stripe's error fields (`httpStatus`,
 * `type`, `code`, `shouldRetry`, `message`), as `detailOf` writes them.
 *
 * A refusal is a refund object that is failed or canceled, or an HTTP 400
 * whose code is not rate_limit, lock_timeout or charge_already_refunded,
 * whose type is not idempotency_error, and without Stripe-Should-Retry: true.
 */
describe("isStripeRefusal: every class of create answer", () => {
  /** A stored refund object, as the event row keeps it. */
  const refundDetail = (status: StripeRefundStatus) => ({
    refund: { id: "re_1", status, amount: 1080, currency: "usd", failureReason: null },
    actor: "request",
  });
  /** A stored Stripe error, as the event row keeps it. */
  const errorDetail = (httpStatus: number, extra: { type?: string; code?: string; shouldRetry?: boolean } = {}) => ({
    message: `synthetic ${httpStatus}`,
    httpStatus,
    ...extra,
    actor: "loop",
  });

  it.each<StripeRefundStatus>(["failed", "canceled"])("a %s refund object is a refusal", (status) => {
    expect(isStripeRefusal(refundDetail(status))).toBe(true);
  });

  it.each<StripeRefundStatus>(["succeeded", "pending", "requires_action"])(
    "a %s refund object is not a refusal",
    (status) => {
      expect(isStripeRefusal(refundDetail(status))).toBe(false);
    },
  );

  it("a plain 400 is a refusal", () => {
    expect(isStripeRefusal(errorDetail(400, { type: "invalid_request_error" }))).toBe(true);
  });

  it.each(["charge_disputed", "refund_disputed_payment", "amount_too_large", "charge_already_refunded_other"])(
    "a 400 with code %s is a refusal",
    (code) => {
      expect(isStripeRefusal(errorDetail(400, { type: "invalid_request_error", code }))).toBe(true);
    },
  );

  it("the measured 'A previous attempt to refund charge … failed' 400 is a refusal", () => {
    expect(
      isStripeRefusal({
        message: "A previous attempt to refund charge ch_1 to card card_1 failed",
        httpStatus: 400,
        type: "invalid_request_error",
        actor: "request",
      }),
    ).toBe(true);
  });

  it("a 400 with Stripe-Should-Retry false is a refusal", () => {
    expect(isStripeRefusal(errorDetail(400, { shouldRetry: false }))).toBe(true);
  });

  it.each(["rate_limit", "lock_timeout", "charge_already_refunded"])("a 400 with code %s is not a refusal", (code) => {
    expect(isStripeRefusal(errorDetail(400, { code }))).toBe(false);
  });

  it("a 400 idempotency_error is not a refusal", () => {
    expect(isStripeRefusal(errorDetail(400, { type: "idempotency_error" }))).toBe(false);
  });

  it("a 400 with Stripe-Should-Retry true is not a refusal", () => {
    expect(isStripeRefusal(errorDetail(400, { shouldRetry: true }))).toBe(false);
  });

  it.each([401, 403, 404])("a %i is not a refusal: Stripe did not execute (stripe_request_invalid, or E17 later)", (status) => {
    expect(isStripeRefusal(errorDetail(status, { type: "invalid_request_error" }))).toBe(false);
  });

  it.each([402, 409, 424, 429, 500, 502, 503])("a %i is not a refusal", (status) => {
    expect(isStripeRefusal(errorDetail(status))).toBe(false);
  });

  it("a timeout or network error (no HTTP status) is not a refusal", () => {
    expect(isStripeRefusal({ message: "Request timed out", actor: "loop" })).toBe(false);
  });

  it("an event row with neither a refund nor an error (a claim, a request) is not a refusal", () => {
    expect(isStripeRefusal({ actor: "loop" })).toBe(false);
    expect(isStripeRefusal({ kind: "approve", notify: true, confirmedRefundIds: [], actor: "request" })).toBe(false);
  });

  it("a late answer's detail (the answer's event name beside its fields) is judged the same way", () => {
    expect(isStripeRefusal({ answer: "E17", ...errorDetail(400) })).toBe(true);
    expect(isStripeRefusal({ answer: "E7", ...errorDetail(400, { code: "rate_limit" }) })).toBe(false);
  });

  it("agrees with the first-request E6 classification on every 400 (§5.4: the E6 400 is the same rule)", () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.option(fc.constantFrom("invalid_request_error", "api_error", "idempotency_error"), { nil: undefined }),
          code: fc.option(
            fc.constantFrom("rate_limit", "lock_timeout", "charge_already_refunded", "charge_disputed", "amount_too_large"),
            { nil: undefined },
          ),
          shouldRetry: fc.option(fc.boolean(), { nil: undefined }),
        }),
        (e) => {
          const verdict = classifyCreateAnswer({ kind: "stripe_error", httpStatus: 400, ...e }, FIRST);
          const isE6 = verdict.kind === "event" && verdict.event === "E6";
          expect(isStripeRefusal({ message: "x", httpStatus: 400, ...e, actor: "request" })).toBe(isE6);
        },
      ),
    );
  });
});
