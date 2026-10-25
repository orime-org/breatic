// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The eight signed write endpoints retain final refusals under their shared
 * key (inner#1555); previews expose the four one-shot judgements (inner#1544).
 * HTTP, PostgreSQL, Redis and transaction locks are real. Stripe's existing
 * stateful test client supplies deterministic external payment states.
 */

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => { throw new Error("not used by this suite"); },
  };
});

import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import { aroundNextList, fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import { ADMIN, buildRequest, call, freshKey, holdersOf, mailsSettled, paths, useInternalApp, type CallResult } from "./internal-api-harness.js";
import { CREDITS, PAID_CENTS, ledgerOf, readLot, readOp, reId, refundObject, refundedThenFailed, seedOperation, seedRefundLot, type LotState, type SeededLot } from "./credit-refund-fixtures.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { openPaymentSource } from "./payment-source.js";

const suite = useInternalApp("internal-api-refund-refusals-test");
const APPROVE = { reason: "Return the unused payment.", confirmedRefundIds: [] };
const REJECT = { reason: "The refund request was declined." };

/** Create a real purchased lot and its external payment fixture. */
async function lotOnStripe(state: LotState): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
  return lot;
}

/** Send a fresh signed request under the specified logical request key. */
function post(path: string, body: unknown, key: string): Promise<CallResult> {
  return call(suite.baseUrl, path, { body, idempotencyKey: key });
}

type StoredRefusalRow = {
  target_kind: string; target_id: string; request_kind: string; requested_by: string;
  request_reason: string; request_hash: string; response_status: number; response_body: unknown;
};

/** Read the actual persisted final response for a key. */
async function refusalRows(key: string): Promise<StoredRefusalRow[]> {
  return suite.sql<StoredRefusalRow[]>`
    SELECT target_kind, target_id, request_kind, requested_by, request_reason, request_hash,
           response_status, response_body
    FROM credit_refund_refusals WHERE idempotency_key = ${key}
  `;
}

/** Assert the exact final response and the exclusive key's ownership. */
async function expectStored(key: string, answer: CallResult, kind: string, target: string): Promise<void> {
  expect(await refusalRows(key)).toEqual([{
    target_kind: kind === "resend_mail" ? "operation" : "lot", target_id: target,
    request_kind: kind, requested_by: ADMIN, request_reason: kind === "approve" ? APPROVE.reason : REJECT.reason,
    request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), response_status: answer.status, response_body: answer.json,
  }]);
  expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
}

describe("preview: four complete one-shot verdicts and the matching HTTP decisions", () => {
  it.each(["reject", "settle", "send_back", "resolve_outside"] as const)("%s is allowed by the preview and by the same-facts write", async (kind) => {
    let lot: SeededLot;
    let failedIds: string[] = [];
    if (kind === "resolve_outside") {
      const seeded = await refundedThenFailed(suite.sql, fakeStripe);
      lot = seeded.lot;
      failedIds = [seeded.failed];
    } else {
      lot = await lotOnStripe(kind === "send_back" ? "refunding" : "refund_pending");
      if (kind === "send_back") await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_request_invalid" });
      if (kind === "settle") fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(reId("external_full"), "succeeded", PAID_CENTS)]);
    }
    const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
    expect(preview.status).toBe(200);
    expect(Object.keys(preview.json.oneShot ?? {}).sort()).toEqual(["reject", "resolve_outside", "send_back", "settle"]);
    expect(preview.json.oneShot[kind]).toEqual({ outcome: "allowed" });
    const body = kind === "settle" ? { ...REJECT, notify: false, confirmedSucceededCents: PAID_CENTS }
      : kind === "resolve_outside" ? { ...REJECT, failedRefundIds: failedIds, confirmedSucceededCents: 0 } : REJECT;
    const path = kind === "reject" ? paths.reject(lot.lotId) : kind === "settle" ? paths.settle(lot.lotId)
      : kind === "send_back" ? paths.sendBack(lot.lotId) : paths.resolvedOutside(lot.lotId);
    const answer = await post(path, body, freshKey(kind));
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ lotId: lot.lotId, kind, status: "succeeded" });
    await mailsSettled(suite.sql, lot);
  });

  it("the preview's blocked reason agrees with the one-shot endpoint", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(reId("pending"), "pending", PAID_CENTS)]);
    const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
    expect(preview.json.oneShot).toEqual({
      reject: { outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" },
      settle: { outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" },
      send_back: { outcome: "blocked", code: "lot_state_changed" },
      resolve_outside: { outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" },
    });
    const answer = await post(paths.reject(lot.lotId), REJECT, freshKey());
    expect(answer.status).toBe(409);
    expect(answer.json).toMatchObject({ code: preview.json.oneShot.reject.code, reason: preview.json.oneShot.reject.reason });
  });
});

