// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Idempotency of the internal write endpoints (inner#1410 §4.6, §9,
 * acceptance #6), over a real socket against real Postgres and Redis.
 *
 * One key space spans dispositions and resend mail rows. A key is looked up
 * when the request arrives and again inside the write transaction, after
 * `pg_advisory_xact_lock(hashtext('internal-idem:' || key))` and `lockLot`,
 * so two requests with one key queue on the lock whatever they target. The
 * four outcomes: unseen → run; same fingerprint → replay the current
 * snapshot; different fingerprint → 422 `idempotency_key_reused`; original
 * still holding its lease (or its mail `sending`) → 409 `request_in_progress`.
 * An attempt that ends with the disposition still `started` releases its
 * lease, so a repeat after the answer went out replays (v8 round 5).
 * A request refused at a precondition stores no disposition and no key, so
 * its key stays free; the refund copies of what it read are the one thing it
 * keeps (v6 §4.6, §6.4).
 *
 * The fingerprint is `sha256(method \n route template \n target id \n
 * canonical JSON body)`, hex, kept in `request_hash`.
 */

import { createHash } from "node:crypto";
import Stripe from "stripe";
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

import { fakeStripe } from "./fake-stripe-refunds.js";
import {
  ADMIN,
  call,
  errorShape,
  freshKey,
  holdersOf,
  mailsSettled,
  paths,
  useInternalApp,
} from "./internal-api-harness.js";
import {
  PAID_CENTS,
  copiesOf,
  expectLeaseReleased,
  mailsOf,
  reId,
  refundObject,
  readOp,
  seedOperation,
  seedRefundLot,
  worldOf,
  type LotState,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("internal-api-idempotency-test");

/**
 * A lot in `state` whose payment Stripe knows, with no refunds yet.
 * @param state - Where the lot stands.
 * @returns The lot.
 */
async function lotOnStripe(state: LotState): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
  return lot;
}

/**
 * Send a signed POST under the given idempotency key (fresh nonce each time).
 * @param path - The endpoint.
 * @param body - JSON body.
 * @param key - Idempotency key.
 * @returns The answer.
 */
function post(path: string, body: unknown, key: string) {
  return call(suite.baseUrl, path, { body, idempotencyKey: key });
}

