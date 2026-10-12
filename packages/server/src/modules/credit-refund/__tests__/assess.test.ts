// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement table shared by the preview and the three endpoints that
 * create a Stripe refund: approve, retry and refund_again (inner#1410 §5.2).
 *
 * Rows are read top to bottom and the first one that matches answers. Every
 * row below is tested with an input that also trips the rows after it, so a
 * reordered table fails here rather than answering the operator with the
 * wrong reason code.
 *
 * The preview reads the same table without the operator's confirmation: it
 * picks the operation from the lot's state (refund_pending → approve,
 * refunding → retry, refunded → refund_again), skips the "external refund not
 * confirmed" row and the "failed refunds changed" row, and otherwise answers
 * exactly what the endpoint would. The last property pins that (§9): the
 * confirmation page never shows "will refund" for a request the endpoint
 * would then refuse.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { CreditLotLifecycle } from "@breatic/shared";
import {
  assessRefundCreate,
  assessRefundPreview,
  previewKind,
  type AssessInput,
  type AssessOperation,
  type RefundCreateKind,
} from "@server/modules/credit-refund/assess.js";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";

const OWN_OP = "11111111-1111-4111-8111-111111111111";
const RESOLVER = "22222222-2222-4222-8222-222222222222";
const PAID = 1000;

function refund(
  stripeRefundId: string,
  status: StripeRefundStatus,
  amountCents: number,
  overrides: Partial<RefundCopy> = {},
): RefundCopy {
  return {
    stripeRefundId,
    amountCents,
    status,
    operationId: OWN_OP,
    everSucceeded: status === "succeeded",
    resolvedByOperationId: null,
    ...overrides,
  };
}

/** A refund that succeeded once and failed afterwards, nobody has answered for it. */
const failedAfterSuccess = (id: string, amountCents: number): RefundCopy =>
  refund(id, "failed", amountCents, { everSucceeded: true });

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 8, minute));

const op = (
  status: AssessOperation["status"],
  minute: number,
  attentionClosedAt: Date | null = null,
): AssessOperation => ({ status, attentionClosedAt, createdAt: at(minute) });

const COMPLETED_PAYMENT = { status: "completed", stripePaymentIntentId: "pi_1", paidCents: PAID };

/** An approve that passes every row. */
const APPROVE_OK: AssessInput = {
  kind: "approve",
  lot: { lifecycle: "refund_pending", remainingCredits: 100, ledgerSum: 100 },
  payment: COMPLETED_PAYMENT,
  ops: [],
  refunds: [],
  confirmedRefundIds: [],
  failedRefundIds: [],
};

/** A retry that passes every row: the last disposition is an open needs_attention. */
const RETRY_OK: AssessInput = {
  kind: "retry",
  lot: { lifecycle: "refunding", remainingCredits: 100, ledgerSum: 100 },
  payment: COMPLETED_PAYMENT,
  ops: [op("needs_attention", 5)],
  refunds: [],
  confirmedRefundIds: [],
  failedRefundIds: [],
};

/** A refund_again that passes every row: two unresolved failed refunds, both named. */
const REFUND_AGAIN_OK: AssessInput = {
  kind: "refund_again",
  lot: { lifecycle: "refunded", remainingCredits: 0, ledgerSum: 0 },
  payment: COMPLETED_PAYMENT,
  ops: [op("succeeded", 1)],
  refunds: [failedAfterSuccess("re_f1", 300), failedAfterSuccess("re_f2", 200)],
  confirmedRefundIds: [],
  failedRefundIds: ["re_f1", "re_f2"],
};

const BASES: Record<"approve" | "retry" | "refund_again", AssessInput> = {
  approve: APPROVE_OK,
  retry: RETRY_OK,
  refund_again: REFUND_AGAIN_OK,
};

const LOT_STATE_CHANGED = { outcome: "blocked", code: "lot_state_changed" };
const IN_PROGRESS = { outcome: "blocked", code: "operation_in_progress" };
const stripeBlocks = (reason: string) => ({ outcome: "blocked", code: "stripe_blocks", reason });

