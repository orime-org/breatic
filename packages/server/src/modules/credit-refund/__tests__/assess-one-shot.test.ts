// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement of the five dispositions that finish in their request —
 * reject, settle, send_back, resolve_outside, restore_credits (inner#1410 v9
 * §5.3) — and the §9 invariants that say a person is never left without a
 * way out.
 *
 * Each row's conditions are judged lot column first, then Stripe column,
 * each left to right; the first that fails answers its code, and an unnamed
 * lot-column failure is lot_state_changed (§5.3, decision 4):
 *
 * - reject: refund_pending with credits left; nothing in flight; no
 *   succeeded / pending / requires_action refund (refund_in_progress,
 *   refund_succeeded); no unresolved failed refund (refund_failed).
 * - settle: refunding or refund_pending; nothing in flight; nothing
 *   processing; succeeded sum = confirmedSucceededCents
 *   (succeeded_sum_changed) and ≥ paid (succeeded_below_paid). acceptPartial
 *   is gone.
 * - send_back: refunding; nothing in flight; the lot never had a disposition
 *   with attention_reason stripe_declined (stripe_declined); nothing
 *   processing; nothing succeeded.
 * - resolve_outside: refunded, refunding or refund_pending; nothing in
 *   flight; refunded needs an unresolved failed refund; failedRefundIds
 *   exactly the unresolved ones; nothing processing; succeeded sum =
 *   confirmed.
 * - restore_credits (design 3535a275): nothing in flight
 *   (operation_in_progress); never a resolve_outside on the lot
 *   (paid_outside); refunded and refund_pending need an unresolved failed
 *   refund, refunding needs the latest disposition to be an open
 *   needs_attention, any other lifecycle is refused (lot_state_changed);
 *   then the charge not disputed (disputed);
 *   failedRefundIds exactly the unresolved ones (failed_refunds_changed);
 *   nothing processing (refund_in_progress); nothing succeeded
 *   (refund_succeeded).
 *
 * The unresolved failed refunds are an input (the product reads them from
 * the view `credit_refunds_unresolved_failed`); this suite builds them with
 * the view's definition as its oracle.
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
import { unresolvedOf } from "./unresolved-oracle.js";

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
    pendingReason: status === "pending" ? "processing" : null,
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
 * @param extra - Result, reason or closing.
 * @returns The disposition.
 */
function op(status: AssessOperation["status"], minute = 1, extra: Partial<AssessOperation> = {}): AssessOperation {
  return {
    status,
    attentionClosedAt: null,
    createdAt: at(minute),
    result: null,
    attentionReason: status === "needs_attention" ? "attempts_exhausted" : null,
    ...extra,
  };
}

/** An open needs_attention for the given reason. */
const attention = (attentionReason: AttentionReason, minute = 5): AssessOperation =>
  op("needs_attention", minute, { attentionReason });

