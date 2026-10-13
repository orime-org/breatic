// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement of the four dispositions that finish in their request —
 * reject, settle, send_back, resolve_outside (inner#1410 §5.3) — and the two
 * §9 invariants that say a person is never left without a way out:
 *
 * - every `needs_attention` has an exit that passes the production judges:
 *   on a `refunding` lot one of settle, send_back, retry, resolve_outside;
 *   on a `refunded` lot one of refund_again, resolve_outside; and with no
 *   refund still processing, resolve_outside always passes on a lot that is
 *   not yet booked;
 * - a `refunded` lot with an unresolved failed refund, nothing in flight and
 *   nothing processing passes resolve_outside, and passes refund_again
 *   exactly when the amount it would send (the unresolved failed refunds'
 *   sum) is no more than paid − succeeded − failed (v6 §9).
 *
 * `assessOneShot` rows, top to bottom, first match answers:
 *
 * 1. the lot is not in a state the kind starts from → lot_state_changed
 *    (reject: refund_pending; settle: refunding, refund_pending; send_back:
 *    refunding; resolve_outside: refunded, refunding, refund_pending);
 *    reject also needs credits left;
 * 2. a disposition in flight → operation_in_progress;
 * 3. resolve_outside: a refunded lot with nothing unresolved →
 *    lot_state_changed; named ids not exactly the unresolved ones →
 *    stripe_blocks failed_refunds_changed (on refunding and refund_pending
 *    both lists may be empty);
 * 4. a refund pending or requires_action → stripe_blocks refund_in_progress;
 * 5. reject, send_back: any succeeded refund → stripe_blocks refund_succeeded;
 * 6. settle and resolve_outside: succeeded sum ≠ confirmed →
 *    succeeded_sum_changed; settle also: nothing succeeded →
 *    nothing_refunded; short of paid without acceptPartial →
 *    partial_not_accepted;
 * 7. proceed.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { CreditLotLifecycle } from "@breatic/shared";
import {
  assessOneShot,
  assessRefundCreate,
  type AssessOperation,
  type OneShotInput,
} from "@server/modules/credit-refund/assess.js";
import type { AttentionReason } from "@server/modules/credit-refund/operation.repo.js";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";
import { pickUnresolvedFailedRefunds } from "@server/modules/credit-refund/unresolved.js";

const OWN_OP = "11111111-1111-4111-8111-111111111111";
const RESOLVER = "22222222-2222-4222-8222-222222222222";
const PAID = 1000;

/**
 * One refund copy; `everSucceeded` follows the status unless overridden.
 * @param id - Stripe refund id.
 * @param status - Its status.
 * @param amountCents - Its amount.
 * @param overrides - Any other column.
 * @returns The copy.
 */
function refund(
  id: string,
  status: StripeRefundStatus,
  amountCents: number,
  overrides: Partial<RefundCopy> = {},
): RefundCopy {
  return {
    stripeRefundId: id,
    amountCents,
    status,
    operationId: OWN_OP,
    everSucceeded: status === "succeeded",
    resolvedByOperationId: null,
    failureReason: null,
    ...overrides,
  };
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 12, 9, minute));

/**
 * One earlier disposition as the judges see it.
 * @param status - Its status.
 * @param minute - Its creation minute, to order dispositions.
 * @param closed - Whether its needs_attention was closed.
 * @returns The disposition.
 */
function op(status: AssessOperation["status"], minute = 1, closed = false): AssessOperation {
  return { status, attentionClosedAt: closed ? at(59) : null, createdAt: at(minute) };
}

/**
 * A one-shot request on a lot in `lifecycle` that passes every row unless
 * the case overrides something.
 * @param kind - Which one-shot.
 * @param lifecycle - The lot's state.
 * @param extra - Overrides.
 * @returns The input.
 */
function oneShot(
  kind: OneShotInput["kind"],
  lifecycle: CreditLotLifecycle,
  extra: Partial<OneShotInput> = {},
): OneShotInput {
  return {
    kind,
    lot: { lifecycle, remainingCredits: lifecycle === "refunded" ? 0 : 100 },
    paidCents: PAID,
    ops: [],
    refunds: [],
    ...extra,
  };
}

const PROCEED = { outcome: "proceed" };
const LOT_STATE_CHANGED = { outcome: "blocked", code: "lot_state_changed" };
const IN_PROGRESS = { outcome: "blocked", code: "operation_in_progress" };
const stripeBlocks = (reason: string) => ({ outcome: "blocked", code: "stripe_blocks", reason });

