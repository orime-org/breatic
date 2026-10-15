// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /internal/v1/credit-lots/:lotId/refund/restore-credits` (inner#1410
 * v9 §4.5, §5.3, §6.3 L9, §8): the buyer agreed to take the credits back
 * instead of the money, so the lot returns to `active`. Driven over a real
 * socket with signed requests, against real Postgres and Redis and the
 * stateful fake Stripe.
 *
 * The request reads Stripe twice before its transaction: `refunds.list`
 * (a failure is 503 and stores nothing) and then
 * `paymentIntents.retrieve(pi, { expand: ["latest_charge"] })` for the
 * charge's `disputed` (a failure is 503; the copies the first read wrote are
 * kept, no disposition and no mail row). Then it checks, first failure
 * answering (§5.3, design 3535a275):
 *
 * | # | condition                                                                 | 409                                |
 * |---|---------------------------------------------------------------------------|------------------------------------|
 * | 1 | no disposition in flight                                                  | operation_in_progress              |
 * | 2 | the lot never had a `resolved_outside` disposition                        | stripe_blocks paid_outside         |
 * | 3 | refunded / refund_pending with an unresolved failed refund; refunding whose latest disposition is an open needs_attention | lot_state_changed |
 * | 4 | the charge is not disputed                                                | stripe_blocks disputed             |
 * | 5 | `failedRefundIds` equals the unresolved failed refunds                    | stripe_blocks failed_refunds_changed |
 * | 6 | no `pending` / `requires_action` refund                                   | stripe_blocks refund_in_progress   |
 * | 7 | no `succeeded` refund                                                     | stripe_blocks refund_succeeded     |
 *
 * What it does: lot `active`, `refund_attempts` unchanged; one
 * `refund_reversed` ledger row naming the disposition, worth the negation of
 * the lot's `refund` row when booked (credits back) and 0 otherwise; the
 * failed refunds answered for; the open needs_attention closed; a
 * `credit.refund_restored` bell and an auto `refund_restored` mail.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import {
  ADMIN,
  call,
  errorShape,
  expectRefusedAroundInFlight,
  freshKey,
  holdersOf,
  mailsSettled,
  paths,
  useInternalApp,
} from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  copiesOf,
  eventsOf,
  ledgerOf,
  mailsOf,
  readLot,
  readOp,
  reId,
  refundObject,
  refundedThenFailed,
  seedCopy,
  seedOperation,
  seedRefundLot,
  worldOf,
  type RefundFixture,
  type SeededLot,
  type WorldState,
} from "./credit-refund-fixtures.js";
import { expectClosedBy, expectRestored } from "./credit-refund-cells.js";

const suite = useInternalApp("internal-api-restore-credits-test");

const MAIL_STATUSES_AFTER_FINISH = ["pending", "sending", "skipped"];
const BODY_REASON = "Buyer agreed to take the credits back.";

/**
 * Send a signed POST with a fresh (or given) idempotency key.
 * @param path - The endpoint.
 * @param body - JSON body.
 * @param key - Idempotency key.
 * @returns The answer.
 */
function post(path: string, body: unknown, key: string = freshKey("restore")) {
  return call(suite.baseUrl, path, { body, idempotencyKey: key });
}

/**
 * Restore the lot's credits.
 * @param lot - The lot.
 * @param failedRefundIds - The unresolved failed refunds the operator saw.
 * @param key - Idempotency key.
 * @returns The answer.
 */
function restore(lot: SeededLot, failedRefundIds: string[], key?: string) {
  return post(paths.restoreCredits(lot.lotId), { reason: BODY_REASON, failedRefundIds }, key);
}

/**
 * Everything but the refund copies.
 * @param w - The world.
 * @returns The world without copies.
 */
function exceptCopies(w: WorldState): Omit<WorldState, "copies"> {
  const { copies: _copies, ...rest } = w;
  return rest;
}

/**
 * A 409 that stored nothing but (perhaps) the copies it read and created nothing.
 * @param res - The answer.
 * @param lot - The lot.
 * @param before - The world before.
 * @param code - Expected code.
 * @param reason - Expected `stripe_blocks` reason.
 */
async function expectRefused(
  res: Awaited<ReturnType<typeof post>>,
  lot: SeededLot,
  before: WorldState,
  code: string,
  reason?: string,
): Promise<void> {
  expect(res.status).toBe(409);
  expect(errorShape(res.json)).toEqual({ code, reason, detailTranslated: true });
  expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
  expect(fakeStripe.createCalls).toEqual([]);
}