/**
 * A one-shot request on a lot in `lifecycle` that passes every row unless
 * the case overrides something. The unresolved list follows the refunds.
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
  const refunds = extra.refunds ?? [];
  return {
    kind,
    lot: { lifecycle, remainingCredits: lifecycle === "refunded" ? 0 : 100 },
    paidCents: PAID,
    ops: [],
    refunds,
    unresolvedFailedRefunds: unresolvedOf(lifecycle, refunds),
    disputed: false,
    ...extra,
  };
}

const PROCEED = { outcome: "proceed" };
const LOT_STATE_CHANGED = { outcome: "blocked", code: "lot_state_changed" };
const IN_PROGRESS = { outcome: "blocked", code: "operation_in_progress" };
const stripeBlocks = (reason: string) => ({ outcome: "blocked", code: "stripe_blocks", reason });

const ALL_LIFECYCLES: CreditLotLifecycle[] = ["active", "depleted", "refund_pending", "refunding", "refunded"];

describe("assessOneShot: the lot's state", () => {
  const allowed: Record<Exclude<OneShotInput["kind"], "restore_credits">, CreditLotLifecycle[]> = {
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

describe("assessOneShot: a disposition in flight", () => {
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
            ops: [attention("stripe_declined", 1), op(status, 2)],
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

  it("proceeds when the only failed refund has been answered for", () => {
    expect(
      assessOneShot(
        oneShot("reject", "refund_pending", {
          refunds: [refund("re_done", "failed", 400, { resolvedByOperationId: RESOLVER })],
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("an unresolved failed refund is refund_failed: the buyer is owed an answer, not a refusal", () => {
    expect(
      assessOneShot(oneShot("reject", "refund_pending", { refunds: [refund("re_f", "failed", 400)] })),
    ).toEqual(stripeBlocks("refund_failed"));
  });

  it("an unresolved canceled refund is refund_failed as well", () => {
    expect(
      assessOneShot(
        oneShot("reject", "refund_pending", { refunds: [refund("re_c", "canceled", 100, { operationId: null })] }),
      ),
    ).toEqual(stripeBlocks("refund_failed"));
  });

  it.each(["pending", "requires_action"] as const)(
    "a %s refund is refund_in_progress, before a succeeded or a failed one",
    (status) => {
      expect(
        assessOneShot(
          oneShot("reject", "refund_pending", {
            refunds: [refund("re_ok", "succeeded", 300), refund("re_f", "failed", 100), refund("re_p", status, 5)],
          }),
        ),
      ).toEqual(stripeBlocks("refund_in_progress"));
    },
  );

  it("a succeeded refund is refund_succeeded, before an unresolved failed one", () => {
    expect(
      assessOneShot(
        oneShot("reject", "refund_pending", {
          refunds: [refund("re_ok", "succeeded", 1, { operationId: null }), refund("re_f", "failed", 100)],
        }),
      ),
    ).toEqual(stripeBlocks("refund_succeeded"));
  });
});

describe("assessOneShot: settle", () => {
  it.each(["refunding", "refund_pending"] as const)(
    "on a %s lot proceeds when the succeeded sum covers the payment and matches",
    (lifecycle) => {
      expect(
        assessOneShot(
          oneShot("settle", lifecycle, {
            refunds: [refund("re_a", "succeeded", 600), refund("re_b", "succeeded", 400, { operationId: null })],
            confirmedSucceededCents: PAID,
          }),
        ),
      ).toEqual(PROCEED);
    },
  );

  it("proceeds when the succeeded sum exceeds the payment", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", { refunds: [refund("re_a", "succeeded", PAID + 5)], confirmedSucceededCents: PAID + 5 }),
      ),
    ).toEqual(PROCEED);
  });

  it("a pending refund is refund_in_progress, before the sums are compared", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_a", "succeeded", 500), refund("re_p", "pending", 500)],
          confirmedSucceededCents: 1,
        }),
      ),
    ).toEqual(stripeBlocks("refund_in_progress"));
  });

  it("a confirmed sum that differs from Stripe's is succeeded_sum_changed, before succeeded_below_paid", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", { refunds: [refund("re_a", "succeeded", 300)], confirmedSucceededCents: 200 }),
      ),
    ).toEqual(stripeBlocks("succeeded_sum_changed"));
  });

  it("short of the payment is succeeded_below_paid: only a whole refund is booked", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_a", "succeeded", PAID - 1)],
          confirmedSucceededCents: PAID - 1,
        }),
      ),
    ).toEqual(stripeBlocks("succeeded_below_paid"));
  });

  it("nothing succeeded is succeeded_below_paid (nothing_refunded is gone)", () => {
    expect(
      assessOneShot(
        oneShot("settle", "refunding", {
          refunds: [refund("re_f", "failed", PAID, { everSucceeded: true })],
          confirmedSucceededCents: 0,
        }),
      ),
    ).toEqual(stripeBlocks("succeeded_below_paid"));
  });

  it("an acceptPartial carried along changes nothing: the partial booking is gone", () => {
    const input = {
      ...oneShot("settle", "refunding", {
        refunds: [refund("re_a", "succeeded", 500)],
        confirmedSucceededCents: 500,
      }),
      acceptPartial: true,
    } as OneShotInput;
    expect(assessOneShot(input)).toEqual(stripeBlocks("succeeded_below_paid"));
  });
});

describe("assessOneShot: send_back", () => {
  it("proceeds when nothing succeeded, including after a refund that failed later", () => {
    expect(
      assessOneShot(
        oneShot("send_back", "refunding", {
          ops: [attention("stripe_refund_failed_later")],
          refunds: [refund("re_f", "failed", PAID, { everSucceeded: true })],
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("a lot Stripe once declined is stripe_declined, before a processing or succeeded refund", () => {
    expect(
      assessOneShot(
        oneShot("send_back", "refunding", {
          ops: [attention("stripe_declined")],
          refunds: [refund("re_ok", "succeeded", 10), refund("re_p", "requires_action", 5)],
        }),
      ),
    ).toEqual(stripeBlocks("stripe_declined"));
  });

  it("stays stripe_declined after a retry that ended in another needs_attention", () => {
    // The declined approval was closed by the retry; the retry ran out of
    // attempts. The history still says Stripe refused this lot.
    expect(
      assessOneShot(
        oneShot("send_back", "refunding", {
          ops: [
            op("needs_attention", 1, { attentionReason: "stripe_declined", attentionClosedAt: at(2) }),
            attention("attempts_exhausted", 2),
          ],
        }),
      ),
    ).toEqual(stripeBlocks("stripe_declined"));
  });

  it("stays stripe_declined whatever order the history comes in", () => {
    expect(
      assessOneShot(
        oneShot("send_back", "refunding", {
          ops: [
            attention("stripe_result_unknown", 7),
            op("needs_attention", 3, { attentionReason: "stripe_declined", attentionClosedAt: at(7) }),
          ],
        }),
      ),
    ).toEqual(stripeBlocks("stripe_declined"));
  });

  it("is allowed after stripe_request_invalid: our configuration was wrong, Stripe refused nothing", () => {
    expect(
      assessOneShot(oneShot("send_back", "refunding", { ops: [attention("stripe_request_invalid")] })),
    ).toEqual(PROCEED);
  });

  it("a requires_action refund is refund_in_progress", () => {
    expect(
      assessOneShot(oneShot("send_back", "refunding", { refunds: [refund("re_p", "requires_action", 5)] })),
    ).toEqual(stripeBlocks("refund_in_progress"));
  });

  it("a succeeded refund is refund_succeeded", () => {
    expect(
      assessOneShot(oneShot("send_back", "refunding", { refunds: [refund("re_ok", "succeeded", 10)] })),
    ).toEqual(stripeBlocks("refund_succeeded"));
  });
});

describe("assessOneShot: resolve_outside on a refunded lot", () => {
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

  it("judges the unresolved list it is given, not the copies", () => {
    // The view is the one definition; the judge must not re-derive it.
    expect(
      assessOneShot({
        ...oneShot("resolve_outside", "refunded", { refunds: [failedLater], failedRefundIds: ["re_later"] }),
        unresolvedFailedRefunds: [],
      }),
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

describe("assessOneShot: resolve_outside on a lot not yet booked (refund_pending and refunding)", () => {
  for (const lifecycle of ["refund_pending", "refunding"] as const) {
    it(`${lifecycle} with nothing on Stripe proceeds with an empty list`, () => {
      expect(
        assessOneShot(oneShot("resolve_outside", lifecycle, { failedRefundIds: [], confirmedSucceededCents: 0 })),
      ).toEqual(PROCEED);
    });

    it(`${lifecycle} proceeds when the named ids are every unanswered failed or canceled refund`, () => {
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

    it(`${lifecycle}: a succeeded refund that landed after the confirmation is succeeded_sum_changed`, () => {
      const base = {
        refunds: [refund("re_f", "failed", 300), refund("re_late", "succeeded", 200, { operationId: null })],
        failedRefundIds: ["re_f"],
      };
      expect(assessOneShot(oneShot("resolve_outside", lifecycle, { ...base, confirmedSucceededCents: 0 }))).toEqual(
        stripeBlocks("succeeded_sum_changed"),
      );
      expect(assessOneShot(oneShot("resolve_outside", lifecycle, { ...base, confirmedSucceededCents: 200 }))).toEqual(
        PROCEED,
      );
    });
  }
});

describe("assessOneShot: restore_credits, each condition in the decided order", () => {
  const failedLater = refund("re_later", "failed", PAID, { everSucceeded: true });
  const declined = refund("re_own", "failed", PAID, { everSucceeded: false });
  /** A booked lot whose refund failed later: every condition holds. */
  const REFUNDED_OK = oneShot("restore_credits", "refunded", {
    ops: [op("succeeded", 1, { result: "refunded" })],
    refunds: [failedLater],
    failedRefundIds: ["re_later"],
  });
  /** Everything after the lot column fails at once. */
  const stripeColumnTrips = {
    disputed: true,
    failedRefundIds: ["re_other"],
  };

  it("proceeds on a refunded lot with an unresolved failed refund", () => {
    expect(assessOneShot(REFUNDED_OK)).toEqual(PROCEED);
  });

  it("proceeds on a refund_pending lot with an unresolved failed refund (approval declined, sent back)", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refund_pending", {
          ops: [
            op("needs_attention", 1, { attentionReason: "stripe_refund_failed_later", attentionClosedAt: at(2) }),
            op("succeeded", 2, { result: "sent_back" }),
          ],
          refunds: [failedLater],
          failedRefundIds: ["re_later"],
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("proceeds on a refunding lot whose latest disposition is an open needs_attention, with both lists empty", () => {
    expect(
      assessOneShot(oneShot("restore_credits", "refunding", { ops: [attention("stripe_declined")], failedRefundIds: [] })),
    ).toEqual(PROCEED);
  });

  it("proceeds on a refunding lot naming its unresolved failed refund", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunding", {
          ops: [attention("stripe_declined")],
          refunds: [declined],
          failedRefundIds: ["re_own"],
        }),
      ),
    ).toEqual(PROCEED);
  });

  it("1. a disposition in flight is operation_in_progress, before paid_outside and the lot's state", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunded", {
          ops: [op("succeeded", 1, { result: "resolved_outside" }), op("awaiting_stripe", 2)],
          refunds: [refund("re_ok", "succeeded", PAID)],
          ...stripeColumnTrips,
        }),
      ),
    ).toEqual(IN_PROGRESS);
  });

  it("2. resolve_outside then restore on a refunded lot answers paid_outside, though nothing is left unresolved", () => {
    // The resolve_outside answered for the only failed refund; the lot check
    // alone would say lot_state_changed (design 3535a275).
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunded", {
          ops: [op("succeeded", 1, { result: "refunded" }), op("succeeded", 2, { result: "resolved_outside" })],
          refunds: [refund("re_later", "failed", PAID, { everSucceeded: true, resolvedByOperationId: RESOLVER })],
          failedRefundIds: [],
        }),
      ),
    ).toEqual(stripeBlocks("paid_outside"));
  });

  it("2. a resolve_outside in the lot's history is paid_outside, before disputed and the rest of the Stripe column", () => {
    expect(
      assessOneShot({
        ...REFUNDED_OK,
        ops: [op("succeeded", 1, { result: "refunded" }), op("succeeded", 2, { result: "resolved_outside" })],
        refunds: [...REFUNDED_OK.refunds, refund("re_ok", "succeeded", 300), refund("re_p", "pending", 5)],
        ...stripeColumnTrips,
      }),
    ).toEqual(stripeBlocks("paid_outside"));
  });

  it.each(["active", "depleted"] as const)("2. paid_outside is answered before the lot's state, even on a %s lot", (lifecycle) => {
    expect(
      assessOneShot(
        oneShot("restore_credits", lifecycle, {
          ops: [op("succeeded", 1, { result: "resolved_outside" })],
          ...stripeColumnTrips,
        }),
      ),
    ).toEqual(stripeBlocks("paid_outside"));
  });

  it.each(["active", "depleted"] as const)("3. a %s lot is lot_state_changed, before the Stripe column", (lifecycle) => {
    expect(
      assessOneShot(
        oneShot("restore_credits", lifecycle, {
          ops: [op("succeeded", 1, { result: "rejected" })],
          refunds: [refund("re_ok", "succeeded", 300), refund("re_p", "pending", 5)],
          ...stripeColumnTrips,
        }),
      ),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it.each(["refunded", "refund_pending"] as const)(
    "3. a %s lot with no unresolved failed refund is lot_state_changed, before the Stripe column",
    (lifecycle) => {
      expect(
        assessOneShot(
          oneShot("restore_credits", lifecycle, {
            ops: [op("succeeded", 1, { result: lifecycle === "refunded" ? "refunded" : "sent_back" })],
            refunds: [
              refund("re_done", "failed", 300, { everSucceeded: true, resolvedByOperationId: RESOLVER }),
              refund("re_ok", "succeeded", 700),
              refund("re_p", "pending", 5),
            ],
            ...stripeColumnTrips,
          }),
        ),
      ).toEqual(LOT_STATE_CHANGED);
    },
  );

  it("3. a refunded lot whose only failed refund failed before booking (never succeeded) is lot_state_changed", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunded", {
          ops: [op("succeeded", 1, { result: "refunded" })],
          refunds: [refund("re_early", "failed", 100, { everSucceeded: false })],
          failedRefundIds: [],
        }),
      ),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("3. a refunding lot whose latest needs_attention was closed is lot_state_changed", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunding", {
          ops: [op("needs_attention", 5, { attentionReason: "stripe_declined", attentionClosedAt: at(6) })],
          ...stripeColumnTrips,
        }),
      ),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("3. a refunding lot whose latest disposition is not a needs_attention is lot_state_changed", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunding", {
          ops: [attention("stripe_declined", 1), op("succeeded", 3, { result: "rejected" })],
          ...stripeColumnTrips,
        }),
      ),
    ).toEqual(LOT_STATE_CHANGED);
  });

  it("4. a disputed charge is disputed, before failed_refunds_changed", () => {
    expect(
      assessOneShot({
        ...REFUNDED_OK,
        refunds: [...REFUNDED_OK.refunds, refund("re_ok", "succeeded", 300), refund("re_p", "pending", 5)],
        ...stripeColumnTrips,
      }),
    ).toEqual(stripeBlocks("disputed"));
  });

  it("5. named ids that are not exactly the unresolved ones are failed_refunds_changed, before refund_in_progress", () => {
    for (const failedRefundIds of [[], ["re_other"], ["re_later", "re_other"]]) {
      expect(
        assessOneShot({
          ...REFUNDED_OK,
          refunds: [...REFUNDED_OK.refunds, refund("re_ok", "succeeded", 300), refund("re_p", "pending", 5)],
          failedRefundIds,
        }),
      ).toEqual(stripeBlocks("failed_refunds_changed"));
    }
  });

  it("5. a refunding lot that names nothing while a failed refund is unresolved is failed_refunds_changed", () => {
    expect(
      assessOneShot(
        oneShot("restore_credits", "refunding", {
          ops: [attention("stripe_declined")],
          refunds: [declined],
          failedRefundIds: [],
        }),
      ),
    ).toEqual(stripeBlocks("failed_refunds_changed"));
  });

  it.each(["pending", "requires_action"] as const)(
    "6. a %s refund is refund_in_progress, before refund_succeeded",
    (status) => {
      expect(
        assessOneShot({
          ...REFUNDED_OK,
          refunds: [...REFUNDED_OK.refunds, refund("re_ok", "succeeded", 300), refund("re_p", status, 5)],
        }),
      ).toEqual(stripeBlocks("refund_in_progress"));
    },
  );

  it("7. a succeeded refund is refund_succeeded: the money reached the buyer", () => {
    expect(
      assessOneShot({
        ...REFUNDED_OK,
        refunds: [...REFUNDED_OK.refunds, refund("re_ok", "succeeded", 1, { operationId: null })],
      }),
    ).toEqual(stripeBlocks("refund_succeeded"));
  });

  it("a canceled refund does not count as succeeded", () => {
    expect(
      assessOneShot({
        ...REFUNDED_OK,
        refunds: [...REFUNDED_OK.refunds, refund("re_c", "canceled", 300, { resolvedByOperationId: RESOLVER })],
      }),
    ).toEqual(PROCEED);
  });
});