describe("assessRefundCreate: the last row creates the refund", () => {
  it("approve refunds the whole paid amount without sending an amount", () => {
    expect(assessRefundCreate(APPROVE_OK)).toEqual({
      outcome: "create_refund",
      amountCents: PAID,
      sendAmount: false,
    });
  });

  it("retry refunds what is left without sending an amount", () => {
    expect(
      assessRefundCreate({
        ...RETRY_OK,
        refunds: [refund("re_ext", "succeeded", 300, { operationId: null })],
        confirmedRefundIds: ["re_ext"],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: 700, sendAmount: false });
  });

  it("approve with a confirmed external refund refunds the rest", () => {
    expect(
      assessRefundCreate({
        ...APPROVE_OK,
        refunds: [refund("re_ext", "succeeded", 250, { operationId: null })],
        confirmedRefundIds: ["re_ext"],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: 750, sendAmount: false });
  });

  it("refund_again sends exactly the sum of the named failed refunds", () => {
    expect(assessRefundCreate(REFUND_AGAIN_OK)).toEqual({
      outcome: "create_refund",
      amountCents: 500,
      sendAmount: true,
    });
  });

  it("refund_again does not count a failed refund already answered for", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [
          failedAfterSuccess("re_f1", 300),
          refund("re_f2", "failed", 200, { everSucceeded: true, resolvedByOperationId: RESOLVER }),
        ],
        failedRefundIds: ["re_f1"],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: 300, sendAmount: true });
  });
});

describe("row 1: the lot is not in the state the operation needs", () => {
  const wrongState: Record<"approve" | "retry" | "refund_again", CreditLotLifecycle[]> = {
    approve: ["active", "depleted", "refunding", "refunded"],
    retry: ["active", "depleted", "refund_pending", "refunded"],
    refund_again: ["active", "depleted", "refund_pending", "refunding"],
  };

  for (const kind of ["approve", "retry", "refund_again"] as const) {
    it.each<CreditLotLifecycle>(wrongState[kind])(`${kind} on a %s lot is lot_state_changed`, (lifecycle) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          lot: { ...BASES[kind].lot, lifecycle },
          // Later rows that would also refuse: an operation in flight and a pending refund.
          ops: [op("started", 9)],
          refunds: [...BASES[kind].refunds, refund("re_p", "pending", 10)],
        }),
      ).toEqual(LOT_STATE_CHANGED);
    });
  }
});

describe("row 2: approve only — the lot must come from a completed payment with a PaymentIntent", () => {
  const laterRowsTrip = { ops: [op("awaiting_stripe", 9)], refunds: [refund("re_p", "pending", 10)] };

  it("a lot not bought with a payment is lot_state_changed", () => {
    expect(assessRefundCreate({ ...APPROVE_OK, ...laterRowsTrip, payment: null })).toEqual(
      LOT_STATE_CHANGED,
    );
  });

  it.each(["pending", "processing", "failed", "expired", "refunded"])(
    "a payment that is %s is lot_state_changed",
    (status) => {
      expect(
        assessRefundCreate({ ...APPROVE_OK, ...laterRowsTrip, payment: { ...COMPLETED_PAYMENT, status } }),
      ).toEqual(LOT_STATE_CHANGED);
    },
  );

  it("a payment without a PaymentIntent is lot_state_changed", () => {
    expect(
      assessRefundCreate({
        ...APPROVE_OK,
        ...laterRowsTrip,
        payment: { ...COMPLETED_PAYMENT, stripePaymentIntentId: null },
      }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("remaining credits that differ from the lot's ledger sum are lot_state_changed", () => {
    expect(
      assessRefundCreate({
        ...APPROVE_OK,
        ...laterRowsTrip,
        lot: { lifecycle: "refund_pending", remainingCredits: 100, ledgerSum: 99 },
      }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("retry does not check the ledger sum", () => {
    expect(
      assessRefundCreate({
        ...RETRY_OK,
        lot: { lifecycle: "refunding", remainingCredits: 100, ledgerSum: 40 },
      }),
    ).toEqual({ outcome: "create_refund", amountCents: PAID, sendAmount: false });
  });
});

describe("row 3: a disposition is already in flight on this lot", () => {
  for (const kind of ["approve", "retry", "refund_again"] as const) {
    it.each(["started", "awaiting_stripe"] as const)(`${kind} with a %s disposition is operation_in_progress`, (status) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          ops: [...BASES[kind].ops, op(status, 30)],
          // A pending refund (row 6) and, for refund_again, mismatched ids (row 5).
          refunds: [...BASES[kind].refunds, refund("re_p", "requires_action", 10)],
          failedRefundIds: kind === "refund_again" ? ["re_other"] : [],
        }),
      ).toEqual(IN_PROGRESS);
    });
  }
});

describe("row 4: retry needs an open needs_attention; refund_again needs an unresolved failed refund", () => {
  it("retry with no disposition at all is lot_state_changed", () => {
    expect(assessRefundCreate({ ...RETRY_OK, ops: [] })).toEqual(LOT_STATE_CHANGED);
  });

  it("retry whose latest disposition succeeded is lot_state_changed", () => {
    expect(assessRefundCreate({ ...RETRY_OK, ops: [op("succeeded", 5)] })).toEqual(LOT_STATE_CHANGED);
  });

  it("retry whose latest needs_attention is already closed is lot_state_changed", () => {
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("needs_attention", 5, at(6))] }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("retry judges the latest disposition by created_at, not by list order", () => {
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("needs_attention", 20), op("succeeded", 10)] }),
    ).toEqual({ outcome: "create_refund", amountCents: PAID, sendAmount: false });
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("succeeded", 20), op("needs_attention", 10)] }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("retry is refused here before a pending refund is looked at", () => {
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("succeeded", 5)], refunds: [refund("re_p", "pending", 10)] }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("refund_again with no unresolved failed refund is lot_state_changed", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [
          refund("re_ok", "succeeded", 1000),
          refund("re_never", "failed", 300, { everSucceeded: false }),
          refund("re_done", "failed", 200, { everSucceeded: true, resolvedByOperationId: RESOLVER }),
          refund("re_p", "pending", 10),
        ],
        failedRefundIds: [],
      }),
    ).toEqual(LOT_STATE_CHANGED);
  });
});

