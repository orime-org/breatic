// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund mail outbox row against real Postgres (inner#1410 §6.5, §8, §9).
 *
 * Contract this suite specifies, in
 * `packages/server/src/modules/credit-refund/refund-mail.repo.ts`:
 *
 *   - `claimSend(mailId: string): Promise<boolean>` — M1: `pending` →
 *     `sending`, stamping `updated_at`; true when this caller took the row.
 *     Only `pending` is claimable — unlike the purchase confirmation, a stale
 *     `sending` row is NOT taken over (it becomes `unknown`, M5), because each
 *     row is claimed once and sent once; a resend is a new row.
 *   - `recordSend(mailId: string, status: "sent" | "failed" | "skipped",
 *     lastError?: string): Promise<boolean>` — M2/M3/M4, written only under
 *     `status = 'sending'`; `sent` stamps `sent_at`, `failed` writes
 *     `last_error`. False (and nothing changed) when the row is not
 *     `sending` — the late write-back after `unknown` is discarded.
 *   - `markStaleUnknown(staleBefore: Date): Promise<number>` — M5: every
 *     `sending` row whose `updated_at` is before `staleBefore` → `unknown`.
 *   - `getMailView(mailId: string): Promise<RefundMailView | null>` — what the
 *     letter says (§8), from our own rows: the buyer's address, the language
 *     and zone stored on the payment (`payments.metadata.locale` /
 *     `.timeZone`, `en` / `UTC` when absent, as `getConfirmationView` does),
 *     the order reference (`payments.id`), the credits, the purchase time;
 *     for `refund_completed` the amount and currency told on the bell and the
 *     refund time; for `refund_rejected` the disposition's own
 *     `credit_refund_operations.refund_requested_at` — the time of the
 *     request that was rejected, not the lot's column, which the buyer's next
 *     ask overwrites (§5.1, §8).
 *
 * And, in `operation-transitions.ts`: E1 copies the locked lot's
 * `refund_requested_at` into the new disposition's `refund_requested_at`
 * (timestamptz) for every kind; nothing changes it afterwards (§5.1).
 *
 * Every row a case starts from is written by SQL, so no case depends on the
 * disposition code having worked, except the cases that drive E1 itself.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";

