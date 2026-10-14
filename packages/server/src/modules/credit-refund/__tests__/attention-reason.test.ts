// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which needs_attention reason a create disposition ends with (inner#1410 v9
 * §5.4, §6.2), driven through `transitionOperation` with its repositories
 * stood in for. What the cells write against a real database is in the
 * `credit-refund-op-started` integration suite.
 *
 * E6 under `started` (Stripe definitely did not refund) never looks at or
 * changes the lot: it always turns needs_attention, and the lot stays where
 * it is.
 *
 * | E6 answer                                        | reason                      |
 * |--------------------------------------------------|-----------------------------|
 * | refund object failed/canceled, copy ever_succeeded | stripe_refund_failed_later |
 * | first-request 401, 403, 404                      | stripe_request_invalid      |
 * | first-request 400, refund object failed/canceled | stripe_declined             |
 *
 * E11 (attempts used up, the refund not on the list) reads every create
 * answer of this disposition's event rows — the detail of refund_declined
 * (E6), retryable_error (E7), stripe_server_error (E8),
 * charge_already_refunded (E9), unclassified_error (E17) and late_answer
 * rows, and `detail.createFailure` of stripe_read_failed (E16) rows — and
 * ends `stripe_declined` when one of them is a Stripe refusal
 * (`isStripeRefusal`), `attempts_exhausted` otherwise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StripeRefundObject } from "@server/modules/credit-refund/types.js";

const TX = { tx: "the caller's transaction" };
const OP_ID = "33333333-3333-4333-8333-333333333333";
const LOT_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_ID = "55555555-5555-4555-8555-555555555555";
const LEASE = "lease-1";

const findLotId = vi.fn();
const lockById = vi.fn();
const update = vi.fn();
const appendEvent = vi.fn();
const listEvents = vi.fn();
const listOpenAttention = vi.fn();
vi.mock("@server/modules/credit-refund/operation.repo.js", () => ({
  findLotId: (...a: unknown[]) => findLotId(...a),
  lockById: (...a: unknown[]) => lockById(...a),
  update: (...a: unknown[]) => update(...a),
  appendEvent: (...a: unknown[]) => appendEvent(...a),
  listEvents: (...a: unknown[]) => listEvents(...a),
  listOpenAttention: (...a: unknown[]) => listOpenAttention(...a),
}));

const lockLot = vi.fn();
const lotService = {
  settleRefund: vi.fn(),
  sendBackRefund: vi.fn(),
  rejectRefund: vi.fn(),
  markRefunding: vi.fn(),
  restoreRefundedCredits: vi.fn(),
};
vi.mock("@breatic/domain", () => ({
  creditLotRepo: { lockLot: (...a: unknown[]) => lockLot(...a) },
  creditLotService: lotService,
}));

const listForPayment = vi.fn();
const markResolved = vi.fn();
vi.mock("@server/modules/credit-refund/refund-copy.repo.js", () => ({
  listForPayment: (...a: unknown[]) => listForPayment(...a),
  markResolved: (...a: unknown[]) => markResolved(...a),
}));

vi.mock("@server/modules/credit-refund/refund-mail.repo.js", () => ({ insertAuto: vi.fn() }));
vi.mock("@server/modules/notification/notification.service.js", () => ({
  createCreditRefundCompleted: vi.fn(),
  createCreditRefundRejected: vi.fn(),
  createCreditRefundRestored: vi.fn(),
}));
vi.mock("@server/modules/payment/payment.repo.js", () => ({ readPaidAmount: vi.fn() }));
vi.mock("@server/config/credit-refund.js", () => ({
  getCreditRefundConfig: () => ({
    stripeCallTimeoutMs: 20000,
    leaseSeconds: 120,
    loopIntervalSeconds: 60,
    backoffBaseSeconds: 60,
    backoffMaxSeconds: 3600,
    maxAttempts: 8,
    staleSendingMinutes: 10,
    reconcileWindowDays: 30,
  }),
}));

const { transitionOperation } = await import("@server/modules/credit-refund/operation-transitions.js");