describe("row 5: refund_again — the named failed refunds must be exactly the unresolved ones", () => {
  const changed = stripeBlocks("failed_refunds_changed");

  it("a subset is failed_refunds_changed", () => {
    expect(assessRefundCreate({ ...REFUND_AGAIN_OK, failedRefundIds: ["re_f1"] })).toEqual(changed);
  });

  it("a superset is failed_refunds_changed", () => {
    expect(
      assessRefundCreate({ ...REFUND_AGAIN_OK, failedRefundIds: ["re_f1", "re_f2", "re_f3"] }),
    ).toEqual(changed);
  });

  it("a different set of the same size is failed_refunds_changed", () => {
    expect(assessRefundCreate({ ...REFUND_AGAIN_OK, failedRefundIds: ["re_f1", "re_x"] })).toEqual(changed);
  });

  it("an empty list is failed_refunds_changed", () => {
    expect(assessRefundCreate({ ...REFUND_AGAIN_OK, failedRefundIds: [] })).toEqual(changed);
  });

  it("naming a refund that was answered for in the meantime is failed_refunds_changed", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [
          failedAfterSuccess("re_f1", 300),
          refund("re_f2", "failed", 200, { everSucceeded: true, resolvedByOperationId: RESOLVER }),
        ],
        failedRefundIds: ["re_f1", "re_f2"],
      }),
    ).toEqual(changed);
  });

  it("is judged before a pending refund", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [...REFUND_AGAIN_OK.refunds, refund("re_p", "pending", 10)],
        failedRefundIds: ["re_f1"],
      }),
    ).toEqual(changed);
  });

  it("the same set in another order passes", () => {
    expect(assessRefundCreate({ ...REFUND_AGAIN_OK, failedRefundIds: ["re_f2", "re_f1"] })).toEqual({
      outcome: "create_refund",
      amountCents: 500,
      sendAmount: true,
    });
  });
});

describe("row 6: a refund is pending or requires_action", () => {
  for (const kind of ["approve", "retry", "refund_again"] as const) {
    it.each(["pending", "requires_action"] as const)(`${kind} with a %s refund is refund_in_progress`, (status) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          // Also fully refunded (row 7) and an unconfirmed external refund (row 8).
          refunds: [
            ...BASES[kind].refunds,
            refund("re_ext", "succeeded", PAID, { operationId: null }),
            refund("re_p", status, 10),
          ],
        }),
      ).toEqual(stripeBlocks("refund_in_progress"));
    });
  }
});

describe("row 7: approve and retry — the paid amount is already refunded", () => {
  for (const kind of ["approve", "retry"] as const) {
    it(`${kind} when the succeeded sum equals the paid amount is already_refunded`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_a", "succeeded", 600), refund("re_ext", "succeeded", 400, { operationId: null })],
        }),
      ).toEqual(stripeBlocks("already_refunded"));
    });

    it(`${kind} when the succeeded sum exceeds the paid amount is already_refunded`, () => {
      expect(
        assessRefundCreate({ ...BASES[kind], refunds: [refund("re_a", "succeeded", PAID + 1)] }),
      ).toEqual(stripeBlocks("already_refunded"));
    });

    it(`${kind} one cent short of the paid amount still creates`, () => {
      expect(
        assessRefundCreate({ ...BASES[kind], refunds: [refund("re_a", "succeeded", PAID - 1)] }),
      ).toEqual({ outcome: "create_refund", amountCents: 1, sendAmount: false });
    });
  }

  it("refund_again does not use this row", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [...REFUND_AGAIN_OK.refunds, refund("re_ok", "succeeded", PAID)],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: 500, sendAmount: true });
  });
});

