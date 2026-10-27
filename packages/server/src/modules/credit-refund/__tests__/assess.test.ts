// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement table shared by the preview and the two endpoints that
 * create a Stripe refund: approve and retry (inner#1410 v9 §5.2).
 *
 * Rows, top to bottom, first match answers:
 *
 * 1. the lot is not in the state the kind needs (approve: refund_pending;
 *    retry: refunding) → lot_state_changed;
 * 2. approve only: no payment, a payment not completed or without a
 *    PaymentIntent, or remaining credits that differ from the ledger sum →
 *    lot_state_changed;
 * 3. a disposition in flight → operation_in_progress;
 * 4. retry only: the latest disposition is not an open needs_attention →
 *    lot_state_changed;
 * 5. a pending or requires_action refund → stripe_blocks refund_in_progress;
 * 6. ANY failed refund of the payment, ours or external, answered for or
 *    not → stripe_blocks refund_failed (a canceled refund never moved money
 *    and does not block);
 * 7. succeeded sum ≥ paid → stripe_blocks already_refunded;
 * 8. a succeeded external refund not in confirmedRefundIds →
 *    stripe_blocks unconfirmed_external_refund (skipped by the preview);
 * 9. create the refund, no amount sent; Stripe refunds paid − succeeded.
 *
 * Every row is tested with an input that also trips the rows after it, so a
 * reordered table fails here.
 *
 * v9 removes refund_again: a refunded lot has no create operation, so the
 * preview judges none for it. The preview also answers whether restoring
 * credits holds right now (`restoreCredits`), with the same function the
 * restore endpoint runs. The §9 properties at the end pin that the preview
 * and the endpoints agree for approve, retry and restore.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { CreditLotLifecycle } from "@breatic/shared";
import {
  assessOneShot,
  assessRefundCreate,
  assessRefundPreview,
  previewKind,
  type AssessInput,
  type AssessOperation,
} from "@server/modules/credit-refund/assess.js";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";
import { unresolvedOf } from "./unresolved-oracle.js";

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
    pendingReason: status === "pending" ? "processing" : null,
    operationId: OWN_OP,
    everSucceeded: status === "succeeded",
    resolvedByOperationId: null,
    failureReason: null,
    ...overrides,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 8, minute));

const op = (
  status: AssessOperation["status"],
  minute: number,
  extra: Partial<AssessOperation> = {},
): AssessOperation => ({
  status,
  attentionClosedAt: null,
  createdAt: at(minute),
  result: null,
  attentionReason: status === "needs_attention" ? "attempts_exhausted" : null,
  ...extra,
});

const COMPLETED_PAYMENT = { status: "completed", stripePaymentIntentId: "pi_1", paidCents: PAID };

/** An approve that passes every row. */
const APPROVE_OK: AssessInput = {
  kind: "approve",
  lot: { lifecycle: "refund_pending", remainingCredits: 100, ledgerSum: 100 },
  payment: COMPLETED_PAYMENT,
  ops: [],
  refunds: [],
  confirmedRefundIds: [],
};

/** A retry that passes every row: the last disposition is an open needs_attention. */
const RETRY_OK: AssessInput = {
  kind: "retry",
  lot: { lifecycle: "refunding", remainingCredits: 100, ledgerSum: 100 },
  payment: COMPLETED_PAYMENT,
  ops: [op("needs_attention", 5)],
  refunds: [],
  confirmedRefundIds: [],
};

const BASES: Record<"approve" | "retry", AssessInput> = { approve: APPROVE_OK, retry: RETRY_OK };
const KINDS = ["approve", "retry"] as const;

const LOT_STATE_CHANGED = { outcome: "blocked", code: "lot_state_changed" };
const IN_PROGRESS = { outcome: "blocked", code: "operation_in_progress" };
const stripeBlocks = (reason: string) => ({ outcome: "blocked", code: "stripe_blocks", reason });
const create = (amountCents: number) => ({ outcome: "create_refund", amountCents });

