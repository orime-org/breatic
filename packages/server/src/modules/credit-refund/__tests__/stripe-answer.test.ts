// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Classifying one Stripe answer to `refunds.create` (inner#1410 §5.4).
 *
 * The classification is split in three steps, because the middle one needs a
 * Stripe read the pure code cannot make:
 *
 * 1. `classifyCreateAnswer` reads the create call's answer in the design's
 *    fixed order: a refund object goes by its status; otherwise
 *    `Stripe-Should-Retry: true`, then the error `code`, then the HTTP status.
 *    It answers a refund to classify, a final event (E6, E8), or "look the
 *    refund up by metadata, and if it is not there this is E7 / E9 / E17".
 * 2. `classifyLookup` turns the metadata lookup into a refund to classify, the
 *    pending event, or E16 when the lookup itself failed.
 * 3. `eventForRefund` turns a refund object into E2..E6. E2 / E3 / E4 split on
 *    the settle verdict, which the caller computes (`canSettle` for approve
 *    and retry, `refundAgainOutcome` for refund_again) and passes in.
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
  classifyLookup,
  eventForRefund,
  type CreateAnswer,
} from "@server/modules/credit-refund/stripe-answer.js";
import type { StripeRefundStatus } from "@server/modules/credit-refund/types.js";

const REFUND = (status: StripeRefundStatus) => ({ id: "re_123", status });

/** A Stripe error answer with only the given fields set. */
const err = (
  httpStatus: number,
  extra: { type?: string; code?: string; shouldRetry?: boolean } = {},
): CreateAnswer => ({ kind: "stripe_error", httpStatus, ...extra });

const FIRST = 0;
const LATER = 1;

describe("classifyCreateAnswer: a refund object goes by its status", () => {
  it.each<StripeRefundStatus>(["succeeded", "pending", "requires_action", "failed", "canceled"])(
    "hands back a %s refund for status classification",
    (status) => {
      expect(classifyCreateAnswer({ kind: "refund", refund: REFUND(status) }, FIRST)).toEqual({
        kind: "refund",
        refund: { id: "re_123", status },
      });
      expect(classifyCreateAnswer({ kind: "refund", refund: REFUND(status) }, LATER)).toEqual({
        kind: "refund",
        refund: { id: "re_123", status },
      });
    },
  );
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

describe("classifyLookup", () => {
  it.each(["E7", "E9", "E17"] as const)(
    "a lookup that finds nothing yields the pending %s",
    (ifNotFound) => {
      expect(classifyLookup(ifNotFound, { ok: true, refund: null })).toEqual({
        kind: "event",
        event: ifNotFound,
      });
    },
  );

  it.each(["E7", "E9", "E17"] as const)(
    "a lookup that finds the refund hands it back for status classification (%s)",
    (ifNotFound) => {
      expect(classifyLookup(ifNotFound, { ok: true, refund: REFUND("pending") })).toEqual({
        kind: "refund",
        refund: { id: "re_123", status: "pending" },
      });
    },
  );

  it.each(["E7", "E9", "E17"] as const)("a lookup that itself fails is E16 (%s)", (ifNotFound) => {
    expect(classifyLookup(ifNotFound, { ok: false })).toEqual({ kind: "event", event: "E16" });
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