// ── §9: every needs_attention has an exit ─────────────────────────────

type Exit = "settle" | "send_back" | "retry" | "resolve_outside" | "restore_credits";

/** The lot and Stripe state a disposition leaves when it turns needs_attention. */
interface AttentionState {
  reason: AttentionReason;
  /** Why this state is a separate case. */
  note: string;
  lifecycle: CreditLotLifecycle;
  refunds: RefundCopy[];
  disputed?: boolean;
  /** The exits that pass, in the order they are listed. */
  exits: Exit[];
}

/**
 * The exits that pass the production judges in this state, judged with what
 * the confirmation page would send back for it.
 * @param state - The lot's state, its refunds, and the dispositions.
 * @param state.lifecycle - The lot's state.
 * @param state.refunds - The payment's refund copies.
 * @param state.ops - The lot's dispositions.
 * @param state.disputed - Whether the charge is disputed.
 * @returns The exits that pass.
 */
function passingExits(state: {
  lifecycle: CreditLotLifecycle;
  refunds: readonly RefundCopy[];
  ops: readonly AssessOperation[];
  disputed: boolean;
}): Exit[] {
  const { lifecycle, refunds, ops, disputed } = state;
  const remainingCredits = lifecycle === "refunded" ? 0 : 100;
  const succeeded = refunds.filter((r) => r.status === "succeeded");
  const succeededCents = succeeded.reduce((sum, r) => sum + r.amountCents, 0);
  const unresolved = unresolvedOf(lifecycle, refunds);
  const oneShotPasses = (kind: Exclude<Exit, "retry">) =>
    assessOneShot({
      kind,
      lot: { lifecycle, remainingCredits },
      paidCents: PAID,
      ops,
      refunds,
      unresolvedFailedRefunds: unresolved,
      disputed,
      confirmedSucceededCents: succeededCents,
      failedRefundIds: unresolved.map((r) => r.stripeRefundId),
    }).outcome === "proceed";
  const retryPasses = () =>
    assessRefundCreate({
      kind: "retry",
      lot: { lifecycle, remainingCredits, ledgerSum: remainingCredits },
      payment: { status: "completed", stripePaymentIntentId: "pi_1", paidCents: PAID },
      ops,
      refunds,
      confirmedRefundIds: succeeded.filter((r) => r.operationId === null).map((r) => r.stripeRefundId),
    }).outcome === "create_refund";
  const exits: Exit[] =
    lifecycle === "refunded"
      ? ["resolve_outside", "restore_credits"]
      : ["settle", "send_back", "retry", "resolve_outside", "restore_credits"];
  return exits.filter((e) => (e === "retry" ? retryPasses() : oneShotPasses(e)));
}