/**
 * A refunding lot Stripe declined at the first request: an open
 * needs_attention stripe_declined and no refund on Stripe.
 * @returns The lot and the open disposition.
 */
async function refundingDeclined() {
  const lot = await seedRefundLot(suite.sql, "refunding");
  const open = await seedOperation(suite.sql, lot, {
    kind: "approve",
    status: "needs_attention",
    attentionReason: "stripe_declined",
    createdSecondsAgo: 120,
  });
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
  return { lot, open: open.id };
}

/**
 * A refund_pending lot with an external refund that failed (never succeeded).
 * @param extra - More refunds Stripe holds for the payment.
 * @returns The lot and the failed refund.
 */
async function pendingWithFailed(extra: RefundFixture[] = []) {
  const lot = await seedRefundLot(suite.sql, "refund_pending");
  const failed = reId("failed_ext");
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", 300), ...extra]);
  return { lot, failed };
}

describe("POST …/refund/restore-credits — the credits come back (v9 §5.3, §6.3 L9)", () => {
  it("a refunded lot whose refund failed later: 200 restored; credits back by a refund_reversed row of the booked amount; the failed refund answered for; bell and auto mail; nothing created on Stripe", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);

    const res = await restore(lot, [failed]);

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({
      lotId: lot.lotId,
      kind: "restore_credits",
      status: "succeeded",
      result: "restored",
      notify: true,
      requestedBy: ADMIN,
      reason: BODY_REASON,
      failedRefundIds: [failed],
    });
    await expectRestored(suite.sql, lot, opId, {
      wasBooked: true,
      resolved: [failed],
      mailStatuses: MAIL_STATUSES_AFTER_FINISH,
    });
    // The two Stripe reads, in order: the refunds, then the charge's dispute flag.
    expect(fakeStripe.listedIntents()).toEqual([lot.paymentIntentId]);
    expect(fakeStripe.retrieveCalls).toEqual([
      expect.objectContaining({ id: lot.paymentIntentId, params: { expand: ["latest_charge"] } }),
    ]);
    expect(fakeStripe.createCalls).toEqual([]);
    expect((await eventsOf(suite.sql, opId)).map((e) => [e.event, e.from_status, e.to_status])).toEqual([
      ["requested", null, "succeeded"],
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("a refunding lot Stripe declined (no refund at all): 200 restored with a zero refund_reversed row, the open needs_attention closed", async () => {
    const { lot, open } = await refundingDeclined();
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, []);

    expect(res.status).toBe(200);
    await expectRestored(suite.sql, lot, res.json.id, { wasBooked: false, resolved: [], mailStatuses: MAIL_STATUSES_AFTER_FINISH });
    await expectClosedBy(suite.sql, lot, before, open, res.json.id);
    await mailsSettled(suite.sql, lot);
  });

  it("a refund_pending lot with a failed refund, asked once before: 200 restored, zero refund_reversed row, refund_attempts unchanged", async () => {
    const { lot, failed } = await pendingWithFailed();
    await suite.sql`UPDATE credit_lots SET refund_attempts = 1 WHERE id = ${lot.lotId}`;

    const res = await restore(lot, [failed]);

    expect(res.status).toBe(200);
    await expectRestored(suite.sql, lot, res.json.id, {
      wasBooked: false,
      resolved: [failed],
      attempts: 1,
      mailStatuses: MAIL_STATUSES_AFTER_FINISH,
    });
    await mailsSettled(suite.sql, lot);
  });

  it("a refunding lot whose refund was canceled: the canceled refund is answered for too", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 120,
    });
    const canceled = reId("canceled");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(canceled, "canceled", PAID_CENTS, open.id)]);

    const res = await restore(lot, [canceled]);

    expect(res.status).toBe(200);
    await expectRestored(suite.sql, lot, res.json.id, { wasBooked: false, resolved: [canceled], mailStatuses: MAIL_STATUSES_AFTER_FINISH });
    await mailsSettled(suite.sql, lot);
  });

  it("the same key and body again replays the snapshot: one disposition, one refund_reversed row, one bell", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const key = freshKey("restore_once");

    const first = await restore(lot, [failed], key);
    await mailsSettled(suite.sql, lot);
    const again = await restore(lot, [failed], key);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund_reversed")).toHaveLength(1);
    expect((await mailsOf(suite.sql, lot.lotId)).filter((m) => m.origin === "auto")).toHaveLength(1);
  });

  it("the same key with another body is 422 idempotency_key_reused and changes nothing", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const key = freshKey("restore_reused");
    expect((await restore(lot, [failed], key)).status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.restoreCredits(lot.lotId), { reason: "Another reason.", failedRefundIds: [failed] }, key);

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("idempotency_key_reused");
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });

  it("a restored lot's mail can be resent: a resend row of kind refund_restored beside the auto one", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const restored = await restore(lot, [failed]);
    expect(restored.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const key = freshKey("resend");

    const res = await post(paths.resend(restored.json.id), { reason: "Buyer says it never arrived." }, key);

    expect([200, 202]).toContain(res.status);
    expect(res.json).toMatchObject({ operationId: restored.json.id, kind: "refund_restored", origin: "resend", requestedBy: ADMIN });
    expect((await mailsOf(suite.sql, lot.lotId)).map((m) => [m.origin, m.kind])).toEqual([
      ["auto", "refund_restored"],
      ["resend", "refund_restored"],
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("the restored lot is active, its preview judges no operation and lists no failed refund", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    expect((await restore(lot, [failed])).status).toBe(200);

    const preview = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(preview.status).toBe(200);
    expect(preview.json.lot).toMatchObject({ lifecycle: "active", remainingCredits: `${CREDITS}.000000` });
    expect(preview.json.action).toBeNull();
    expect(preview.json.unresolvedFailedRefunds).toEqual([]);
    expect(preview.json.refundFailure).toBe(false);
    await mailsSettled(suite.sql, lot);
  });
});

describe("POST …/refund/restore-credits — refusals, in the order of §5.3 (design 3535a275)", () => {
  it("1. a disposition in flight is 409 operation_in_progress — before paid_outside", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      createdSecondsAgo: 300,
    });
    const inFlight = await seedOperation(suite.sql, lot, { kind: "retry", status: "awaiting_stripe", createdSecondsAgo: 60 });
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("restore");

    const res = await restore(lot, [failed], key);

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, inFlight.id, key);
  });

  it("2. a lot once resolved outside is 409 stripe_blocks paid_outside — even with nothing left unanswered, before the lot state", async () => {
    // The failed refund was answered by resolve_outside: the lot is refunded
    // with no unresolved failed refund, which alone would be lot_state_changed.
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const outside = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      failedRefundIds: [failed],
      createdSecondsAgo: 60,
    });
    await suite.sql`UPDATE credit_refunds SET resolved_by_operation_id = ${outside.id} WHERE stripe_refund_id = ${failed}`;
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, []);

    await expectRefused(res, lot, before, "stripe_blocks", "paid_outside");
  });

  it("2. paid_outside also when another refund failed after the resolve_outside (the money went out once already)", async () => {
    const later = reId("failed_after_outside");
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe, { extra: [refundObject(later, "failed", 200)] });
    const outside = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      failedRefundIds: [failed],
      createdSecondsAgo: 60,
    });
    await suite.sql`UPDATE credit_refunds SET resolved_by_operation_id = ${outside.id} WHERE stripe_refund_id = ${failed}`;
    await seedCopy(suite.sql, lot, { id: later, amountCents: 200, status: "succeeded" });
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, [later]);

    await expectRefused(res, lot, before, "stripe_blocks", "paid_outside");
  });

  it.each([
    ["an active lot", "active"],
    ["a refunded lot with no unresolved failed refund", "refunded"],
    ["a refund_pending lot with no unresolved failed refund", "refund_pending"],
    ["a refunding lot with no disposition", "refunding"],
  ] as const)("3. %s is 409 lot_state_changed", async (_name, state) => {
    const lot = await seedRefundLot(suite.sql, state);
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, []);

    await expectRefused(res, lot, before, "lot_state_changed");
  });

  it("3. a refunding lot whose latest needs_attention was already closed is 409 lot_state_changed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const closer = await seedOperation(suite.sql, lot, { kind: "send_back", status: "succeeded", result: "sent_back", createdSecondsAgo: 100 });
    const closed = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 60,
    });
    await suite.sql`
      UPDATE credit_refund_operations SET attention_closed_at = now(), attention_closed_by = ${closer.id} WHERE id = ${closed.id}
    `;
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await restore(lot, []), lot, before, "lot_state_changed");
  });

  it("4. a disputed charge is 409 stripe_blocks disputed — before failed_refunds_changed", async () => {
    const { lot } = await refundedThenFailed(suite.sql, fakeStripe);
    fakeStripe.setDisputed(lot.paymentIntentId, true);
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, [reId("not_the_failed_one")]);

    await expectRefused(res, lot, before, "stripe_blocks", "disputed");
  });

  it("4. disputed on a refunding lot Stripe declined (the dispute is why) is 409 disputed", async () => {
    const { lot } = await refundingDeclined();
    fakeStripe.setDisputed(lot.paymentIntentId, true);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await restore(lot, []), lot, before, "stripe_blocks", "disputed");
  });

  it("5. failedRefundIds other than the unresolved set is 409 stripe_blocks failed_refunds_changed — before refund_in_progress", async () => {
    const { lot } = await pendingWithFailed([refundObject(reId("pend"), "pending", 100)]);
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, []);

    await expectRefused(res, lot, before, "stripe_blocks", "failed_refunds_changed");
  });

  it("6. a refund still pending is 409 stripe_blocks refund_in_progress — before refund_succeeded", async () => {
    const { lot, failed } = await pendingWithFailed([
      refundObject(reId("pend"), "pending", 100),
      refundObject(reId("done"), "succeeded", 200),
    ]);
    const before = await worldOf(suite.sql, lot);

    const res = await restore(lot, [failed]);

    await expectRefused(res, lot, before, "stripe_blocks", "refund_in_progress");
  });

  it("6. a refund requiring action is 409 stripe_blocks refund_in_progress", async () => {
    const { lot, failed } = await pendingWithFailed([refundObject(reId("action"), "requires_action", 100)]);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await restore(lot, [failed]), lot, before, "stripe_blocks", "refund_in_progress");
  });

  it("7. a succeeded refund is 409 stripe_blocks refund_succeeded: the money reached the buyer", async () => {
    const { lot, failed } = await pendingWithFailed([refundObject(reId("done"), "succeeded", 200)]);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await restore(lot, [failed]), lot, before, "stripe_blocks", "refund_succeeded");
  });

  it("a refused request keeps the copies it read and stores no disposition or key", async () => {
    const done = reId("done_unseen");
    const { lot, failed } = await pendingWithFailed([refundObject(done, "succeeded", 200)]);
    const key = freshKey("restore");

    const res = await restore(lot, [failed], key);

    expect(res.status).toBe(409);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status]).sort()).toEqual(
      [
        [failed, "failed"],
        [done, "succeeded"],
      ].sort(),
    );
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
  });
});