/** The disposition under test, as `lockById` reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: OP_ID,
    lotId: LOT_ID,
    paymentId: PAYMENT_ID,
    kind: "approve",
    status: "started",
    result: null,
    attentionReason: null,
    attentionDetail: null,
    attentionClosedAt: null,
    attentionClosedBy: null,
    idempotencyKey: "key-1",
    requestHash: "hash",
    requestedBy: "admin-1",
    reason: "buyer asked",
    notify: true,
    refundRequestedAt: new Date("2026-10-01T00:00:00Z"),
    confirmedRefundIds: [],
    confirmedSucceededCents: null,
    failedRefundIds: [],
    settledSucceededCents: null,
    stripeRefundId: null,
    firstCalledAt: new Date("2026-10-01T00:01:00Z"),
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    leaseToken: LEASE,
    lockedUntil: new Date("2026-10-01T00:03:00Z"),
    createdAt: new Date("2026-10-01T00:00:30Z"),
    updatedAt: new Date("2026-10-01T00:00:30Z"),
    finishedAt: null,
    ...over,
  };
}

/** The lot, as `lockLot` reads it. */
function lot(lifecycle: string) {
  return {
    id: LOT_ID,
    userId: "buyer-1",
    lifecycle,
    purchasedCredits: "880.000000",
    remainingCredits: lifecycle === "refunded" ? "0" : "880.000000",
  };
}

/** One copy of a Stripe refund. */
function copy(id: string, status: string, everSucceeded: boolean) {
  return {
    stripeRefundId: id,
    amountCents: 1080,
    status,
    pendingReason: null,
    operationId: OP_ID,
    everSucceeded,
    resolvedByOperationId: null,
    failureReason: null,
  };
}

/** The live refund object an E6 event carries. */
const refundObject = (status: "failed" | "canceled"): StripeRefundObject => ({
  id: "re_1",
  amount: 1080,
  currency: "usd",
  status,
  failure_reason: status === "failed" ? "expired_or_canceled_card" : null,
  pending_reason: null,
  metadata: { refund_operation_id: OP_ID },
});

/** An event row as the repository lists it. */
function eventRow(event: string, detail: Record<string, unknown>, minute: number) {
  return {
    id: `ev-${minute}`,
    operationId: OP_ID,
    event,
    fromStatus: "started",
    toStatus: "started",
    detail,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)),
  };
}

/** A Stripe error as an event row stores it. */
const stored = (httpStatus: number, extra: Record<string, unknown> = {}) => ({
  message: `synthetic ${httpStatus}`,
  httpStatus,
  ...extra,
  actor: "loop",
});

const REQUESTED = eventRow("requested", { kind: "approve", notify: true, confirmedRefundIds: [], actor: "request" }, 0);
const CLAIMED = eventRow("claimed", { actor: "loop" }, 1);

/** Set the lot, the row and the copies the cell will read. */
function given(input: { lifecycle?: string; row?: Record<string, unknown>; copies?: unknown[]; events?: unknown[] }) {
  const r = row(input.row);
  findLotId.mockResolvedValue(LOT_ID);
  lockLot.mockResolvedValue(lot(input.lifecycle ?? "refunding"));
  lockById.mockResolvedValue(r);
  listForPayment.mockResolvedValue(input.copies ?? []);
  listEvents.mockResolvedValue(input.events ?? []);
  update.mockImplementation((_id: string, patch: Record<string, unknown>) =>
    Promise.resolve({ ...r, ...patch, status: patch["status"] ?? r.status }),
  );
}

/** The status and reason the cell wrote. */
function written(): { status: unknown; attentionReason: unknown } {
  expect(update).toHaveBeenCalledTimes(1);
  const patch = update.mock.calls[0]![1] as Record<string, unknown>;
  return { status: patch["status"], attentionReason: patch["attentionReason"] };
}

/** The lot was neither read for a decision nor changed. */
function expectLotUntouched(): void {
  for (const fn of Object.values(lotService)) expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  listOpenAttention.mockResolvedValue([]);
  appendEvent.mockResolvedValue(undefined);
});