describe("assessRefundCreate: the last row creates the refund for paid − succeeded, sending no amount", () => {
  it("approve with nothing on Stripe refunds the whole paid amount", () => {
    expect(assessRefundCreate(APPROVE_OK)).toEqual(create(PAID));
  });

  it("retry with nothing on Stripe refunds the whole paid amount", () => {
    expect(assessRefundCreate(RETRY_OK)).toEqual(create(PAID));
  });

  for (const kind of KINDS) {
    it(`${kind} with a confirmed external refund refunds paid − succeeded`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "succeeded", 250, { operationId: null })],
          confirmedRefundIds: ["re_ext"],
        }),
      ).toEqual(create(750));
    });

    it(`${kind} with an own succeeded refund refunds the rest without asking for confirmation`, () => {
      expect(assessRefundCreate({ ...BASES[kind], refunds: [refund("re_own", "succeeded", 300)] })).toEqual(
        create(700),
      );
    });

    it(`${kind} does not subtract a canceled refund from the amount`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_c", "canceled", 400, { operationId: null }), refund("re_ok", "succeeded", 100)],
        }),
      ).toEqual(create(900));
    });
  }

  it("the answer carries no amount-to-send flag: the create never sends an amount", () => {
    const answer = assessRefundCreate(APPROVE_OK);
    expect(answer).not.toHaveProperty("sendAmount");
  });
});

describe("row 1: the lot is not in the state the operation needs", () => {
  const wrongState: Record<"approve" | "retry", CreditLotLifecycle[]> = {
    approve: ["active", "depleted", "refunding", "refunded"],
    retry: ["active", "depleted", "refund_pending", "refunded"],
  };

  for (const kind of KINDS) {
    it.each<CreditLotLifecycle>(wrongState[kind])(`${kind} on a %s lot is lot_state_changed`, (lifecycle) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          lot: { ...BASES[kind].lot, lifecycle },
          // Later rows that would also refuse: an operation in flight, a
          // pending refund and a failed one.
          ops: [op("started", 9)],
          refunds: [refund("re_p", "pending", 10), refund("re_f", "failed", 10)],
        }),
      ).toEqual(LOT_STATE_CHANGED);
    });
  }
});

describe("row 2: approve only — the lot must come from a completed payment with a PaymentIntent", () => {
  const laterRowsTrip = {
    ops: [op("awaiting_stripe", 9)],
    refunds: [refund("re_p", "pending", 10), refund("re_f", "failed", 10)],
  };

  it("a lot not bought with a payment is lot_state_changed", () => {
    expect(assessRefundCreate({ ...APPROVE_OK, ...laterRowsTrip, payment: null })).toEqual(LOT_STATE_CHANGED);
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
      assessRefundCreate({ ...RETRY_OK, lot: { lifecycle: "refunding", remainingCredits: 100, ledgerSum: 40 } }),
    ).toEqual(create(PAID));
  });
});

describe("row 3: a disposition is already in flight on this lot", () => {
  for (const kind of KINDS) {
    it.each(["started", "awaiting_stripe"] as const)(`${kind} with a %s disposition is operation_in_progress`, (status) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          ops: [...BASES[kind].ops, op(status, 30)],
          // Rows 5 and 6 would also refuse.
          refunds: [refund("re_p", "requires_action", 10), refund("re_f", "failed", 10)],
        }),
      ).toEqual(IN_PROGRESS);
    });
  }
});

describe("row 4: retry needs the latest disposition to be an open needs_attention", () => {
  it("retry with no disposition at all is lot_state_changed", () => {
    expect(assessRefundCreate({ ...RETRY_OK, ops: [] })).toEqual(LOT_STATE_CHANGED);
  });

  it("retry whose latest disposition succeeded is lot_state_changed", () => {
    expect(assessRefundCreate({ ...RETRY_OK, ops: [op("succeeded", 5, { result: "sent_back" })] })).toEqual(
      LOT_STATE_CHANGED,
    );
  });

  it("retry whose latest needs_attention is already closed is lot_state_changed", () => {
    expect(assessRefundCreate({ ...RETRY_OK, ops: [op("needs_attention", 5, { attentionClosedAt: at(6) })] })).toEqual(
      LOT_STATE_CHANGED,
    );
  });

  it("retry judges the latest disposition by created_at, not by list order", () => {
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("needs_attention", 20), op("succeeded", 10, { result: "sent_back" })] }),
    ).toEqual(create(PAID));
    expect(
      assessRefundCreate({ ...RETRY_OK, ops: [op("succeeded", 20, { result: "sent_back" }), op("needs_attention", 10)] }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("retry is refused here before a pending or failed refund is looked at", () => {
    expect(
      assessRefundCreate({
        ...RETRY_OK,
        ops: [op("succeeded", 5, { result: "sent_back" })],
        refunds: [refund("re_p", "pending", 10), refund("re_f", "failed", 10)],
      }),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("retry after any needs_attention reason, stripe_declined and stripe_request_invalid included, passes this row", () => {
    for (const attentionReason of ["stripe_declined", "stripe_request_invalid", "partial_refund"] as const) {
      expect(assessRefundCreate({ ...RETRY_OK, ops: [op("needs_attention", 5, { attentionReason })] })).toEqual(
        create(PAID),
      );
    }
  });
});

describe("row 5: a refund is pending or requires_action", () => {
  for (const kind of KINDS) {
    it.each(["pending", "requires_action"] as const)(`${kind} with a %s refund is refund_in_progress`, (status) => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          // Also a failed refund (row 6), fully refunded (row 7) and an
          // unconfirmed external refund (row 8).
          refunds: [
            refund("re_f", "failed", 100),
            refund("re_ext", "succeeded", PAID, { operationId: null }),
            refund("re_p", status, 10),
          ],
        }),
      ).toEqual(stripeBlocks("refund_in_progress"));
    });
  }
});