describe("row 8: approve and retry — a succeeded external refund the operator did not confirm", () => {
  for (const kind of ["approve", "retry"] as const) {
    it(`${kind} with an unconfirmed succeeded external refund is unconfirmed_external_refund`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "succeeded", 300, { operationId: null })],
          confirmedRefundIds: ["re_something_else"],
        }),
      ).toEqual(stripeBlocks("unconfirmed_external_refund"));
    });

    it(`${kind} ignores an unconfirmed external refund that did not succeed`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "canceled", 300, { operationId: null })],
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "create_refund", amountCents: PAID, sendAmount: false });
    });

    it(`${kind} does not ask for an own succeeded refund to be confirmed`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_own", "succeeded", 300)],
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "create_refund", amountCents: 700, sendAmount: false });
    });
  }

  it("refund_again does not use this row", () => {
    expect(
      assessRefundCreate({
        ...REFUND_AGAIN_OK,
        refunds: [...REFUND_AGAIN_OK.refunds, refund("re_ext", "succeeded", 100, { operationId: null })],
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: 500, sendAmount: true });
  });
});

describe("previewKind: the preview picks the operation from the lot's state", () => {
  it.each<[CreditLotLifecycle, RefundCreateKind | null]>([
    ["refund_pending", "approve"],
    ["refunding", "retry"],
    ["refunded", "refund_again"],
    ["active", null],
    ["depleted", null],
  ])("%s → %s", (lifecycle, kind) => {
    expect(previewKind(lifecycle)).toBe(kind);
  });
});

describe("assessRefundPreview", () => {
  /** The preview gets no kind and none of the ids the confirmation page sends back. */
  const strip = (i: AssessInput) => ({ lot: i.lot, payment: i.payment, ops: i.ops, refunds: i.refunds });

  it("previews an approve on a refund_pending lot", () => {
    expect(assessRefundPreview(strip(APPROVE_OK))).toEqual({
      kind: "approve",
      result: { outcome: "create_refund", amountCents: PAID, sendAmount: false },
    });
  });

  it("previews a retry on a refunding lot", () => {
    expect(assessRefundPreview(strip(RETRY_OK))).toEqual({
      kind: "retry",
      result: { outcome: "create_refund", amountCents: PAID, sendAmount: false },
    });
  });

  it("previews a refund_again on a refunded lot with the current unresolved failed refunds' sum", () => {
    expect(assessRefundPreview(strip(REFUND_AGAIN_OK))).toEqual({
      kind: "refund_again",
      result: { outcome: "create_refund", amountCents: 500, sendAmount: true },
    });
  });

  it("has no operation for an active or depleted lot", () => {
    expect(
      assessRefundPreview({ ...strip(APPROVE_OK), lot: { ...APPROVE_OK.lot, lifecycle: "active" } }),
    ).toEqual({ kind: null });
    expect(
      assessRefundPreview({ ...strip(APPROVE_OK), lot: { ...APPROVE_OK.lot, lifecycle: "depleted" } }),
    ).toEqual({ kind: null });
  });

  it("skips the external-refund row so the operator can confirm it on the page", () => {
    expect(
      assessRefundPreview({
        ...strip(APPROVE_OK),
        refunds: [refund("re_ext", "succeeded", 300, { operationId: null })],
      }),
    ).toEqual({
      kind: "approve",
      result: { outcome: "create_refund", amountCents: 700, sendAmount: false },
    });
  });

  it("still answers the other rows' reason codes", () => {
    expect(
      assessRefundPreview({ ...strip(APPROVE_OK), refunds: [refund("re_p", "pending", 10)] }),
    ).toEqual({ kind: "approve", result: stripeBlocks("refund_in_progress") });
    expect(
      assessRefundPreview({ ...strip(RETRY_OK), refunds: [refund("re_a", "succeeded", PAID)] }),
    ).toEqual({ kind: "retry", result: stripeBlocks("already_refunded") });
    expect(
      assessRefundPreview({ ...strip(APPROVE_OK), ops: [op("awaiting_stripe", 3)] }),
    ).toEqual({ kind: "approve", result: IN_PROGRESS });
    expect(assessRefundPreview({ ...strip(RETRY_OK), ops: [op("succeeded", 3)] })).toEqual({
      kind: "retry",
      result: LOT_STATE_CHANGED,
    });
    expect(
      assessRefundPreview({
        ...strip(APPROVE_OK),
        lot: { lifecycle: "refund_pending", remainingCredits: 5, ledgerSum: 6 },
      }),
    ).toEqual({ kind: "approve", result: LOT_STATE_CHANGED });
  });

  it("refund_again with nothing unresolved previews lot_state_changed", () => {
    expect(
      assessRefundPreview({ ...strip(REFUND_AGAIN_OK), refunds: [refund("re_ok", "succeeded", PAID)] }),
    ).toEqual({ kind: "refund_again", result: LOT_STATE_CHANGED });
  });
});