describe("E6 under started: needs_attention, the lot unchanged", () => {
  it("a first-request 400 is stripe_declined; the lot stays refunding (no send-back)", async () => {
    given({});
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      failure: { message: "A previous attempt to refund charge ch_1 to card card_1 failed", httpStatus: 400, type: "invalid_request_error" },
      actor: "request",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
    expectLotUntouched();
  });

  it("a first-request 400 on a retry is stripe_declined too", async () => {
    given({ row: { kind: "retry" } });
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      failure: { message: "charge disputed", httpStatus: 400, code: "charge_disputed" },
      actor: "loop",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
    expectLotUntouched();
  });

  it.each([401, 403, 404])("a first-request %i is stripe_request_invalid", async (httpStatus) => {
    given({});
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      failure: { message: `synthetic ${httpStatus}`, httpStatus, type: "invalid_request_error" },
      actor: "request",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_request_invalid" });
    expectLotUntouched();
  });

  it.each(["failed", "canceled"] as const)("a %s refund object whose copy never succeeded is stripe_declined", async (status) => {
    given({ copies: [copy("re_1", status, false)] });
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      refund: refundObject(status),
      actor: "request",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
    expectLotUntouched();
  });

  it("a failed refund object whose copy once succeeded is stripe_refund_failed_later", async () => {
    given({ copies: [copy("re_1", "failed", true)] });
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      refund: refundObject("failed"),
      actor: "loop",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_refund_failed_later" });
    expectLotUntouched();
  });

  it("never checks the lot: a lot found in refund_pending still gets stripe_declined, not state_mismatch", async () => {
    given({ lifecycle: "refund_pending" });
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      failure: { message: "synthetic 400", httpStatus: 400 },
      actor: "request",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
    expectLotUntouched();
  });

  it("never checks the lot: a first-request 403 on a lot found refunded is still stripe_request_invalid", async () => {
    given({ lifecycle: "refunded" });
    await transitionOperation(TX as never, { id: OP_ID }, {
      type: "E6",
      failure: { message: "synthetic 403", httpStatus: 403 },
      actor: "request",
      leaseToken: LEASE,
    });
    expect(written()).toEqual({ status: "needs_attention", attentionReason: "stripe_request_invalid" });
    expectLotUntouched();
  });
});

describe("E11 under started: the reason comes from this disposition's create answers", () => {
  /**
   * Run E11 with the given event rows on file.
   * @param events - The disposition's event rows, oldest first.
   * @returns The status and reason written.
   */
  async function exhaust(events: unknown[]) {
    given({ row: { attemptCount: 8, leaseToken: LEASE }, events });
    await transitionOperation(TX as never, { id: OP_ID }, { type: "E11", actor: "loop" });
    return written();
  }

  it("a refusal among the answers is stripe_declined", async () => {
    expect(
      await exhaust([
        REQUESTED,
        eventRow("retryable_error", { message: "Request timed out", actor: "request" }, 1),
        CLAIMED,
        eventRow("unclassified_error", stored(400, { type: "invalid_request_error", code: "charge_disputed" }), 3),
      ]),
    ).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
    expectLotUntouched();
  });

  it("a refusal followed by a timeout is still stripe_declined", async () => {
    expect(
      await exhaust([
        REQUESTED,
        eventRow("retryable_error", { message: "Request timed out", actor: "request" }, 1),
        eventRow("unclassified_error", stored(400), 2),
        eventRow("retryable_error", { message: "Request timed out", actor: "loop" }, 3),
      ]),
    ).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
  });

  it("a refusal kept as the createFailure of a failed read (E16) is stripe_declined", async () => {
    expect(
      await exhaust([
        REQUESTED,
        eventRow(
          "stripe_read_failed",
          { message: "read failed", httpStatus: 500, createFailure: { message: "synthetic 400", httpStatus: 400 }, actor: "loop" },
          2,
        ),
      ]),
    ).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
  });

  it("a refusal that came back as a late answer is stripe_declined", async () => {
    expect(
      await exhaust([REQUESTED, eventRow("late_answer", { answer: "E17", ...stored(400) }, 2)]),
    ).toEqual({ status: "needs_attention", attentionReason: "stripe_declined" });
  });

  it("no refusal among the answers is attempts_exhausted", async () => {
    expect(
      await exhaust([
        REQUESTED,
        eventRow("retryable_error", { message: "Request timed out", actor: "request" }, 1),
        eventRow("retryable_error", stored(400, { code: "rate_limit" }), 2),
        eventRow("retryable_error", stored(400, { shouldRetry: true }), 3),
        eventRow("unclassified_error", stored(400, { type: "idempotency_error" }), 4),
        eventRow("unclassified_error", stored(402), 5),
        eventRow("unclassified_error", stored(404), 6),
        eventRow("stripe_read_failed", { ...stored(500), createFailure: { message: "timeout" } }, 7),
      ]),
    ).toEqual({ status: "needs_attention", attentionReason: "attempts_exhausted" });
  });

  it("a failed read's own 400 is not a create answer: attempts_exhausted", async () => {
    expect(
      await exhaust([REQUESTED, eventRow("stripe_read_failed", stored(400, { type: "invalid_request_error" }), 2)]),
    ).toEqual({ status: "needs_attention", attentionReason: "attempts_exhausted" });
  });
});