const ALL_LIFECYCLES: CreditLotLifecycle[] = ["active", "depleted", "refund_pending", "refunding", "refunded"];

describe("assessOneShot row 1: the lot's state", () => {
  const allowed: Record<OneShotInput["kind"], CreditLotLifecycle[]> = {
    reject: ["refund_pending"],
    settle: ["refund_pending", "refunding"],
    send_back: ["refunding"],
    resolve_outside: ["refund_pending", "refunding", "refunded"],
  };

  for (const kind of ["reject", "settle", "send_back", "resolve_outside"] as const) {
    const refused = ALL_LIFECYCLES.filter((l) => !allowed[kind].includes(l));
    it.each(refused)(`${kind} on a %s lot is lot_state_changed, before anything in flight`, (lifecycle) => {
      expect(
        assessOneShot(oneShot(kind, lifecycle, { ops: [op("started", 9)], refunds: [refund("re_p", "pending", 5)] })),
      ).toEqual(LOT_STATE_CHANGED);
    });
  }

  it("reject of a lot with no credits left is lot_state_changed", () => {
    expect(
      assessOneShot({ ...oneShot("reject", "refund_pending"), lot: { lifecycle: "refund_pending", remainingCredits: 0 } }),
    ).toEqual(LOT_STATE_CHANGED);
  });
});

describe("assessOneShot row 2: a disposition in flight", () => {
  const cases: [OneShotInput["kind"], CreditLotLifecycle][] = [
    ["reject", "refund_pending"],
    ["settle", "refunding"],
    ["send_back", "refunding"],
    ["resolve_outside", "refunded"],
    ["resolve_outside", "refunding"],
    ["resolve_outside", "refund_pending"],
  ];
  for (const [kind, lifecycle] of cases) {
    it.each(["started", "awaiting_stripe"] as const)(`${kind} on a ${lifecycle} lot with a %s disposition is operation_in_progress`, (status) => {
      expect(
        assessOneShot(
          oneShot(kind, lifecycle, {
            ops: [op("needs_attention", 1), op(status, 2)],
            refunds: [refund("re_p", "requires_action", 5)],
            failedRefundIds: ["re_nobody"],
          }),
        ),
      ).toEqual(IN_PROGRESS);
    });
  }
});

describe("assessOneShot: reject", () => {
  it("proceeds with nothing on Stripe", () => {
    expect(assessOneShot(oneShot("reject", "refund_pending"))).toEqual(PROCEED);
  });

  it("proceeds when the only refunds failed or were canceled", () => {
    expect(
      assessOneShot(
        oneShot("reject", "refund_pending", {
          refunds: [refund("re_f", "failed", 400), refund("re_c", "canceled", 100, { operationId: null })],
        }),
      ),
    ).toEqual(PROCEED);
  });

  it.each(["pending", "requires_action"] as const)("a %s refund is refund_in_progress, before a succeeded one", (status) => {
    expect(
      assessOneShot(
        oneShot("reject", "refund_pending", { refunds: [refund("re_ok", "succeeded", 300), refund("re_p", status, 5)] }),
      ),
    ).toEqual(stripeBlocks("refund_in_progress"));
  });

  it("a succeeded refund is refund_succeeded", () => {
    expect(
      assessOneShot(oneShot("reject", "refund_pending", { refunds: [refund("re_ok", "succeeded", 1, { operationId: null })] })),
    ).toEqual(stripeBlocks("refund_succeeded"));
  });
});

describe("assessOneShot: settle", () => {
  it.each(["refunding", "refund_pending"] as const)("on a %s lot proceeds when the succeeded sum covers the payment and matches", (lifecycle) => {
    expect(
      assessOneShot(
        oneShot("settle", lifecycle, {
          refunds: [refund("re_a", "succeeded", 600), refund("re_b", "succeeded", 400, { operationId: null })],
          confirmedSucceededCents: PAID,
          acceptPartial: false,
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("proceeds short of the payment when acceptPartial is set", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_a", "succeeded", 500), refund("re_f", "failed", 500, { everSucceeded: true })],
          confirmedSucceededCents: 500,
          acceptPartial: true,
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("a pending refund is refund_in_progress, before the sums are compared", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_a", "succeeded", 500), refund("re_p", "pending", 500)],
          confirmedSucceededCents: 1,
          acceptPartial: false,
        }),
      ),
    ).toEqual(stripeBlocks("refund_in_progress"));
  });

  it("a confirmed sum that differs from Stripe's is succeeded_sum_changed, before nothing_refunded", () => {
    expect(
      assessOneShot(oneShot("settle", "refunding", { refunds: [], confirmedSucceededCents: 1, acceptPartial: true })),
    ).toEqual(stripeBlocks("succeeded_sum_changed"));
  });

  it("nothing succeeded is nothing_refunded even with acceptPartial", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_f", "failed", PAID, { everSucceeded: true })],
          confirmedSucceededCents: 0,
          acceptPartial: true,
        }),
      ),
    ).toEqual(stripeBlocks("nothing_refunded"));
  });

  it("short of the payment without acceptPartial is partial_not_accepted", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_a", "succeeded", PAID - 1)],
          confirmedSucceededCents: PAID - 1,
          acceptPartial: false,
        }),
      ),
    ).toEqual(stripeBlocks("partial_not_accepted"));
  });
});