const ownFailedLater = refund("re_own", "failed", PAID, { everSucceeded: true });
const ownDeclined = refund("re_own", "failed", PAID, { everSucceeded: false });

/** One state per way §5.4 and §6.2 reach each reason code, on a refunding lot unless noted. */
const ATTENTION_STATES: AttentionState[] = [
  {
    reason: "partial_refund",
    note: "own refund short of the payment",
    lifecycle: "refunding",
    refunds: [refund("re_own", "succeeded", 600)],
    exits: ["retry", "resolve_outside"],
  },
  {
    reason: "unexpected_external_refund",
    note: "an external refund nobody confirmed",
    lifecycle: "refunding",
    refunds: [refund("re_own", "succeeded", 700), refund("re_ext", "succeeded", 300, { operationId: null })],
    exits: ["settle", "resolve_outside"],
  },
  {
    reason: "stripe_refund_failed_later",
    note: "the whole refund failed after succeeding",
    lifecycle: "refunding",
    refunds: [ownFailedLater],
    exits: ["send_back", "resolve_outside", "restore_credits"],
  },
  {
    reason: "stripe_refund_failed_later",
    note: "own part failed after an external part succeeded",
    lifecycle: "refunding",
    refunds: [refund("re_ext", "succeeded", 400, { operationId: null }), refund("re_own", "failed", 600, { everSucceeded: true })],
    exits: ["resolve_outside"],
  },
  {
    reason: "attempts_exhausted",
    note: "no answer, nothing on Stripe",
    lifecycle: "refunding",
    refunds: [],
    exits: ["send_back", "retry", "resolve_outside", "restore_credits"],
  },
  {
    reason: "stripe_result_unknown",
    note: "5xx then nothing found for 24 hours",
    lifecycle: "refunding",
    refunds: [],
    exits: ["send_back", "retry", "resolve_outside", "restore_credits"],
  },
  {
    reason: "already_refunded_elsewhere",
    note: "charge_already_refunded, refunded outside in full",
    lifecycle: "refunding",
    refunds: [refund("re_ext", "succeeded", PAID, { operationId: null })],
    exits: ["settle", "resolve_outside"],
  },
  {
    reason: "stripe_declined",
    note: "first request answered 400, no refund object",
    lifecycle: "refunding",
    refunds: [],
    exits: ["retry", "resolve_outside", "restore_credits"],
  },
  {
    reason: "stripe_declined",
    note: "the refund object came back failed",
    lifecycle: "refunding",
    refunds: [ownDeclined],
    exits: ["resolve_outside", "restore_credits"],
  },
  {
    reason: "stripe_declined",
    note: "the charge is disputed",
    lifecycle: "refunding",
    refunds: [],
    disputed: true,
    exits: ["retry", "resolve_outside"],
  },
  {
    reason: "stripe_request_invalid",
    note: "first request answered 401/403/404",
    lifecycle: "refunding",
    refunds: [],
    exits: ["send_back", "retry", "resolve_outside", "restore_credits"],
  },
  {
    // Only a hand edit leaves this (§6.1): the approval's refund succeeded
    // while somebody had put the lot back to refund_pending.
    reason: "state_mismatch",
    note: "lot changed by hand",
    lifecycle: "refund_pending",
    refunds: [refund("re_own", "succeeded", PAID)],
    exits: ["settle", "resolve_outside"],
  },
];