describe("all eight write endpoints share persisted refusal ownership", () => {
  it.each(["approve", "retry", "reject", "settle", "send_back", "resolve_outside", "restore_credits", "resend_mail"] as const)("%s stores its final refusal with the original request identity", async (kind) => {
    const lot = await lotOnStripe("active");
    let target = lot.lotId;
    let path: string;
    let body: unknown = REJECT;
    switch (kind) {
      case "approve": path = paths.approve(target); body = APPROVE; break;
      case "retry": path = paths.retry(target); body = { ...REJECT, confirmedRefundIds: [] }; break;
      case "reject": path = paths.reject(target); break;
      case "settle": path = paths.settle(target); body = { ...REJECT, notify: false, confirmedSucceededCents: 0 }; break;
      case "send_back": path = paths.sendBack(target); break;
      case "resolve_outside": path = paths.resolvedOutside(target); body = { ...REJECT, failedRefundIds: [], confirmedSucceededCents: 0 }; break;
      case "restore_credits": path = paths.restoreCredits(target); body = { ...REJECT, failedRefundIds: [] }; break;
      case "resend_mail": target = (await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "attempts_exhausted" })).id; path = paths.resend(target); break;
    }
    const key = freshKey(kind);
    const answer = await post(path, body, key);
    expect(answer.status).toBe(409);
    expect(answer.json.code).toBe(kind === "resend_mail" ? "mail_not_resendable" : "lot_state_changed");
    await expectStored(key, answer, kind, target);
    const replay = await post(path, body, key);
    expect({ status: replay.status, body: replay.json }).toEqual({ status: answer.status, body: answer.json });
    expect(await refusalRows(key)).toHaveLength(1);
  });

  it("a business refusal remains final after the lot becomes eligible", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(409);
    await suite.sql`UPDATE credit_lots SET lifecycle = 'refund_pending', refund_requested_at = now() WHERE id = ${lot.lotId}`;
    const second = await post(paths.approve(lot.lotId), APPROVE, key);
    await mailsSettled(suite.sql, lot);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
    expect(fakeStripe.createCalls).toEqual([]);
    await expectStored(key, first, "approve", lot.lotId);
  });

  it("a Stripe-state refusal is replayed without a new Stripe read after that state changes", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(reId("pending"), "pending", 100)]);
    const key = freshKey();
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.json).toMatchObject({ code: "stripe_blocks", reason: "refund_in_progress" });
    const reads = fakeStripe.listCalls.length;
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
    const second = await post(paths.approve(lot.lotId), APPROVE, key);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
    expect(fakeStripe.listCalls).toHaveLength(reads);
    expect(fakeStripe.createCalls).toEqual([]);
    await expectStored(key, first, "approve", lot.lotId);
  });

  it("operation_in_progress remains final after the other disposition finishes", async () => {
    const lot = await lotOnStripe("refund_pending");
    const old = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    const key = freshKey();
    const first = await post(paths.reject(lot.lotId), REJECT, key);
    expect(first.json.code).toBe("operation_in_progress");
    await suite.sql`UPDATE credit_refund_operations SET status = 'needs_attention', attention_reason = 'state_mismatch', finished_at = now(), lease_token = NULL, locked_until = NULL, next_attempt_at = NULL WHERE id = ${old.id}`;
    const second = await post(paths.reject(lot.lotId), REJECT, key);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
    await expectStored(key, first, "reject", lot.lotId);
  });

  it("mail_not_resendable remains final after the disposition becomes resendable", async () => {
    const lot = await lotOnStripe("active");
    const old = await seedOperation(suite.sql, lot, { kind: "reject", status: "needs_attention", attentionReason: "state_mismatch" });
    const key = freshKey();
    const first = await post(paths.resend(old.id), REJECT, key);
    expect(first.json.code).toBe("mail_not_resendable");
    await suite.sql`UPDATE credit_refund_operations SET status = 'succeeded', result = 'rejected', attention_reason = NULL, attention_detail = NULL WHERE id = ${old.id}`;
    const second = await post(paths.resend(old.id), REJECT, key);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
    await expectStored(key, first, "resend_mail", old.id);
  });

  it.each(["lot", "operation"] as const)("the early missing %s 404 owns its key", async (targetKind) => {
    const target = randomUUID();
    const path = targetKind === "lot" ? paths.reject(target) : paths.resend(target);
    const key = freshKey();
    const first = await post(path, REJECT, key);
    expect(first.status).toBe(404);
    expect(first.json.code).toBe("not_found");
    await expectStored(key, first, targetKind === "lot" ? "reject" : "resend_mail", target);
    const second = await post(path, REJECT, key);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
  });

  it.each(["body", "target", "action"] as const)("a refusal key with another %s is 422", async (changed) => {
    const lot = await lotOnStripe("active");
    const other = await lotOnStripe("refund_pending");
    const key = freshKey();
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(409);
    const path = changed === "target" ? paths.approve(other.lotId) : changed === "action" ? paths.reject(lot.lotId) : paths.approve(lot.lotId);
    const body = changed === "body" ? { ...APPROVE, reason: "Changed request." } : changed === "action" ? REJECT : APPROVE;
    const different = await post(path, body, key);
    expect(different.status).toBe(422);
    expect(different.json.code).toBe("idempotency_key_reused");
    await expectStored(key, first, "approve", lot.lotId);
  });

  it("a soft-deleted refusal continues to own its key", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    await suite.sql`UPDATE credit_refund_refusals SET deleted_at = now() WHERE idempotency_key = ${key}`;
    await suite.sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lot.lotId}`;
    const second = await post(paths.approve(lot.lotId), APPROVE, key);
    expect({ status: second.status, body: second.json }).toEqual({ status: first.status, body: first.json });
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("replays the persisted literal detail even when it differs from the current translation", async () => {
    const target = randomUUID();
    const key = freshKey();
    const body = { code: "not_found", detail: "The original response wording is retained." };
    const hash = fingerprint("POST", "/internal/v1/credit-lots/:lotId/refund/reject", target, REJECT);
    await suite.sql`INSERT INTO credit_refund_refusals (id, idempotency_key, request_hash, request_kind, target_kind, target_id, requested_by, request_reason, response_status, response_body) VALUES (${randomUUID()}, ${key}, ${hash}, 'reject', 'lot', ${target}, ${ADMIN}, ${REJECT.reason}, 404, ${suite.sql.json(body)})`;
    const replay = await post(paths.reject(target), REJECT, key);
    expect({ status: replay.status, body: replay.json }).toEqual({ status: 404, body });
    expect(fakeStripe.listCalls).toEqual([]);
  });
});

describe("key decisions remain atomic across concurrency and transport failures", () => {
  it.each(["lot", "payment"] as const)("a missing %s target restored while waiting for the key lock continues with Stripe preparation outside that lock", async (missing) => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey();
    if (missing === "lot") {
      await suite.sql`UPDATE credit_lots SET deleted_at = now() WHERE id = ${lot.lotId}`;
    } else {
      // The receipt exists (preserving the composite source FK), while its
      // corresponding payment has not appeared yet.
      const missingPaymentId = await openPaymentSource(suite.sql);
      await suite.sql`UPDATE credit_lots SET source_id = ${missingPaymentId} WHERE id = ${lot.lotId}`;
    }
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    const gate = suite.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`internal-idem:${key}`}))`;
      entered();
      await unlocked;
    });
    await ready;
    let keyWasFreeDuringPreparation: boolean | undefined;
    aroundNextList(fakeStripe, async (read) => {
      // A different PG connection can acquire this key only after the early
      // target recheck transaction has committed, before Stripe preparation.
      keyWasFreeDuringPreparation = await suite.sql.begin(async (tx) => {
        const rows = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`internal-idem:${key}`})) AS acquired`;
        return rows[0]!.acquired;
      });
      return read();
    });
    const request = post(paths.reject(lot.lotId), REJECT, key);
    try {
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 1);
      expect(fakeStripe.listCalls).toEqual([]);
      expect(fakeStripe.createCalls).toEqual([]);
      if (missing === "lot") {
        await suite.sql`UPDATE credit_lots SET deleted_at = NULL WHERE id = ${lot.lotId}`;
      } else {
        await suite.sql`UPDATE credit_lots SET source_id = ${lot.paymentId} WHERE id = ${lot.lotId}`;
      }
    } finally { release(); await gate; }
    const answer = await request;
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ lotId: lot.lotId, kind: "reject", status: "succeeded", result: "rejected" });
    expect(keyWasFreeDuringPreparation).toBe(true);
    expect(fakeStripe.listCalls).toEqual([{ payment_intent: lot.paymentIntentId, limit: 100 }]);
    expect(fakeStripe.createCalls).toEqual([]);
    expect(await readOp(suite.sql, answer.json.id)).toMatchObject({
      kind: "reject", status: "succeeded", result: "rejected", idempotency_key: key, requested_by: ADMIN,
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "active", remaining: `${CREDITS}.000000`, attempts: 1 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((row) => row.entry_type === "refund_rejected")).toEqual([
      { entry_type: "refund_rejected", amount: "0.000000", reference_id: answer.json.id },
    ]);
    expect(await refusalRows(key)).toEqual([]);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    await mailsSettled(suite.sql, lot);
  });

  it("a missing resend operation created while waiting for the key lock queues one resend instead of storing 404", async () => {
    const lot = await lotOnStripe("active");
    const operationId = randomUUID();
    const key = freshKey();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    const gate = suite.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`internal-idem:${key}`}))`;
      entered();
      await unlocked;
    });
    await ready;
    const request = post(paths.resend(operationId), REJECT, key);
    try {
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 1);
      expect(await refusalRows(key)).toEqual([]);
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
      await suite.sql`
        INSERT INTO credit_refund_operations
          (id, lot_id, payment_id, kind, status, result, idempotency_key, request_hash,
           requested_by, reason, notify, finished_at)
        VALUES (${operationId}, ${lot.lotId}, ${lot.paymentId}, 'reject', 'succeeded', 'rejected',
                ${freshKey("earlier-reject")}, ${"0".repeat(64)}, ${ADMIN}, ${REJECT.reason}, true, now())
      `;
    } finally { release(); await gate; }
    const answer = await request;
    expect(answer.status).toBe(202);
    expect(answer.json).toMatchObject({ operationId, kind: "refund_rejected", origin: "resend", requestedBy: ADMIN, reason: REJECT.reason });
    const rows = await suite.sql`
      SELECT id, operation_id, kind, origin, requested_by, reason, idempotency_key, request_hash
      FROM refund_mail_outbox WHERE idempotency_key = ${key}
    `;
    expect(rows).toEqual([{
      id: answer.json.id, operation_id: operationId, kind: "refund_rejected", origin: "resend",
      requested_by: ADMIN, reason: REJECT.reason, idempotency_key: key, request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 1 });
    expect(await refusalRows(key)).toEqual([]);
    expect(fakeStripe.listCalls).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
    await mailsSettled(suite.sql, lot);
  });

  it("a database failure while inserting the refusal rolls back the decision and leaves the key unused", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    const name = `refusal_insert_failure_${randomUUID().replaceAll("-", "")}`;
    let triggerCreated = false;
    await suite.sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refusal insert failure'; END $$`);
    try {
      await suite.sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON credit_refund_refusals FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      triggerCreated = true;
      const failed = await post(paths.approve(lot.lotId), APPROVE, key);
      expect({ status: failed.status, body: failed.json }).toEqual({ status: 500, body: { code: "internal_error" } });
      expect(await refusalRows(key)).toEqual([]);
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
    } finally {
      if (triggerCreated) await suite.sql.unsafe(`DROP TRIGGER ${name} ON credit_refund_refusals`);
      await suite.sql.unsafe(`DROP FUNCTION ${name}()`);
    }
    const retry = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(retry.status).toBe(409);
    await expectStored(key, retry, "approve", lot.lotId);
  });

  it("two same-body requests blocked on the same real key lock retain one refusal", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    const gate = suite.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`internal-idem:${key}`}))`;
      entered();
      await unlocked;
    });
    await ready;
    const first = post(paths.approve(lot.lotId), APPROVE, key);
    let second: Promise<CallResult> | undefined;
    try {
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 1);
      second = post(paths.approve(lot.lotId), APPROVE, key);
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 2);
    } finally { release(); await gate; }
    const a = await first;
    const b = await second;
    expect({ status: a.status, body: a.json }).toEqual({ status: b.status, body: b.json });
    expect(a.status).toBe(409);
    await expectStored(key, a, "approve", lot.lotId);
  });

  it("a late original request replays the refusal chosen by its retry", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    aroundNextList(fakeStripe, async (read) => { const rows = await read(); entered(); await unlocked; return rows; });
    const original = post(paths.approve(lot.lotId), APPROVE, key);
    await ready;
    let retry: CallResult;
    try {
      retry = await post(paths.approve(lot.lotId), APPROVE, key);
      expect(retry.status).toBe(409);
      await suite.sql`UPDATE credit_lots SET lifecycle = 'refund_pending', refund_requested_at = now() WHERE id = ${lot.lotId}`;
    } finally { release(); }
    const late = await original;
    await mailsSettled(suite.sql, lot);
    expect({ status: late.status, body: late.json }).toEqual({ status: retry!.status, body: retry!.json });
    expect(fakeStripe.createCalls).toEqual([]);
    await expectStored(key, retry!, "approve", lot.lotId);
  });

  it("a client disconnect after response headers leaves the committed refusal available", async () => {
    const lot = await lotOnStripe("active");
    const key = freshKey();
    const request = buildRequest(paths.approve(lot.lotId), { body: APPROVE, idempotencyKey: key });
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(new URL(paths.approve(lot.lotId), suite.baseUrl), { method: request.method, headers: request.headers }, (incoming) => {
        incoming.destroy(); outgoing.destroy(); resolve();
      });
      outgoing.on("error", reject);
      outgoing.end(request.body);
    });
    const stored = await refusalRows(key);
    expect(stored).toHaveLength(1);
    const replay = await post(paths.approve(lot.lotId), APPROVE, key);
    expect({ status: replay.status, body: replay.json }).toEqual({ status: stored[0]!.response_status, body: stored[0]!.response_body });
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
  });

  it("a validation refusal leaves the key available for a valid body", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey();
    const invalid = await post(paths.reject(lot.lotId), { reason: "" }, key);
    expect(invalid.status).toBe(422);
    expect(await refusalRows(key)).toEqual([]);
    const accepted = await post(paths.reject(lot.lotId), REJECT, key);
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ kind: "reject", result: "rejected" });
    await mailsSettled(suite.sql, lot);
  });

  it("a failed external read leaves the key available for the same request", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey();
    fakeStripe.failLists(stripeError(500));
    const failed = await post(paths.approve(lot.lotId), APPROVE, key);
    expect({ status: failed.status, body: failed.json }).toEqual({ status: 503, body: { code: "stripe_unavailable" } });
    expect(await refusalRows(key)).toEqual([]);
    fakeStripe.failLists(null);
    const accepted = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ kind: "approve", result: "refunded" });
    await mailsSettled(suite.sql, lot);
  });
});

describe("refusal schema protects the persisted request and response contract", () => {
  it("allows a missing target and provides the standard timestamps and soft-delete column", async () => {
    const target = randomUUID();
    const key = freshKey();
    await suite.sql`INSERT INTO credit_refund_refusals (id, idempotency_key, request_hash, request_kind, target_kind, target_id, requested_by, request_reason, response_status, response_body) VALUES (${randomUUID()}, ${key}, ${"0".repeat(64)}, 'reject', 'lot', ${target}, ${ADMIN}, ${REJECT.reason}, 404, ${suite.sql.json({ code: "not_found" })})`;
    const rows = await suite.sql<{ created_at: Date; updated_at: Date; deleted_at: Date | null }[]>`SELECT created_at, updated_at, deleted_at FROM credit_refund_refusals WHERE idempotency_key = ${key}`;
    expect(rows).toEqual([{ created_at: expect.any(Date), updated_at: expect.any(Date), deleted_at: null }]);
  });

  it.each([
    { label: "a server error", status: 500, body: { code: "internal_error" }, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "a transient error", status: 503, body: { code: "stripe_unavailable" }, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "a 404 with a business-conflict code", status: 404, body: { code: "lot_state_changed" }, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "an unrecordable conflict", status: 409, body: { code: "request_in_progress" }, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "a missing code", status: 404, body: {}, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "a null code", status: 404, body: { code: null }, kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "a JSON scalar", status: 404, body: "not_found", kind: "reject", target: "lot", hash: "0".repeat(64) },
    { label: "an unknown action", status: 404, body: { code: "not_found" }, kind: "other", target: "lot", hash: "0".repeat(64) },
    { label: "a mail request naming a lot", status: 404, body: { code: "not_found" }, kind: "resend_mail", target: "lot", hash: "0".repeat(64) },
    { label: "a lot request naming an operation", status: 404, body: { code: "not_found" }, kind: "reject", target: "operation", hash: "0".repeat(64) },
    { label: "a malformed fingerprint", status: 404, body: { code: "not_found" }, kind: "reject", target: "lot", hash: "A".repeat(64) },
  ])("rejects $label with a database CHECK", async ({ status, body, kind, target, hash }) => {
    await expect(suite.sql`INSERT INTO credit_refund_refusals (id, idempotency_key, request_hash, request_kind, target_kind, target_id, requested_by, request_reason, response_status, response_body) VALUES (${randomUUID()}, ${freshKey()}, ${hash}, ${kind}, ${target}, ${randomUUID()}, ${ADMIN}, ${REJECT.reason}, ${status}, ${suite.sql.json(body)})`).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps the key unique across soft deletion", async () => {
    const key = freshKey();
    const insert = (): Promise<unknown> => suite.sql`INSERT INTO credit_refund_refusals (id, idempotency_key, request_hash, request_kind, target_kind, target_id, requested_by, request_reason, response_status, response_body) VALUES (${randomUUID()}, ${key}, ${"0".repeat(64)}, 'reject', 'lot', ${randomUUID()}, ${ADMIN}, ${REJECT.reason}, 404, ${suite.sql.json({ code: "not_found" })})`;
    await insert();
    await suite.sql`UPDATE credit_refund_refusals SET deleted_at = now() WHERE idempotency_key = ${key}`;
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });
});