describe("assessOneShot: send_back", () => {
  it("proceeds when nothing succeeded, including after a failed refund", () => {
    expect(
      assessOneShot(oneShot("send_back", "refunding", { refunds: [refund("re_f", "failed", PAID, { everSucceeded: true })] })),
    ).toEqual(PROCEED);
  });

  it("a requires_action refund is refund_in_progress", () => {
    expect(assessOneShot(oneShot("send_back", "refunding", { refunds: [refund("re_p", "requires_action", 5)] }))).toEqual(
      stripeBlocks("refund_in_progress"),
    );
  });

  it("a succeeded refund is refund_succeeded", () => {
    expect(assessOneShot(oneShot("send_back", "refunding", { refunds: [refund("re_ok", "succeeded", 10)] }))).toEqual(
      stripeBlocks("refund_succeeded"),
    );
  });
});

describe("assessOneShot: resolve_outside on a refunded lot (unchanged)", () => {
  const failedLater = refund("re_later", "failed", PAID, { everSucceeded: true });

  it("proceeds when the named ids are exactly the unresolved failed refunds", () => {
    expect(
      assessOneShot(
        oneShot("resolve_outside", "refunded", {
          refunds: [failedLater],
          failedRefundIds: ["re_later"],
          confirmedSucceededCents: 0,
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("nothing unresolved is lot_state_changed", () => {
    expect(
      assessOneShot(
        oneShot("resolve_outside", "refunded", {
          refunds: [
            refund("re_never", "failed", 5, { everSucceeded: false }),
            refund("re_done", "failed", 5, { everSucceeded: true, resolvedByOperationId: RESOLVER }),
          ],
          failedRefundIds: [],
        }),
      ),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("other ids are failed_refunds_changed, judged before a pending refund", () => {
    expect(
      assessOneShot(
        oneShot("resolve_outside", "refunded", {
          refunds: [failedLater, refund("re_p", "pending", 5)],
          failedRefundIds: ["re_other"],
        }),
      ),
    ).toEqual(stripeBlocks("failed_refunds_changed"));
  });

  it("a pending refund is refund_in_progress", () => {
    expect(
      assessOneShot(
        oneShot("resolve_outside", "refunded", {
          refunds: [failedLater, refund("re_p", "pending", 5)],
          failedRefundIds: ["re_later"],
          confirmedSucceededCents: 0,
        }),
      ),
    ).toEqual(stripeBlocks("refund_in_progress"));
  });
});

describe("assessOneShot: resolve_outside on a lot not yet booked (§5.3, refund_pending and refunding)", () => {
  for (const lifecycle of ["refund_pending", "refunding"] as const) {
    it(`${lifecycle} with nothing on Stripe proceeds with an empty list`, () => {
      expect(
        assessOneShot(oneShot("resolve_outside", lifecycle, { failedRefundIds: [], confirmedSucceededCents: 0 })),
      ).toEqual(PROCEED);
    });

    it(`${lifecycle} proceeds when the named ids are every unanswered failed or canceled refund, succeeded once or not`, () => {
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, {
            refunds: [
              refund("re_own", "failed", PAID, { everSucceeded: true }),
              refund("re_never", "failed", 200, { everSucceeded: false }),
              refund("re_c", "canceled", 50, { operationId: null }),
              refund("re_done", "failed", 70, { resolvedByOperationId: RESOLVER }),
            ],
            failedRefundIds: ["re_c", "re_own", "re_never"],
            confirmedSucceededCents: 0,
          }),
        ),
      ).toEqual(PROCEED);
    });

    it(`${lifecycle} proceeds beside a succeeded partial refund`, () => {
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, {
            refunds: [refund("re_ok", "succeeded", 400), refund("re_f", "failed", 600, { everSucceeded: true })],
            failedRefundIds: ["re_f"],
            confirmedSucceededCents: 400,
          }),
        ),
      ).toEqual(PROCEED);
    });

    it(`${lifecycle} with a failed refund left out of the request is failed_refunds_changed`, () => {
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, {
            refunds: [refund("re_f", "failed", 600, { everSucceeded: false })],
            failedRefundIds: [],
          }),
        ),
      ).toEqual(stripeBlocks("failed_refunds_changed"));
    });

    it(`${lifecycle} naming a refund that is not failed is failed_refunds_changed`, () => {
      expect(
        assessOneShot(oneShot("resolve_outside", lifecycle, { failedRefundIds: ["re_ghost"] })),
      ).toEqual(stripeBlocks("failed_refunds_changed"));
    });

    it(`${lifecycle} with a refund still processing is refund_in_progress`, () => {
      expect(
        assessOneShot(oneShot("resolve_outside", lifecycle, { refunds: [refund("re_p", "pending", 5)], failedRefundIds: [] })),
      ).toEqual(stripeBlocks("refund_in_progress"));
    });
  }
});