import { creditLotService } from "@breatic/domain";
import { transitionOperation, type NewOperation } from "@server/modules/credit-refund/operation-transitions.js";
import * as mailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import {
  CREDITS,
  PAID_CENTS,
  inTx,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  type LotState,
  type OpKind,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("refund-mail-outbox-test");

type MailStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "unknown";

interface SeededMail {
  lot: SeededLot;
  operationId: string;
  mailId: string;
}

/**
 * A rejected disposition with one automatic mail row in `status`.
 * @param status - Where the mail row stands.
 * @returns The lot, the disposition and the mail row.
 */
async function seedMail(status: MailStatus): Promise<SeededMail> {
  const lot = await seedRefundLot(suite.sql, "refund_pending");
  const op = await seedOperation(suite.sql, lot, { kind: "reject", status: "succeeded", result: "rejected" });
  const [row] = await suite.sql<{ id: string }[]>`
    INSERT INTO refund_mail_outbox (operation_id, kind, origin, status)
    VALUES (${op.id}, 'refund_rejected', 'auto', ${status}) RETURNING id
  `;
  return { lot, operationId: op.id, mailId: row!.id };
}

interface MailState {
  status: string;
  last_error: string | null;
  sent_at: Date | null;
}

/**
 * Where one mail row stands.
 * @param mailId - The row.
 * @returns Its status, error and send time.
 */
async function mailState(mailId: string): Promise<MailState> {
  const [row] = await suite.sql<MailState[]>`
    SELECT status, last_error, sent_at FROM refund_mail_outbox WHERE id = ${mailId}
  `;
  return row!;
}

/**
 * Push a row's `updated_at` back, as though it had been touched that long ago.
 * @param mailId - The row.
 * @param minutes - How long ago.
 */
async function age(mailId: string, minutes: number): Promise<void> {
  await suite.sql`
    UPDATE refund_mail_outbox SET updated_at = now() - make_interval(mins => ${minutes}::int)
    WHERE id = ${mailId}
  `;
}

/** Ten minutes ago: the cutoff the cases pass for "stale". */
function tenMinutesAgo(): Date {
  return new Date(Date.now() - 10 * 60 * 1000);
}

const UNKNOWN_MAIL = "00000000-0000-4000-8000-0000000000cc";

/** The time of a request that gets rejected; days before any later ask. */
const REJECTED_ASK = new Date("2026-09-03T02:45:00.000Z");

/**
 * Put the lot's request time where a case wants it, as though the buyer had
 * asked then.
 * @param lot - The lot.
 * @param at - The request time.
 */
async function setLotAskedAt(lot: SeededLot, at: Date): Promise<void> {
  await suite.sql`UPDATE credit_lots SET refund_requested_at = ${at} WHERE id = ${lot.lotId}`;
}

/**
 * The request time a disposition carries.
 * @param operationId - The disposition.
 * @returns Its `refund_requested_at`.
 */
async function opAskedAt(operationId: string): Promise<Date | null> {
  const [row] = await suite.sql<{ at: Date | null }[]>`
    SELECT refund_requested_at AS at FROM credit_refund_operations WHERE id = ${operationId}
  `;
  return row!.at;
}

/**
 * Run E1 for one kind on one lot, the way the internal API's phase 1 does.
 * @param lot - The lot.
 * @param kind - The disposition kind.
 * @param extra - Request fields beyond the common ones.
 * @returns The new disposition's id.
 */
async function runE1(lot: SeededLot, kind: OpKind, extra: Partial<NewOperation> = {}): Promise<string> {
  const op = await inTx((tx) =>
    transitionOperation(tx, null, {
      type: "E1",
      create: {
        kind,
        lotId: lot.lotId,
        paymentId: lot.paymentId,
        idempotencyKey: `idem-${randomUUID()}`,
        requestHash: "a".repeat(64),
        requestedBy: "admin_7",
        reason: "buyer wrote in",
        ...extra,
      },
      actor: "request",
    }),
  );
  return op!.id;
}

describe("claimSend: which rows may be claimed (M1)", () => {
  it.each([
    ["pending", true],
    ["sending", false],
    ["sent", false],
    ["failed", false],
    ["skipped", false],
    ["unknown", false],
  ] as const)("a %s row: %s", async (status, allowed) => {
    const { mailId } = await seedMail(status);

    expect(await mailRepo.claimSend(mailId)).toBe(allowed);
    expect((await mailState(mailId)).status).toBe(allowed ? "sending" : status);
  });

  it("does not take over a send that has been in flight too long; that row is M5's", async () => {
    const { mailId } = await seedMail("sending");
    await age(mailId, 60);

    expect(await mailRepo.claimSend(mailId)).toBe(false);
    expect((await mailState(mailId)).status).toBe("sending");
  });

  it("claims nothing for a row that does not exist", async () => {
    expect(await mailRepo.claimSend(UNKNOWN_MAIL)).toBe(false);
  });

  it("lets exactly one of two racing callers through", async () => {
    const { mailId } = await seedMail("pending");

    const results = await Promise.all([mailRepo.claimSend(mailId), mailRepo.claimSend(mailId)]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("starts the stale clock at the claim, not at the insert", async () => {
    const { mailId } = await seedMail("pending");
    await age(mailId, 60);

    expect(await mailRepo.claimSend(mailId)).toBe(true);
    await mailRepo.markStaleUnknown(tenMinutesAgo());

    expect((await mailState(mailId)).status).toBe("sending");
  });
});

describe("recordSend: writing back where the send landed (M2, M3, M4)", () => {
  it("sent: stamps sent_at, no error", async () => {
    const { mailId } = await seedMail("pending");
    await mailRepo.claimSend(mailId);
    const before = Date.now();

    expect(await mailRepo.recordSend(mailId, "sent")).toBe(true);

    const row = await mailState(mailId);
    expect(row.status).toBe("sent");
    expect(row.last_error).toBeNull();
    expect(row.sent_at).not.toBeNull();
    expect(row.sent_at!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("failed: keeps the reason, no sent_at", async () => {
    const { mailId } = await seedMail("pending");
    await mailRepo.claimSend(mailId);

    expect(await mailRepo.recordSend(mailId, "failed", "smtp refused")).toBe(true);

    expect(await mailState(mailId)).toEqual({ status: "failed", last_error: "smtp refused", sent_at: null });
  });

  it("skipped: no sent_at", async () => {
    const { mailId } = await seedMail("pending");
    await mailRepo.claimSend(mailId);

    expect(await mailRepo.recordSend(mailId, "skipped")).toBe(true);

    expect(await mailState(mailId)).toEqual({ status: "skipped", last_error: null, sent_at: null });
  });

  it.each(["sent", "failed", "skipped"] as const)(
    "a late %s after the row went unknown is discarded",
    async (status) => {
      const { mailId } = await seedMail("pending");
      await mailRepo.claimSend(mailId);
      await age(mailId, 60);
      await mailRepo.markStaleUnknown(tenMinutesAgo());
      expect((await mailState(mailId)).status).toBe("unknown");

      expect(await mailRepo.recordSend(mailId, status, status === "failed" ? "socket timeout" : undefined)).toBe(false);

      expect(await mailState(mailId)).toEqual({ status: "unknown", last_error: null, sent_at: null });
    },
  );

  it("writes nothing on a row that was never claimed", async () => {
    const { mailId } = await seedMail("pending");

    expect(await mailRepo.recordSend(mailId, "sent")).toBe(false);

    expect(await mailState(mailId)).toEqual({ status: "pending", last_error: null, sent_at: null });
  });

  it("a second write-back after the first landed changes nothing", async () => {
    const { mailId } = await seedMail("pending");
    await mailRepo.claimSend(mailId);
    await mailRepo.recordSend(mailId, "sent");
    const first = await mailState(mailId);

    expect(await mailRepo.recordSend(mailId, "failed", "late")).toBe(false);

    expect(await mailState(mailId)).toEqual(first);
  });
});

describe("markStaleUnknown: a send nobody wrote back (M5)", () => {
  it("moves a sending row older than the cutoff to unknown", async () => {
    const { mailId } = await seedMail("sending");
    await age(mailId, 30);

    await mailRepo.markStaleUnknown(tenMinutesAgo());

    expect(await mailState(mailId)).toEqual({ status: "unknown", last_error: null, sent_at: null });
  });

  it("leaves a sending row younger than the cutoff", async () => {
    const { mailId } = await seedMail("sending");
    await age(mailId, 5);

    await mailRepo.markStaleUnknown(tenMinutesAgo());

    expect((await mailState(mailId)).status).toBe("sending");
  });

  it.each(["pending", "sent", "failed", "skipped"] as const)("leaves an old %s row alone", async (status) => {
    const { mailId } = await seedMail(status);
    await age(mailId, 30);

    await mailRepo.markStaleUnknown(tenMinutesAgo());

    expect((await mailState(mailId)).status).toBe(status);
  });
});

describe("getMailView: what the letter says, from our own rows (§8)", () => {
  /**
   * Store the buyer's checkout language and zone on the payment.
   * @param lot - The lot whose payment it is.
   * @param metadata - What to store.
   */
  async function setMetadata(lot: SeededLot, metadata: Record<string, string>): Promise<void> {
    await suite.sql`UPDATE payments SET metadata = ${suite.sql.json(metadata)} WHERE id = ${lot.paymentId}`;
  }

  /**
   * The buyer's address.
   * @param lot - The lot.
   * @returns The email.
   */
  async function emailOf(lot: SeededLot): Promise<string> {
    const [row] = await suite.sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${lot.userId}`;
    return row!.email;
  }

  it("a rejection: address, language and zone from the payment, order ref, credits, purchase time, and the disposition's request time", async () => {
    const before = new Date(Date.now() - 5_000);
    const { lot, operationId, mailId } = await seedMail("pending");
    const after = new Date(Date.now() + 5_000);
    await setMetadata(lot, { locale: "ja", timeZone: "Asia/Tokyo" });
    // The disposition's copy differs from the lot's column, so the view
    // shows which one it read.
    await suite.sql`
      UPDATE credit_refund_operations SET refund_requested_at = ${REJECTED_ASK} WHERE id = ${operationId}
    `;
    const asked = { at: REJECTED_ASK };

    const view = await mailRepo.getMailView(mailId);

    expect(view).toMatchObject({
      kind: "refund_rejected",
      email: await emailOf(lot),
      locale: "ja",
      timeZone: "Asia/Tokyo",
      paymentId: lot.paymentId,
      credits: CREDITS,
    });
    expect(view!.kind === "refund_rejected" && view!.requestedAt.getTime()).toBe(asked.at.getTime());
    // Which column the purchase time is read from is not decided by the
    // design; it is the moment this purchase was made.
    expect(view!.purchasedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(view!.purchasedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("a completed refund: the amount told on the bell (the settled sum) and the payment's currency", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const op = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "refunded" });
    await suite.sql`
      UPDATE credit_refund_operations SET settled_succeeded_cents = ${PAID_CENTS} WHERE id = ${op.id}
    `;
    const [mail] = await suite.sql<{ id: string }[]>`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin)
      VALUES (${op.id}, 'refund_completed', 'auto') RETURNING id
    `;
    const [finished] = await suite.sql<{ at: Date }[]>`
      SELECT finished_at AS at FROM credit_refund_operations WHERE id = ${op.id}
    `;

    const view = await mailRepo.getMailView(mail!.id);

    expect(view).toMatchObject({
      kind: "refund_completed",
      email: await emailOf(lot),
      paymentId: lot.paymentId,
      credits: CREDITS,
      amountCents: PAID_CENTS,
      currency: "usd",
    });
    // The refund time is a moment no earlier than the disposition finished;
    // which column carries it is not decided by the design.
    expect(view!.kind === "refund_completed" && view!.refundedAt instanceof Date).toBe(true);
    expect(Math.abs((view as { refundedAt: Date }).refundedAt.getTime() - finished!.at.getTime())).toBeLessThan(60_000);
  });

  it("a restored lot (v9 §8): credits, order ref, purchase time and the disposition's request time, kind refund_restored", async () => {
    const lot = await seedRefundLot(suite.sql, "active");
    const op = await seedOperation(suite.sql, lot, { kind: "restore_credits", status: "succeeded", result: "restored" });
    await suite.sql`UPDATE credit_refund_operations SET refund_requested_at = ${REJECTED_ASK} WHERE id = ${op.id}`;
    const [mail] = await suite.sql<{ id: string }[]>`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin)
      VALUES (${op.id}, 'refund_restored', 'auto') RETURNING id
    `;

    const view = await mailRepo.getMailView(mail!.id);

    expect(view).toMatchObject({
      kind: "refund_restored",
      email: await emailOf(lot),
      paymentId: lot.paymentId,
      credits: CREDITS,
    });
    expect((view as unknown as { requestedAt: Date }).requestedAt.toISOString()).toBe(REJECTED_ASK.toISOString());
  });

  it("a payment with no stored language or zone reads as en and UTC", async () => {
    const { lot, mailId } = await seedMail("pending");
    await setMetadata(lot, {});

    expect(await mailRepo.getMailView(mailId)).toMatchObject({ locale: "en", timeZone: "UTC" });
  });

  it("a resend row reads the same letter as the automatic one", async () => {
    const { operationId, mailId } = await seedMail("sent");
    const [resend] = await suite.sql<{ id: string }[]>`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin, requested_by, reason, idempotency_key, request_hash)
      VALUES (${operationId}, 'refund_rejected', 'resend', 'admin_7', 'Buyer asked again.',
              ${`resend-${mailId}`}, ${"0".repeat(64)})
      RETURNING id
    `;

    expect(await mailRepo.getMailView(resend!.id)).toEqual(await mailRepo.getMailView(mailId));
  });

  it("no row, no view", async () => {
    expect(await mailRepo.getMailView(UNKNOWN_MAIL)).toBeNull();
  });

  it("a rejection read after the buyer asked again still names the rejected request's time", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    await setLotAskedAt(lot, REJECTED_ASK);
    const operationId = await runE1(lot, "reject");
    const [auto] = await suite.sql<{ id: string }[]>`
      SELECT id FROM refund_mail_outbox WHERE operation_id = ${operationId} AND origin = 'auto'
    `;
    const [resend] = await suite.sql<{ id: string }[]>`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin, requested_by, reason, idempotency_key, request_hash)
      VALUES (${operationId}, 'refund_rejected', 'resend', 'admin_7', 'Buyer never got it.',
              ${`resend-${randomUUID()}`}, ${"0".repeat(64)})
      RETURNING id
    `;

    // The buyer asks again: the lot's column now holds the new request's time.
    await creditLotService.requestRefund({ lotId: lot.lotId, requestingUserId: lot.userId });
    const [lotNow] = await suite.sql<{ at: Date }[]>`
      SELECT refund_requested_at AS at FROM credit_lots WHERE id = ${lot.lotId}
    `;
    expect(lotNow!.at.getTime()).not.toBe(REJECTED_ASK.getTime());

    for (const mailId of [auto!.id, resend!.id]) {
      const view = await mailRepo.getMailView(mailId);
      expect(view?.kind).toBe("refund_rejected");
      expect(view!.kind === "refund_rejected" && view!.requestedAt.toISOString()).toBe(REJECTED_ASK.toISOString());
    }
  });
});

describe("refund_requested_at on the disposition: copied from the lot at E1 (§5.1)", () => {
  it("is a timestamptz column of credit_refund_operations", async () => {
    const [column] = await suite.sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'credit_refund_operations' AND column_name = 'refund_requested_at'
    `;

    expect(column?.data_type).toBe("timestamp with time zone");
  });

  /**
   * A lot ready for one kind's E1: the state the kind starts from, and for
   * settle a succeeded refund to book on.
   */
  const READY: Record<OpKind, { state: LotState; extra?: Partial<NewOperation> }> = {
    approve: { state: "refund_pending", extra: { confirmedRefundIds: [] } },
    reject: { state: "refund_pending" },
    settle: { state: "refunding", extra: { notify: false, confirmedSucceededCents: PAID_CENTS } },
    send_back: { state: "refunding" },
    retry: { state: "refunding", extra: { confirmedRefundIds: [] } },
    resolve_outside: { state: "refunded", extra: { failedRefundIds: [] } },
    restore_credits: { state: "refunding", extra: { failedRefundIds: [] } },
  };

  it.each(Object.keys(READY) as OpKind[])("%s: the new row carries the lot's request time", async (kind) => {
    const { state, extra } = READY[kind];
    const lot = await seedRefundLot(suite.sql, state);
    if (kind === "settle") await seedCopy(suite.sql, lot, { id: reId("settle"), amountCents: PAID_CENTS, status: "succeeded" });
    await setLotAskedAt(lot, REJECTED_ASK);

    const operationId = await runE1(lot, kind, extra);

    expect((await opAskedAt(operationId))?.toISOString()).toBe(REJECTED_ASK.toISOString());
  });

  it("the copy stays when the buyer asks again after a rejection", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    await setLotAskedAt(lot, REJECTED_ASK);
    const operationId = await runE1(lot, "reject");

    await creditLotService.requestRefund({ lotId: lot.lotId, requestingUserId: lot.userId });

    expect((await opAskedAt(operationId))?.toISOString()).toBe(REJECTED_ASK.toISOString());
  });
});