describe("POST …/refund/restore-credits — Stripe unreadable (v9 §4.6, §5.3)", () => {
  it("refunds.list fails: 503 stripe_unavailable, nothing stored, the charge is never read; the same key works afterwards", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("restore");
    fakeStripe.failLists(stripeError(500));

    const res = await restore(lot, [failed], key);

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    expect(await worldOf(suite.sql, lot)).toEqual(before);
    expect(fakeStripe.retrieveCalls).toEqual([]);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });

    fakeStripe.failLists(null);
    expect((await restore(lot, [failed], key)).status).toBe(200);
    await mailsSettled(suite.sql, lot);
  });

  it("paymentIntents.retrieve fails: 503 stripe_unavailable; the copies the list read wrote are kept; no disposition, no mail, no ledger row, lot unchanged", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("restore");
    fakeStripe.failRetrieves(stripeError(502));

    const res = await restore(lot, [failed], key);

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    // The list read is copied (§6.4): the booked refund's failure is now on the copy.
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: failed, status: "failed", ever_succeeded: true, resolved_by_operation_id: null }),
    ]);
    expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
  });
});

describe("POST …/refund/restore-credits — body (v9 §4.5)", () => {
  it.each([
    ["no failedRefundIds", { reason: "r" }],
    ["no reason", { failedRefundIds: [] }],
    ["an unknown field", { reason: "r", failedRefundIds: [], notify: false }],
  ])("a body with %s is 422 invalid_body", async (_name, body) => {
    const { lot } = await refundedThenFailed(suite.sql, fakeStripe);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.restoreCredits(lot.lotId), body);

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });

  it("the restore is recorded on the disposition: failedRefundIds and the request's reason, never notify false", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);

    const res = await restore(lot, [failed]);

    expect(res.status).toBe(200);
    expect(await readOp(suite.sql, res.json.id)).toMatchObject({
      kind: "restore_credits",
      failed_refund_ids: [failed],
      reason: BODY_REASON,
      notify: true,
    });
    await mailsSettled(suite.sql, lot);
  });
});