describe("assessOneShot: resolve_outside checks the succeeded sum the operator confirmed (v6 §5.3, finding [8])", () => {
  const failedLater = refund("re_later", "failed", 300, { everSucceeded: true });

  for (const lifecycle of ["refunded", "refunding", "refund_pending"] as const) {
    it(`${lifecycle}: a succeeded refund that landed after the confirmation is succeeded_sum_changed; the confirmed sum proceeds`, () => {
      const base = {
        refunds: [failedLater, refund("re_late", "succeeded", 200, { operationId: null })],
        failedRefundIds: ["re_later"],
      };
      expect(assessOneShot(oneShot("resolve_outside", lifecycle, { ...base, confirmedSucceededCents: 0 }))).toEqual(
        stripeBlocks("succeeded_sum_changed"),
      );
      expect(assessOneShot(oneShot("resolve_outside", lifecycle, { ...base, confirmedSucceededCents: 200 }))).toEqual(
        PROCEED,
      );
    });

    it(`${lifecycle}: a confirmed sum higher than Stripe's is succeeded_sum_changed`, () => {
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, {
            refunds: [failedLater],
            failedRefundIds: ["re_later"],
            confirmedSucceededCents: 300,
          }),
        ),
      ).toEqual(stripeBlocks("succeeded_sum_changed"));
    });

    it(`${lifecycle}: is judged after refund_in_progress and after failed_refunds_changed`, () => {
      const refunds = [failedLater, refund("re_late", "succeeded", 200), refund("re_p", "pending", 5)];
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, { refunds, failedRefundIds: ["re_later"], confirmedSucceededCents: 0 }),
        ),
      ).toEqual(stripeBlocks("refund_in_progress"));
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, { refunds, failedRefundIds: ["re_other"], confirmedSucceededCents: 0 }),
        ),
      ).toEqual(stripeBlocks("failed_refunds_changed"));
      expect(
        assessOneShot(
          oneShot("resolve_outside", lifecycle, {
            refunds: refunds.slice(0, 2),
            failedRefundIds: ["re_later"],
            confirmedSucceededCents: 0,
          }),
        ),
      ).toEqual(stripeBlocks("succeeded_sum_changed"));
    });
  }
});

// ── §9: every needs_attention has an exit ─────────────────────────────

type Exit = "settle" | "send_back" | "retry" | "resolve_outside" | "refund_again";

/** The lot and Stripe state a disposition leaves when it turns needs_attention. */
interface AttentionState {
  reason: AttentionReason;
  /** Which disposition kind turned needs_attention. */
  from: "approve" | "refund_again";
  lifecycle: CreditLotLifecycle;
  refunds: RefundCopy[];
}

/**
 * The exits that pass the production judges in this state, judged with what
 * the confirmation page would send back for it.
 * @param state - The lot's state, its refunds, and the open attention.
 * @param state.lifecycle - The lot's state.
 * @param state.refunds - The payment's refund copies.
 * @param state.ops - The lot's dispositions.
 * @returns The exits that pass.
 */