/**
 * Row 6 (v9): Stripe refuses any further refund of a charge once one refund
 * on it failed (measured 2026-10-14: after a failed 300 the charge's
 * amount_refunded went back to 0 and a second 300 was still refused with
 * "A previous attempt to refund charge … failed"). So the table blocks on
 * the presence of a failed refund, not on what is left to refund.
 */
describe("row 6: any failed refund blocks the create (refund_failed)", () => {
  for (const kind of KINDS) {
    it(`${kind} with one own failed refund of the whole amount is refund_failed`, () => {
      expect(
        assessRefundCreate({ ...BASES[kind], refunds: [refund("re_own", "failed", PAID, { everSucceeded: true })] }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind} with a small failed refund that leaves plenty to refund is still refund_failed`, () => {
      expect(assessRefundCreate({ ...BASES[kind], refunds: [refund("re_f", "failed", 1)] })).toEqual(
        stripeBlocks("refund_failed"),
      );
    });

    it(`${kind} with an external failed refund is refund_failed`, () => {
      expect(
        assessRefundCreate({ ...BASES[kind], refunds: [refund("re_ext", "failed", 300, { operationId: null })] }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind} with a failed refund already answered for is still refund_failed`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_done", "failed", 300, { resolvedByOperationId: RESOLVER })],
        }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind} with a failed refund that never succeeded is refund_failed`, () => {
      expect(
        assessRefundCreate({ ...BASES[kind], refunds: [refund("re_f", "failed", 300, { everSucceeded: false })] }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind}: failed beats already_refunded when the succeeded sum also covers the payment`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ok", "succeeded", PAID), refund("re_f", "failed", 200)],
        }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind}: failed beats unconfirmed_external_refund`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "succeeded", 500, { operationId: null }), refund("re_f", "failed", 500)],
          confirmedRefundIds: [],
        }),
      ).toEqual(stripeBlocks("refund_failed"));
    });

    it(`${kind}: a canceled refund does not block, own or external`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_c1", "canceled", 500), refund("re_c2", "canceled", 300, { operationId: null })],
        }),
      ).toEqual(create(PAID));
    });
  }
});

describe("row 7: the paid amount is already refunded", () => {
  for (const kind of KINDS) {
    it(`${kind} when the succeeded sum equals the paid amount is already_refunded, before an unconfirmed external refund`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_a", "succeeded", 600), refund("re_ext", "succeeded", 400, { operationId: null })],
          confirmedRefundIds: [],
        }),
      ).toEqual(stripeBlocks("already_refunded"));
    });

    it(`${kind} when the succeeded sum exceeds the paid amount is already_refunded`, () => {
      expect(assessRefundCreate({ ...BASES[kind], refunds: [refund("re_a", "succeeded", PAID + 1)] })).toEqual(
        stripeBlocks("already_refunded"),
      );
    });

    it(`${kind} one cent short of the paid amount creates for that cent`, () => {
      expect(assessRefundCreate({ ...BASES[kind], refunds: [refund("re_a", "succeeded", PAID - 1)] })).toEqual(
        create(1),
      );
    });
  }
});

describe("row 8: a succeeded external refund the operator did not confirm", () => {
  for (const kind of KINDS) {
    it(`${kind} with an unconfirmed succeeded external refund is unconfirmed_external_refund`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "succeeded", 300, { operationId: null })],
          confirmedRefundIds: ["re_something_else"],
        }),
      ).toEqual(stripeBlocks("unconfirmed_external_refund"));
    });

    it(`${kind} ignores an unconfirmed external refund that was canceled`, () => {
      expect(
        assessRefundCreate({
          ...BASES[kind],
          refunds: [refund("re_ext", "canceled", 300, { operationId: null })],
          confirmedRefundIds: [],
        }),
      ).toEqual(create(PAID));
    });
  }
});

describe("previewKind: the preview picks the create operation from the lot's state", () => {
  it.each<[CreditLotLifecycle, "approve" | "retry" | null]>([
    ["refund_pending", "approve"],
    ["refunding", "retry"],
    ["refunded", null],
    ["active", null],
    ["depleted", null],
  ])("%s → %s", (lifecycle, kind) => {
    expect(previewKind(lifecycle)).toBe(kind);
  });
});

/** What the preview reads: the endpoint's facts without the confirmation, plus the restore facts. */
function previewInput(i: AssessInput, extra: { unresolved?: RefundCopy[]; disputed?: boolean } = {}) {
  return {
    lot: i.lot,
    payment: i.payment,
    ops: i.ops,
    refunds: i.refunds,
    unresolvedFailedRefunds: extra.unresolved ?? [],
    disputed: extra.disputed ?? false,
  };
}

/** The create half of a preview answer. */
function createHalf(p: ReturnType<typeof assessRefundPreview>): unknown {
  return p.kind === null ? { kind: null } : { kind: p.kind, result: p.result };
}

describe("assessRefundPreview: the create operation", () => {
  it("previews an approve on a refund_pending lot", () => {
    expect(createHalf(assessRefundPreview(previewInput(APPROVE_OK)))).toEqual({ kind: "approve", result: create(PAID) });
  });

  it("previews a retry on a refunding lot", () => {
    expect(createHalf(assessRefundPreview(previewInput(RETRY_OK)))).toEqual({ kind: "retry", result: create(PAID) });
  });

  it("judges no create operation on a refunded lot, even with an unresolved failed refund", () => {
    const failedLater = refund("re_later", "failed", PAID, { everSucceeded: true });
    expect(
      createHalf(
        assessRefundPreview({
          ...previewInput({ ...APPROVE_OK, lot: { lifecycle: "refunded", remainingCredits: 0, ledgerSum: 0 } }),
          ops: [op("succeeded", 1, { result: "refunded" })],
          refunds: [failedLater],
          unresolvedFailedRefunds: [failedLater],
        }),
      ),
    ).toEqual({ kind: null });
  });

  it("has no create operation for an active or depleted lot", () => {
    for (const lifecycle of ["active", "depleted"] as const) {
      expect(
        createHalf(assessRefundPreview(previewInput({ ...APPROVE_OK, lot: { ...APPROVE_OK.lot, lifecycle } }))),
      ).toEqual({ kind: null });
    }
  });

  it("skips the external-refund row so the operator can confirm it on the page", () => {
    expect(
      createHalf(
        assessRefundPreview(
          previewInput({ ...APPROVE_OK, refunds: [refund("re_ext", "succeeded", 300, { operationId: null })] }),
        ),
      ),
    ).toEqual({ kind: "approve", result: create(700) });
  });

  it("answers the other rows' reason codes, refund_failed included", () => {
    expect(
      createHalf(assessRefundPreview(previewInput({ ...APPROVE_OK, refunds: [refund("re_p", "pending", 10)] }))),
    ).toEqual({ kind: "approve", result: stripeBlocks("refund_in_progress") });
    expect(
      createHalf(assessRefundPreview(previewInput({ ...RETRY_OK, refunds: [refund("re_f", "failed", PAID)] }))),
    ).toEqual({ kind: "retry", result: stripeBlocks("refund_failed") });
    expect(
      createHalf(assessRefundPreview(previewInput({ ...RETRY_OK, refunds: [refund("re_a", "succeeded", PAID)] }))),
    ).toEqual({ kind: "retry", result: stripeBlocks("already_refunded") });
    expect(createHalf(assessRefundPreview(previewInput({ ...APPROVE_OK, ops: [op("awaiting_stripe", 3)] })))).toEqual({
      kind: "approve",
      result: IN_PROGRESS,
    });
    expect(
      createHalf(assessRefundPreview(previewInput({ ...RETRY_OK, ops: [op("succeeded", 3, { result: "sent_back" })] }))),
    ).toEqual({ kind: "retry", result: LOT_STATE_CHANGED });
  });
});

describe("assessRefundPreview: restoreCredits is the restore endpoint's own answer", () => {
  const failedLater = refund("re_later", "failed", PAID, { everSucceeded: true });
  const refundedLot = { lifecycle: "refunded" as const, remainingCredits: 0, ledgerSum: 0 };

  it("is allowed on a refunded lot whose refund failed later", () => {
    const p = assessRefundPreview({
      lot: refundedLot,
      payment: COMPLETED_PAYMENT,
      ops: [op("succeeded", 1, { result: "refunded" })],
      refunds: [failedLater],
      unresolvedFailedRefunds: [failedLater],
      disputed: false,
    });
    expect(p.restoreCredits).toEqual({ outcome: "proceed" });
  });

  it("is blocked by disputed when Stripe says the charge is disputed", () => {
    const p = assessRefundPreview({
      lot: refundedLot,
      payment: COMPLETED_PAYMENT,
      ops: [op("succeeded", 1, { result: "refunded" })],
      refunds: [failedLater],
      unresolvedFailedRefunds: [failedLater],
      disputed: true,
    });
    expect(p.restoreCredits).toEqual(stripeBlocks("disputed"));
  });

  it("is blocked by paid_outside when money was once given outside, even with a new unresolved failure", () => {
    // Booked, a later failure answered for outside, then another refund failed later.
    const answered = refund("re_a", "failed", 400, { everSucceeded: true, resolvedByOperationId: RESOLVER });
    const failedAgain = refund("re_b", "failed", 600, { everSucceeded: true });
    const p = assessRefundPreview({
      lot: refundedLot,
      payment: COMPLETED_PAYMENT,
      ops: [op("succeeded", 1, { result: "refunded" }), op("succeeded", 2, { result: "resolved_outside" })],
      refunds: [answered, failedAgain],
      unresolvedFailedRefunds: [failedAgain],
      disputed: false,
    });
    expect(p.restoreCredits).toEqual(stripeBlocks("paid_outside"));
  });

  it("is blocked by paid_outside after resolve_outside answered for the only failed refund (design 3535a275)", () => {
    const answered = refund("re_later", "failed", PAID, { everSucceeded: true, resolvedByOperationId: RESOLVER });
    const p = assessRefundPreview({
      lot: refundedLot,
      payment: COMPLETED_PAYMENT,
      ops: [op("succeeded", 1, { result: "refunded" }), op("succeeded", 2, { result: "resolved_outside" })],
      refunds: [answered],
      unresolvedFailedRefunds: [],
      disputed: true,
    });
    expect(p.restoreCredits).toEqual(stripeBlocks("paid_outside"));
  });

  it("is lot_state_changed on a refunded lot with nothing unresolved and no money given outside", () => {
    const p = assessRefundPreview({
      lot: refundedLot,
      payment: COMPLETED_PAYMENT,
      ops: [op("succeeded", 1, { result: "refunded" })],
      refunds: [refund("re_ok", "succeeded", PAID)],
      unresolvedFailedRefunds: [],
      disputed: true,
    });
    expect(p.restoreCredits).toEqual(LOT_STATE_CHANGED);
  });

  it("is blocked by refund_succeeded while a refund of the payment succeeded", () => {
    const p = assessRefundPreview({
      ...previewInput(RETRY_OK),
      refunds: [refund("re_ok", "succeeded", 600)],
    });
    expect(p.restoreCredits).toEqual(stripeBlocks("refund_succeeded"));
  });

  it("is lot_state_changed on an active lot", () => {
    const p = assessRefundPreview(previewInput({ ...APPROVE_OK, lot: { ...APPROVE_OK.lot, lifecycle: "active" } }));
    expect(p.restoreCredits).toEqual(LOT_STATE_CHANGED);
  });
});

// ── §9: the preview and the endpoints agree ──────────────────────────

describe("§9: the preview and the endpoints agree when the operator confirms what the preview showed", () => {
  const statusArb = fc.constantFrom<StripeRefundStatus>("pending", "requires_action", "succeeded", "failed", "canceled");
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
      status: fc.constantFrom<AssessOperation["status"]>("started", "awaiting_stripe", "succeeded", "needs_attention"),
      minute: fc.integer({ min: 0, max: 59 }),
      closed: fc.boolean(),
      result: fc.constantFrom("refunded", "rejected", "sent_back", "resolved_outside", "restored"),
      attentionReason: fc.constantFrom(
        "partial_refund",
        "attempts_exhausted",
        "stripe_declined",
        "stripe_request_invalid",
        "stripe_refund_failed_later",
      ),
    }),
    { maxLength: 4 },
  );
  const inputArb = fc.record({
    lifecycle: fc.constantFrom<CreditLotLifecycle>("active", "depleted", "refund_pending", "refunding", "refunded"),
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
    disputed: fc.boolean(),
  });

  type Gen = typeof inputArb extends fc.Arbitrary<infer T> ? T : never;

  /**
   * Build the facts both sides read.
   * @param g - The generated case.
   * @returns The preview's input.
   */
  function facts(g: Gen) {
    // A lot with no payment behind it is a 404 before any of this runs;
    // only approve's row 2 is asked to judge one.
    const payment = g.payment === null && g.lifecycle !== "refund_pending" ? COMPLETED_PAYMENT : g.payment;
    return {
      lot: { lifecycle: g.lifecycle, remainingCredits: 50, ledgerSum: g.ledgerMatches ? 50 : 49 },
      payment,
      ops: g.ops.map((o) =>
        op(o.status, o.minute, {
          attentionClosedAt: o.status === "needs_attention" && o.closed ? at(59) : null,
          result: o.status === "succeeded" ? (o.result as AssessOperation["result"]) : null,
          attentionReason: o.status === "needs_attention" ? (o.attentionReason as AssessOperation["attentionReason"]) : null,
        }),
      ),
      refunds: g.refunds,
      unresolvedFailedRefunds: unresolvedOf(g.lifecycle, g.refunds),
      disputed: g.disputed,
    };
  }

  it("whenever the preview judges approve or retry, the matching endpoint answers the same", () => {
    fc.assert(
      fc.property(inputArb, (g) => {
        const base = facts(g);
        const preview = assessRefundPreview(base);
        if (preview.kind === null) return;
        // What the confirmation page sends back: every succeeded external
        // refund it showed.
        const confirmedRefundIds = g.refunds
          .filter((r) => r.status === "succeeded" && r.operationId === null)
          .map((r) => r.stripeRefundId);
        const endpoint = assessRefundCreate({
          kind: preview.kind,
          lot: base.lot,
          payment: base.payment,
          ops: base.ops,
          refunds: base.refunds,
          confirmedRefundIds,
        });
        expect(endpoint).toEqual(preview.result);
      }),
      { numRuns: 500 },
    );
  });

  it("the preview's restoreCredits equals the restore endpoint's answer when the operator sends the listed failed refunds", () => {
    fc.assert(
      fc.property(inputArb, (g) => {
        const base = facts(g);
        const preview = assessRefundPreview(base);
        const endpoint = assessOneShot({
          kind: "restore_credits",
          lot: { lifecycle: base.lot.lifecycle, remainingCredits: base.lot.remainingCredits },
          paidCents: base.payment?.paidCents ?? PAID,
          ops: base.ops,
          refunds: base.refunds,
          unresolvedFailedRefunds: base.unresolvedFailedRefunds,
          disputed: base.disputed,
          failedRefundIds: base.unresolvedFailedRefunds.map((r) => r.stripeRefundId),
        });
        expect(preview.restoreCredits).toEqual(endpoint);
      }),
      { numRuns: 500 },
    );
  });

  it("the preview includes all four one-shot verdicts using the current succeeded sum and unresolved ids", () => {
    fc.assert(
      fc.property(inputArb, (g) => {
        const base = facts(g);
        const expected = Object.fromEntries(
          (["reject", "settle", "send_back", "resolve_outside"] as const).map((kind) => [kind, assessOneShot({
            kind,
            lot: base.lot,
            paidCents: base.payment?.paidCents ?? 0,
            ops: base.ops,
            refunds: base.refunds,
            unresolvedFailedRefunds: base.unresolvedFailedRefunds,
            disputed: base.disputed,
            confirmedSucceededCents: base.refunds.reduce((sum, row) => sum + (row.status === "succeeded" ? row.amountCents : 0), 0),
            failedRefundIds: base.unresolvedFailedRefunds.map((row) => row.stripeRefundId),
          })]),
        );
        expect(assessRefundPreview(base)).toHaveProperty("oneShot", expected);
      }),
      { numRuns: 500 },
    );
  });

});