/**
 * Wait until a condition holds.
 * @param check - The condition.
 * @param timeoutMs - How long to wait.
 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const APPROVE = { reason: "Unused, within 14 days.", confirmedRefundIds: [] as string[] };
const REJECT = { reason: "Credits already used." };

describe("same key, same request: replay", () => {
  it("replays a finished approval's snapshot with its status, without reading or writing Stripe again", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const after = await worldOf(suite.sql, lot);
    const listCalls = fakeStripe.listCalls.length;

    const again = await post(paths.approve(lot.lotId), APPROVE, key);

    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(await worldOf(suite.sql, lot)).toEqual(after);
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(fakeStripe.listCalls).toHaveLength(listCalls);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("replays an approval still waiting on Stripe as 202 with the same snapshot", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    fakeStripe.nextCreate({ kind: "refund", status: "pending" });
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(202);

    const again = await post(paths.approve(lot.lotId), APPROVE, key);

    expect(again.status).toBe(202);
    expect(again.json).toEqual(first.json);
    expect(fakeStripe.createCalls).toHaveLength(1);
  });

  it("a body with the same fields in another order is the same request (canonical JSON)", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(200);

    const again = await call(suite.baseUrl, paths.approve(lot.lotId), {
      rawBody: JSON.stringify({ confirmedRefundIds: [], reason: APPROVE.reason }),
      idempotencyKey: key,
    });

    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(fakeStripe.createCalls).toHaveLength(1);
  });

  it("replays a resend: the same outbox row comes back and no second resend row is inserted", async () => {
    const lot = await lotOnStripe("refund_pending");
    const rejected = await post(paths.reject(lot.lotId), REJECT, freshKey("reject"));
    expect(rejected.status).toBe(200);
    const key = freshKey("resend");
    const first = await post(paths.resend(rejected.json.id), { reason: "Lost in spam." }, key);
    expect([200, 202]).toContain(first.status);
    await mailsSettled(suite.sql, lot);

    const again = await post(paths.resend(rejected.json.id), { reason: "Lost in spam." }, key);

    expect([200, 202]).toContain(again.status);
    expect(again.json.id).toBe(first.json.id);
    expect((await mailsOf(suite.sql, lot.lotId)).filter((m) => m.origin === "resend")).toHaveLength(1);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 1 });
  });
});

describe("same key, different request: 422 idempotency_key_reused", () => {
  it.each([
    ["another reason", (lot: SeededLot, _other: SeededLot) => ({ path: paths.approve(lot.lotId), body: { ...APPROVE, reason: "Different." } })],
    ["another lot", (_lot: SeededLot, other: SeededLot) => ({ path: paths.approve(other.lotId), body: APPROVE })],
    ["another endpoint", (lot: SeededLot, _other: SeededLot) => ({ path: paths.reject(lot.lotId), body: { reason: APPROVE.reason } })],
  ])("reusing an approval's key with %s is refused and changes nothing", async (_name, build) => {
    const lot = await lotOnStripe("refund_pending");
    const other = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    expect((await post(paths.approve(lot.lotId), APPROVE, key)).status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const lotAfter = await worldOf(suite.sql, lot);
    const otherBefore = await worldOf(suite.sql, other);

    const { path, body } = build(lot, other);
    const res = await post(path, body, key);

    expect(res.status).toBe(422);
    expect(errorShape(res.json)).toEqual({ code: "idempotency_key_reused", reason: undefined, detailTranslated: true });
    expect(await worldOf(suite.sql, lot)).toEqual(lotAfter);
    expect(await worldOf(suite.sql, other)).toEqual(otherBefore);
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("one key space: an approval's key reused for a mail resend is 422 and inserts no mail", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("shared");
    const approved = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(approved.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const mailsBefore = await mailsOf(suite.sql, lot.lotId);

    const res = await post(paths.resend(approved.json.id), { reason: "Send it again." }, key);

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("idempotency_key_reused");
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual(mailsBefore);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });
});

// Acceptance #6 refuses a key reused with another method. Every write route is
// POST, so another method never reaches the key lookup: the authorisation
// table answers 403 first. The fingerprint's own method sensitivity is pinned
// in `modules/credit-refund/__tests__/idempotency.test.ts`.
describe("same key, another method: never reaches a write", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "an approval's key sent with %s to the same path is 403 forbidden and changes nothing",
    async (method) => {
      const lot = await lotOnStripe("refund_pending");
      const key = freshKey("approve");
      expect((await post(paths.approve(lot.lotId), APPROVE, key)).status).toBe(200);
      await mailsSettled(suite.sql, lot);
      const after = await worldOf(suite.sql, lot);

      // `call` types only the methods the table uses; any other is signed the same way.
      const res = await call(suite.baseUrl, paths.approve(lot.lotId), {
        method: method as "POST",
        ...(method === "GET" ? {} : { body: APPROVE }),
        idempotencyKey: key,
      });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ code: "forbidden" });
      expect(await worldOf(suite.sql, lot)).toEqual(after);
      expect(fakeStripe.createCalls).toHaveLength(1);
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    },
  );
});

describe("same key while the original runs: 409 request_in_progress", () => {
  it("an approval whose Stripe call is still out: the repeat is 409, and the original then finishes with one create", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fakeStripe.nextCreate({ kind: "hang", until: gate, then: { kind: "refund", status: "succeeded" } });

    const original = post(paths.approve(lot.lotId), APPROVE, key);
    await until(() => fakeStripe.createCalls.length === 1);
    const repeat = await post(paths.approve(lot.lotId), APPROVE, key);
    release();
    const done = await original;

    expect(repeat.status).toBe(409);
    expect(errorShape(repeat.json)).toEqual({ code: "request_in_progress", reason: undefined, detailTranslated: true });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("an approval whose create timed out and whose lookup found nothing (E7) answered 202 started; the immediate repeat replays that snapshot, not 409 (v8 round 5, §4.6)", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");
    fakeStripe.nextCreate({
      kind: "error",
      // stripe-node builds a timeout's error with a message and no type.
      error: new Stripe.errors.StripeConnectionError({
        message: "Request was retried 0 times: timed out",
      } as ConstructorParameters<typeof Stripe.errors.StripeConnectionError>[0]),
    });

    const first = await post(paths.approve(lot.lotId), APPROVE, key);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: "started" });
    // The attempt is over: its lease ended with it, the token stays on the row.
    await expectLeaseReleased(suite.sql, first.json.id);

    const again = await post(paths.approve(lot.lotId), APPROVE, key);

    expect(again.status).toBe(202);
    expect(again.json).toEqual(first.json);
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("a resend whose row is still sending: the repeat with the same fingerprint is 409", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const op = await seedOperation(suite.sql, lot, { kind: "settle", status: "succeeded", result: "refunded" });
    const key = freshKey("resend");
    const body = { reason: "Resend please." };
    const fingerprint = createHash("sha256")
      .update(["POST", "/internal/v1/refund-operations/:operationId/mail/resend", op.id, JSON.stringify(body)].join("\n"))
      .digest("hex");
    await suite.sql`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin, requested_by, reason, idempotency_key, request_hash, status)
      VALUES (${op.id}, 'refund_completed', 'resend', ${ADMIN}, ${body.reason}, ${key}, ${fingerprint}, 'sending')
    `;

    const res = await post(paths.resend(op.id), body, key);

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("request_in_progress");
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 1 });
  });
});

describe("a refused request stores nothing, so its key stays free", () => {
  it("after a 409 the same key runs a valid request", async () => {
    const refunding = await lotOnStripe("refunding");
    await seedOperation(suite.sql, refunding, { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" });
    const pending = await lotOnStripe("refund_pending");
    const key = freshKey("reject");

    const refused = await post(paths.reject(refunding.lotId), REJECT, key);
    expect(refused.status).toBe(409);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });

    const accepted = await post(paths.reject(pending.lotId), REJECT, key);
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ lotId: pending.lotId, result: "rejected" });
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("a 409 at the judgement still keeps the copy of the succeeded refund it read, but not the key", async () => {
    const pending = await seedRefundLot(suite.sql, "refund_pending");
    const succeeded = reId("seen");
    fakeStripe.register(pending.paymentIntentId, PAID_CENTS, [refundObject(succeeded, "succeeded", 300)]);
    const free = await lotOnStripe("refund_pending");
    const key = freshKey("reject");

    const refused = await post(paths.reject(pending.lotId), REJECT, key);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "stripe_blocks", reason: "refund_succeeded" });
    expect(await copiesOf(suite.sql, pending.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: succeeded, status: "succeeded", ever_succeeded: true }),
    ]);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });

    const accepted = await post(paths.reject(free.lotId), REJECT, key);
    expect(accepted.status).toBe(200);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    await mailsSettled(suite.sql, free);
  });

  it("after a 404 the same key runs a valid request", async () => {
    const pending = await lotOnStripe("refund_pending");
    const key = freshKey("reject");

    const missing = await post(paths.reject("00000000-0000-4000-8000-0000000000cc"), REJECT, key);
    expect(missing.status).toBe(404);

    const accepted = await post(paths.reject(pending.lotId), REJECT, key);
    expect(accepted.status).toBe(200);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });

  it("after a 422 the same key runs a valid request", async () => {
    const pending = await lotOnStripe("refund_pending");
    const key = freshKey("reject");

    const invalid = await post(paths.reject(pending.lotId), { reason: "" }, key);
    expect(invalid.status).toBe(422);

    const accepted = await post(paths.reject(pending.lotId), REJECT, key);
    expect(accepted.status).toBe(200);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
  });
});

// PostgreSQL text cannot hold U+0000, so a NUL that got past the schema would
// fail the insert and answer 500. It is a malformed body: 422, nothing stored.
describe("a NUL character in the body is 422 invalid_body and stores nothing (§4.6)", () => {
  const NUL = "a\u0000b";

  it.each([
    ["the reason of a rejection", "refund_pending", (l: SeededLot) => paths.reject(l.lotId), { reason: NUL }],
    ["the reason of an approval", "refund_pending", (l: SeededLot) => paths.approve(l.lotId), { reason: NUL, confirmedRefundIds: [] }],
    ["a confirmed refund id", "refund_pending", (l: SeededLot) => paths.approve(l.lotId), { reason: "ok", confirmedRefundIds: [`re_${NUL}`] }],
    ["a failed refund id to restore credits for", "refunded", (l: SeededLot) => paths.restoreCredits(l.lotId), { reason: "ok", failedRefundIds: [`re_${NUL}`] }],
    ["a failed refund id resolved outside", "refunded", (l: SeededLot) => paths.resolvedOutside(l.lotId), { reason: "ok", failedRefundIds: [`re_${NUL}`], confirmedSucceededCents: 0 }],
  ] as const)("%s", async (_name, state, pathOf, body) => {
    const lot = await lotOnStripe(state);
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("nul");

    const res = await post(pathOf(lot), body, key);

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
    expect(await worldOf(suite.sql, lot)).toEqual(before);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("the reason of a mail resend", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const op = await seedOperation(suite.sql, lot, { kind: "settle", status: "succeeded", result: "refunded" });
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("nul");

    const res = await post(paths.resend(op.id), { reason: NUL }, key);

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
    expect(await worldOf(suite.sql, lot)).toEqual(before);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
  });
});

describe("one key, two lots, at the same time (§9)", () => {
  it("exactly one rejection runs; the other is 422 idempotency_key_reused and its lot is untouched", async () => {
    const a = await lotOnStripe("refund_pending");
    const b = await lotOnStripe("refund_pending");
    const beforeA = await worldOf(suite.sql, a);
    const beforeB = await worldOf(suite.sql, b);
    const key = freshKey("race");

    const answers = await Promise.all([post(paths.reject(a.lotId), REJECT, key), post(paths.reject(b.lotId), REJECT, key)]);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 422]);
    const winner = answers.find((r) => r.status === 200)!;
    const loser = answers.find((r) => r.status === 422)!;
    expect(loser.json.code).toBe("idempotency_key_reused");
    const winnerLot = winner.json.lotId === a.lotId ? a : b;
    const loserLot = winnerLot === a ? b : a;
    expect(await worldOf(suite.sql, loserLot)).toEqual(loserLot === a ? beforeA : beforeB);
    expect((await readOp(suite.sql, winner.json.id)).idempotency_key).toBe(key);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    await mailsSettled(suite.sql, winnerLot);
  });

  it("exactly one approval runs and Stripe sees exactly one create", async () => {
    const a = await lotOnStripe("refund_pending");
    const b = await lotOnStripe("refund_pending");
    const key = freshKey("race");

    const answers = await Promise.all([
      post(paths.approve(a.lotId), APPROVE, key),
      post(paths.approve(b.lotId), APPROVE, key),
    ]);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 1, mails: 0 });
    await mailsSettled(suite.sql, a);
    await mailsSettled(suite.sql, b);
  });
});