function passingExits(state: {
  lifecycle: CreditLotLifecycle;
  refunds: readonly RefundCopy[];
  ops: readonly AssessOperation[];
}): Exit[] {
  const { lifecycle, refunds, ops } = state;
  const remainingCredits = lifecycle === "refunded" ? 0 : 100;
  const succeeded = refunds.filter((r) => r.status === "succeeded");
  const succeededCents = succeeded.reduce((sum, r) => sum + r.amountCents, 0);
  const unresolvedIds = pickUnresolvedFailedRefunds(lifecycle, refunds).map((r) => r.stripeRefundId);
  const oneShotPasses = (kind: OneShotInput["kind"]) =>
    assessOneShot({
      kind,
      lot: { lifecycle, remainingCredits },
      paidCents: PAID,
      ops,
      refunds,
      confirmedSucceededCents: succeededCents,
      acceptPartial: true,
      failedRefundIds: unresolvedIds,
    }).outcome === "proceed";
  const createPasses = (kind: "retry" | "refund_again") =>
    assessRefundCreate({
      kind,
      lot: { lifecycle, remainingCredits, ledgerSum: remainingCredits },
      payment: { status: "completed", stripePaymentIntentId: "pi_1", paidCents: PAID },
      ops,
      refunds,
      confirmedRefundIds: succeeded.filter((r) => r.operationId === null).map((r) => r.stripeRefundId),
      failedRefundIds: unresolvedIds,
    }).outcome === "create_refund";
  const exits: Exit[] =
    lifecycle === "refunded" ? ["refund_again", "resolve_outside"] : ["settle", "send_back", "retry", "resolve_outside"];
  return exits.filter((e) =>
    e === "retry" || e === "refund_again" ? createPasses(e) : oneShotPasses(e),
  );
}

/**
 * Whether refund_again's amount — the unresolved failed refunds' sum — fits
 * what Stripe will still refund: paid − succeeded − failed (v6 §5.2, §9).
 * @param lifecycle - The lot's state.
 * @param refunds - The payment's refund copies.
 * @returns True when Stripe could take it.
 */
function refundAgainFits(lifecycle: CreditLotLifecycle, refunds: readonly RefundCopy[]): boolean {
  const sum = (f: (r: RefundCopy) => boolean) => refunds.filter(f).reduce((n, r) => n + r.amountCents, 0);
  const amount = pickUnresolvedFailedRefunds(lifecycle, refunds).reduce((n, r) => n + r.amountCents, 0);
  return amount <= PAID - sum((r) => r.status === "succeeded") - sum((r) => r.status === "failed");
}

const originalFailed = refund("re_original", "failed", PAID, { everSucceeded: true });

/** One state per reason code (two where both kinds can reach it), as §5.4 and §6.2 leave it. */
const ATTENTION_STATES: AttentionState[] = [
  { reason: "partial_refund", from: "approve", lifecycle: "refunding", refunds: [refund("re_own", "succeeded", 600)] },
  {
    reason: "unexpected_external_refund",
    from: "approve",
    lifecycle: "refunding",
    refunds: [refund("re_own", "succeeded", 700), refund("re_ext", "succeeded", 300, { operationId: null })],
  },
  {
    reason: "stripe_refund_failed_later",
    from: "approve",
    lifecycle: "refunding",
    refunds: [refund("re_own", "failed", PAID, { everSucceeded: true })],
  },
  {
    reason: "stripe_refund_failed_later",
    from: "approve",
    lifecycle: "refunding",
    refunds: [
      refund("re_ext", "succeeded", 400, { operationId: null }),
      refund("re_own", "failed", 600, { everSucceeded: true }),
    ],
  },
  {
    reason: "stripe_refund_failed_later",
    from: "refund_again",
    lifecycle: "refunded",
    refunds: [originalFailed, refund("re_again", "failed", PAID, { everSucceeded: false })],
  },
  { reason: "attempts_exhausted", from: "approve", lifecycle: "refunding", refunds: [] },
  { reason: "attempts_exhausted", from: "refund_again", lifecycle: "refunded", refunds: [originalFailed] },
  { reason: "stripe_result_unknown", from: "approve", lifecycle: "refunding", refunds: [] },
  { reason: "stripe_result_unknown", from: "refund_again", lifecycle: "refunded", refunds: [originalFailed] },
  {
    reason: "already_refunded_elsewhere",
    from: "approve",
    lifecycle: "refunding",
    refunds: [refund("re_ext", "succeeded", PAID, { operationId: null })],
  },
  { reason: "already_refunded_elsewhere", from: "refund_again", lifecycle: "refunded", refunds: [originalFailed] },
  { reason: "stripe_declined", from: "refund_again", lifecycle: "refunded", refunds: [originalFailed] },
  {
    // Only a hand edit leaves this (§6.1): the approval's refund succeeded
    // while somebody had put the lot back to refund_pending.
    reason: "state_mismatch",
    from: "approve",
    lifecycle: "refund_pending",
    refunds: [refund("re_own", "succeeded", PAID)],
  },
];

