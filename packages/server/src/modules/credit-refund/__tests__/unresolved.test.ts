// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one definition of an unresolved failed refund (inner#1410 §5.3).
 *
 * A copy counts when it is now `failed` or `canceled` and no disposition has
 * answered for it (`resolved_by_operation_id` empty), and the lot's state
 * allows it:
 *
 * | lot                           | which copies                               |
 * |-------------------------------|--------------------------------------------|
 * | `refunded`                    | also `ever_succeeded` (failed after booking) |
 * | `refund_pending`, `refunding` | every one                                  |
 * | `active`, `depleted`          | none                                       |
 *
 * The preview, the judgement table, both endpoints and the back office list
 * all ask this one function, so a refund cannot be listed by one and refused
 * by another.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { CreditLotLifecycle } from "@breatic/shared";
import { pickUnresolvedFailedRefunds } from "@server/modules/credit-refund/unresolved.js";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";

const RESOLVER = "22222222-2222-4222-8222-222222222222";

function copy(
  stripeRefundId: string,
  status: StripeRefundStatus,
  overrides: Partial<RefundCopy> = {},
): RefundCopy {
  return {
    stripeRefundId,
    amountCents: 500,
    status,
    operationId: null,
    everSucceeded: true,
    resolvedByOperationId: null,
    failureReason: null,
    ...overrides,
  };
}

describe("pickUnresolvedFailedRefunds", () => {
  it.each<StripeRefundStatus>(["failed", "canceled"])(
    "lists a %s refund that once succeeded on a refunded lot",
    (status) => {
      const r = copy("re_1", status);
      expect(pickUnresolvedFailedRefunds("refunded", [r])).toEqual([r]);
    },
  );

  it("lists both own and external refunds", () => {
    const own = copy("re_own", "failed", { operationId: RESOLVER });
    const ext = copy("re_ext", "canceled");
    expect(pickUnresolvedFailedRefunds("refunded", [own, ext])).toEqual([own, ext]);
  });

  it("does not list a failed refund that never succeeded", () => {
    expect(
      pickUnresolvedFailedRefunds("refunded", [copy("re_1", "failed", { everSucceeded: false })]),
    ).toEqual([]);
  });

  it("does not list a refund some disposition already answered for", () => {
    expect(
      pickUnresolvedFailedRefunds("refunded", [
        copy("re_1", "failed", { resolvedByOperationId: RESOLVER }),
      ]),
    ).toEqual([]);
  });

  it.each<StripeRefundStatus>(["succeeded", "pending", "requires_action"])(
    "does not list a refund that is now %s",
    (status) => {
      expect(pickUnresolvedFailedRefunds("refunded", [copy("re_1", status)])).toEqual([]);
    },
  );

  it.each<CreditLotLifecycle>(["active", "depleted"])(
    "lists nothing while the lot is %s",
    (lifecycle) => {
      expect(pickUnresolvedFailedRefunds(lifecycle, [copy("re_1", "failed")])).toEqual([]);
    },
  );

  it.each<CreditLotLifecycle>(["refund_pending", "refunding"])(
    "lists every unanswered failed or canceled refund of a %s lot, succeeded once or not",
    (lifecycle) => {
      const once = copy("re_once", "failed");
      const never = copy("re_never", "failed", { everSucceeded: false });
      const canceled = copy("re_canceled", "canceled", { everSucceeded: false });
      const answered = copy("re_answered", "failed", { resolvedByOperationId: RESOLVER });
      const open = copy("re_open", "pending", { everSucceeded: false });
      const ok = copy("re_ok", "succeeded");
      expect(
        pickUnresolvedFailedRefunds(lifecycle, [once, never, canceled, answered, open, ok]),
      ).toEqual([once, never, canceled]);
    },
  );

  it("keeps the matching refunds in input order and drops the rest", () => {
    const a = copy("re_a", "failed");
    const b = copy("re_b", "succeeded");
    const c = copy("re_c", "canceled");
    const d = copy("re_d", "failed", { resolvedByOperationId: RESOLVER });
    expect(pickUnresolvedFailedRefunds("refunded", [a, b, c, d])).toEqual([a, c]);
  });

  it("matches the §5.3 table for any lot state and mix of refunds", () => {
    const rowArb = fc.record({
      status: fc.constantFrom<StripeRefundStatus>(
        "pending",
        "requires_action",
        "succeeded",
        "failed",
        "canceled",
      ),
      everSucceeded: fc.boolean(),
      resolved: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.constantFrom<CreditLotLifecycle>("active", "depleted", "refund_pending", "refunding", "refunded"),
        fc.array(rowArb, { maxLength: 8 }),
        (lifecycle, rows) => {
          const refunds = rows.map((r, i) =>
            copy(`re_${i}`, r.status, {
              everSucceeded: r.everSucceeded,
              resolvedByOperationId: r.resolved ? RESOLVER : null,
            }),
          );
          const inFlow = lifecycle === "refund_pending" || lifecycle === "refunding";
          const expected = refunds.filter(
            (r) =>
              (inFlow || (lifecycle === "refunded" && r.everSucceeded)) &&
              (r.status === "failed" || r.status === "canceled") &&
              r.resolvedByOperationId === null,
          );
          expect(pickUnresolvedFailedRefunds(lifecycle, refunds)).toEqual(expected);
        },
      ),
    );
  });
});