describe("§9: every needs_attention has an exit the production judges accept", () => {
  it("the table covers every reason code, stripe_request_invalid included", () => {
    const every: AttentionReason[] = [
      "partial_refund",
      "unexpected_external_refund",
      "stripe_refund_failed_later",
      "attempts_exhausted",
      "stripe_result_unknown",
      "already_refunded_elsewhere",
      "stripe_declined",
      "stripe_request_invalid",
      "state_mismatch",
    ];
    expect([...new Set(ATTENTION_STATES.map((s) => s.reason))].sort()).toEqual([...every].sort());
  });

  it.each(ATTENTION_STATES)("$reason ($note) on a $lifecycle lot has exactly the exits $exits", (state) => {
    const ops = [attention(state.reason)];
    const passing = passingExits({ lifecycle: state.lifecycle, refunds: state.refunds, ops, disputed: state.disputed ?? false });
    expect(passing).toEqual(state.exits);
    if (state.reason !== "state_mismatch") {
      // Nothing processing: resolve_outside always passes.
      expect(passing).toContain("resolve_outside");
    }
  });

  it("a stripe_declined retry that ended in another needs_attention still cannot be sent back", () => {
    const ops = [
      op("needs_attention", 1, { attentionReason: "stripe_declined", attentionClosedAt: at(2) }),
      attention("attempts_exhausted", 2),
    ];
    expect(passingExits({ lifecycle: "refunding", refunds: [], ops, disputed: false })).toEqual([
      "retry",
      "resolve_outside",
      "restore_credits",
    ]);
  });
});