describe("§9: every needs_attention has an exit the production judges accept", () => {
  it("the table covers every reason code", () => {
    const every: AttentionReason[] = [
      "partial_refund",
      "unexpected_external_refund",
      "stripe_refund_failed_later",
      "attempts_exhausted",
      "stripe_result_unknown",
      "already_refunded_elsewhere",
      "stripe_declined",
      "state_mismatch",
    ];
    expect([...new Set(ATTENTION_STATES.map((s) => s.reason))].sort()).toEqual([...every].sort());
  });

  it.each(ATTENTION_STATES)("$reason after $from on a $lifecycle lot has an exit", (state) => {
    const ops = [op("needs_attention", 5)];
    const passing = passingExits({ lifecycle: state.lifecycle, refunds: state.refunds, ops });
    expect(passing.length).toBeGreaterThan(0);
    if (state.lifecycle === "refunded") {
      // With an unresolved failed refund and nothing processing,
      // resolve_outside always; refund_again only when Stripe could take it.
      expect(passing).toEqual(
        refundAgainFits(state.lifecycle, state.refunds) ? ["refund_again", "resolve_outside"] : ["resolve_outside"],
      );
    } else {
      // Nothing processing: resolve_outside always passes on a lot not yet booked.
      expect(passing).toContain("resolve_outside");
    }
  });

  it("a refunding lot whose refund failed has no retry: Stripe would refuse it (refund_failed)", () => {
    const state = ATTENTION_STATES.find((s) => s.reason === "stripe_refund_failed_later" && s.lifecycle === "refunding")!;
    expect(passingExits({ lifecycle: "refunding", refunds: state.refunds, ops: [op("needs_attention", 5)] })).toEqual([
      "send_back",
      "resolve_outside",
    ]);
  });
});

// ── §9 properties ─────────────────────────────────────────────────────

const statusArb = fc.constantFrom<StripeRefundStatus>("succeeded", "failed", "canceled");
const copiesArb = fc
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
const settledOpsArb = fc.array(
  fc.record({
    status: fc.constantFrom<AssessOperation["status"]>("succeeded", "needs_attention"),
    minute: fc.integer({ min: 0, max: 58 }),
    closed: fc.boolean(),
  }),
  { maxLength: 4 },
);

describe("§9 properties over the production judges", () => {
  it("a refunded lot with an unresolved failed refund, nothing processing and nothing in flight passes resolve_outside, and refund_again exactly when its amount fits", () => {
    fc.assert(
      fc.property(
        copiesArb,
        fc.integer({ min: 1, max: PAID }),
        fc.constantFrom<StripeRefundStatus>("failed", "canceled"),
        settledOpsArb,
        (others, amount, status, rawOps) => {
          const refunds = [...others, refund("re_unresolved", status, amount, { everSucceeded: true })];
          const ops = rawOps.map((o) => op(o.status, o.minute, o.closed));
          expect(passingExits({ lifecycle: "refunded", refunds, ops })).toEqual(
            refundAgainFits("refunded", refunds) ? ["refund_again", "resolve_outside"] : ["resolve_outside"],
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a refunding or refund_pending lot with nothing processing and nothing in flight always passes resolve_outside", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CreditLotLifecycle>("refunding", "refund_pending"),
        copiesArb,
        settledOpsArb,
        (lifecycle, refunds, rawOps) => {
          const unresolvedIds = pickUnresolvedFailedRefunds(lifecycle, refunds).map((r) => r.stripeRefundId);
          const succeededCents = refunds.filter((r) => r.status === "succeeded").reduce((n, r) => n + r.amountCents, 0);
          expect(
            assessOneShot({
              kind: "resolve_outside",
              lot: { lifecycle, remainingCredits: 100 },
              paidCents: PAID,
              ops: rawOps.map((o) => op(o.status, o.minute, o.closed)),
              refunds,
              failedRefundIds: unresolvedIds,
              confirmedSucceededCents: succeededCents,
            }),
          ).toEqual(PROCEED);
        },
      ),
      { numRuns: 300 },
    );
  });
});