describe("§9: the preview and the endpoint agree when the operator confirms what the preview showed", () => {
  const statusArb = fc.constantFrom<StripeRefundStatus>(
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "canceled",
  );
  const refundsArb = fc
    .array(
      fc.record({
        status: statusArb,
        amountCents: fc.integer({ min: 1, max: 1500 }),
        external: fc.boolean(),
        everSucceeded: fc.boolean(),
        resolved: fc.boolean(),
      }),
      { maxLength: 6 },
    )
    .map((rows) =>
      rows.map((r, i) =>
        refund(`re_${i}`, r.status, r.amountCents, {
          operationId: r.external ? null : OWN_OP,
          everSucceeded: r.status === "succeeded" || r.everSucceeded,
          resolvedByOperationId: r.resolved ? RESOLVER : null,
        }),
      ),
    );
  const opsArb = fc.array(
    fc.record({
      status: fc.constantFrom<AssessOperation["status"]>(
        "started",
        "awaiting_stripe",
        "succeeded",
        "needs_attention",
      ),
      minute: fc.integer({ min: 0, max: 59 }),
      closed: fc.boolean(),
    }),
    { maxLength: 4 },
  );
  const inputArb = fc.record({
    lifecycle: fc.constantFrom<CreditLotLifecycle>(
      "active",
      "depleted",
      "refund_pending",
      "refunding",
      "refunded",
    ),
    ledgerMatches: fc.boolean(),
    payment: fc.option(
      fc.record({
        status: fc.constantFrom("completed", "pending", "refunded"),
        stripePaymentIntentId: fc.option(fc.constant("pi_1"), { nil: null }),
        paidCents: fc.integer({ min: 1, max: 3000 }),
      }),
      { nil: null },
    ),
    ops: opsArb,
    refunds: refundsArb,
  });

  it("whenever the preview answers, the matching endpoint answers the same", () => {
    fc.assert(
      fc.property(inputArb, (g) => {
        // A lot with no payment behind it is a 404 before any of this runs;
        // only approve's row 2 is asked to judge one.
        const payment =
          g.payment === null && g.lifecycle !== "refund_pending" ? COMPLETED_PAYMENT : g.payment;
        const base = {
          lot: { lifecycle: g.lifecycle, remainingCredits: 50, ledgerSum: g.ledgerMatches ? 50 : 49 },
          payment,
          ops: g.ops.map((o) =>
            op(o.status, o.minute, o.status === "needs_attention" && o.closed ? at(59) : null),
          ),
          refunds: g.refunds,
        };
        const preview = assessRefundPreview(base);
        if (preview.kind === null) return;
        // What the confirmation page sends back: every succeeded external refund
        // it showed, and every unresolved failed refund it listed.
        const confirmedRefundIds = g.refunds
          .filter((r) => r.status === "succeeded" && r.operationId === null)
          .map((r) => r.stripeRefundId);
        const failedRefundIds =
          g.lifecycle === "refunded"
            ? g.refunds
                .filter(
                  (r) =>
                    r.everSucceeded &&
                    (r.status === "failed" || r.status === "canceled") &&
                    r.resolvedByOperationId === null,
                )
                .map((r) => r.stripeRefundId)
            : [];
        const endpoint = assessRefundCreate({
          ...base,
          kind: preview.kind,
          confirmedRefundIds,
          failedRefundIds,
        });
        expect(endpoint).toEqual(preview.result);
      }),
      { numRuns: 500 },
    );
  });
});