// ── §9 properties ─────────────────────────────────────────────────────

const copiesArb = fc
  .array(
    fc.record({
      status: fc.constantFrom<StripeRefundStatus>("succeeded", "failed", "canceled"),
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
    minute: fc.integer({ min: 0, max: 58 }),
    attention: fc.boolean(),
    closed: fc.boolean(),
    result: fc.constantFrom("refunded", "rejected", "sent_back", "resolved_outside", "restored"),
    reason: fc.constantFrom("attempts_exhausted", "stripe_declined", "stripe_request_invalid", "partial_refund"),
  }),
  { maxLength: 4 },
);

/**
 * Generated history as dispositions that are all finished.
 * @param raw - The generated rows.
 * @returns The dispositions.
 */
function settledOps(raw: { minute: number; attention: boolean; closed: boolean; result: string; reason: string }[]) {
  return raw.map((o) =>
    o.attention
      ? op("needs_attention", o.minute, {
          attentionReason: o.reason as AttentionReason,
          attentionClosedAt: o.closed ? at(59) : null,
        })
      : op("succeeded", o.minute, { result: o.result as AssessOperation["result"] }),
  );
}

describe("§9 properties over the production judges", () => {
  it("a refunded lot with an unresolved failed refund and nothing processing or in flight passes resolve_outside, and restore_credits exactly when nothing succeeded, nothing was paid outside and the charge is not disputed", () => {
    fc.assert(
      fc.property(
        copiesArb,
        fc.integer({ min: 1, max: PAID }),
        fc.constantFrom<StripeRefundStatus>("failed", "canceled"),
        settledOpsArb,
        fc.boolean(),
        (others, amount, status, rawOps, disputed) => {
          const refunds = [...others, refund("re_unresolved", status, amount, { everSucceeded: true })];
          const ops = settledOps(rawOps);
          const restoreHolds =
            !refunds.some((r) => r.status === "succeeded") &&
            !ops.some((o) => o.result === "resolved_outside") &&
            !disputed;
          expect(passingExits({ lifecycle: "refunded", refunds, ops, disputed })).toEqual(
            restoreHolds ? ["resolve_outside", "restore_credits"] : ["resolve_outside"],
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
        fc.boolean(),
        (lifecycle, refunds, rawOps, disputed) => {
          const unresolved = unresolvedOf(lifecycle, refunds);
          const succeededCents = refunds.filter((r) => r.status === "succeeded").reduce((n, r) => n + r.amountCents, 0);
          expect(
            assessOneShot({
              kind: "resolve_outside",
              lot: { lifecycle, remainingCredits: 100 },
              paidCents: PAID,
              ops: settledOps(rawOps),
              refunds,
              unresolvedFailedRefunds: unresolved,
              disputed,
              failedRefundIds: unresolved.map((r) => r.stripeRefundId),
              confirmedSucceededCents: succeededCents,
            }),
          ).toEqual(PROCEED);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a refunding lot left in an open needs_attention passes restore_credits exactly when nothing succeeded, nothing was paid outside and the charge is not disputed", () => {
    fc.assert(
      fc.property(copiesArb, settledOpsArb, fc.boolean(), (refunds, rawOps, disputed) => {
        // The latest disposition is the open needs_attention (§9: a refunding
        // lot with nothing in flight has one).
        const ops = [...settledOps(rawOps), attention("attempts_exhausted", 59)];
        const unresolved = unresolvedOf("refunding", refunds);
        const holds =
          !refunds.some((r) => r.status === "succeeded") &&
          !ops.some((o) => o.result === "resolved_outside") &&
          !disputed;
        const answer = assessOneShot({
          kind: "restore_credits",
          lot: { lifecycle: "refunding", remainingCredits: 100 },
          paidCents: PAID,
          ops,
          refunds,
          unresolvedFailedRefunds: unresolved,
          disputed,
          failedRefundIds: unresolved.map((r) => r.stripeRefundId),
        });
        expect(answer.outcome === "proceed").toBe(holds);
      }),
      { numRuns: 300 },
    );
  });
});
