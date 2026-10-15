// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending the refund mails, against real Postgres (inner#1410 §6.5, §7.1
 * step 3, §8, acceptance #13).
 *
 * Contract this suite specifies, in
 * `packages/server/src/modules/credit-refund/refund-mail.ts`:
 *
 *   - `sendRefundMail(mailId: string): Promise<boolean>` — claim (`pending` →
 *     `sending`), load the view, render with `renderRefundMail`, send through
 *     core's `sendMail`, write back `sent` / `failed` / `skipped` under
 *     `status = 'sending'`. True when the letter went out. Each row is
 *     claimed once and sent once.
 *   - `sendDueRefundMails(): Promise<unknown>` — the loop's sweep: sends every
 *     `pending` row inserted more than one minute ago; younger rows are left
 *     to the send that follows their insert.
 *   - `markStaleRefundMailsUnknown(): Promise<unknown>` — M5: `sending` rows
 *     untouched for longer than `credit-refund.yaml`'s `stale_sending_minutes`
 *     become `unknown`.
 *
 * And the wiring: once a disposition that inserted an automatic mail row has
 * committed, and once the resend endpoint has committed its row, that row is
 * sent without waiting for the loop — best effort: a mail backend that throws
 * does not change the endpoint's answer. Whether the answer waits for the send
 * is not decided by the design, so the cases poll for the row's outcome.
 *
 * A rejection letter names the time of the request that was rejected: the
 * disposition's own `refund_requested_at`, copied from the lot at E1. The
 * buyer may ask again after a rejection, which rewrites the lot's column, so
 * a resend, or an automatic row the sweep sends late, still names the
 * rejected request's time (§5.1, §8).
 *
 * The mail backend is the one thing stood in for: `sendMail` is replaced
 * with a spy; everything else in `@breatic/core` is real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { randomUUID } from "node:crypto";
import { creditLotService } from "@breatic/domain";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { transitionOperation } from "@server/modules/credit-refund/operation-transitions.js";
import { bothZones } from "@server/modules/payment/purchase-mail-template.js";
import {
  markStaleRefundMailsUnknown,
  sendDueRefundMails,
  sendRefundMail,
} from "@server/modules/credit-refund/refund-mail.js";
import * as mailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import { renderRefundMail } from "@server/modules/credit-refund/refund-mail-template.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import { call, freshKey, mailsSettled, paths, useInternalApp } from "./internal-api-harness.js";
import {
  PAID_CENTS,
  bellsOf,
  inTx,
  seedOperation,
  seedRefundLot,
  type LotState,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("refund-mail-send-test");

/** The operator's reason on every disposition here; it must never reach a buyer. */
const OPERATOR_REASON = "Operator-only note 7f3a: buyer flagged by risk review";
/** The operator's reason on a resend. */
const RESEND_REASON = "Operator-only note 9c1e: resend after bounce";

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({ status: "sent" });
});

type MailStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "unknown";

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
 * A rejected disposition with one automatic mail row, the payment carrying
 * the buyer's checkout language and zone.
 * @param status - Where the mail row stands.
 * @param insertedMinutesAgo - The row's `created_at` (and `updated_at`).
 * @returns The lot and the mail row.
 */
async function seedMail(
  status: MailStatus,
  insertedMinutesAgo = 0,
): Promise<{ lot: SeededLot; mailId: string; operationId: string }> {
  const lot = await seedRefundLot(suite.sql, "refund_pending");
  const op = await seedOperation(suite.sql, lot, { kind: "reject", status: "succeeded", result: "rejected" });
  await suite.sql`UPDATE credit_refund_operations SET reason = ${OPERATOR_REASON} WHERE id = ${op.id}`;
  const [row] = await suite.sql<{ id: string }[]>`
    INSERT INTO refund_mail_outbox (operation_id, kind, origin, status, created_at, updated_at)
    VALUES (${op.id}, 'refund_rejected', 'auto', ${status},
            now() - make_interval(mins => ${insertedMinutesAgo}::int),
            now() - make_interval(mins => ${insertedMinutesAgo}::int))
    RETURNING id
  `;
  return { lot, mailId: row!.id, operationId: op.id };
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

/**
 * The `sendMail` calls addressed to one buyer.
 * @param email - The buyer.
 * @returns Their letters, in order.
 */
function lettersTo(email: string): { to: string; subject: string; html: string; text: string }[] {
  return sendMail.mock.calls
    .map((call) => call[0] as { to: string; subject: string; html: string; text: string })
    .filter((letter) => letter.to === email);
}

/**
 * The mail rows of a lot's dispositions, oldest first.
 * @param lot - The lot.
 * @returns Id, kind, origin and status of each.
 */
async function mailsOfLot(lot: SeededLot): Promise<{ id: string; kind: string; origin: string; status: string }[]> {
  return suite.sql<{ id: string; kind: string; origin: string; status: string }[]>`
    SELECT m.id, m.kind, m.origin, m.status
    FROM refund_mail_outbox m JOIN credit_refund_operations o ON o.id = m.operation_id
    WHERE o.lot_id = ${lot.lotId} ORDER BY m.created_at, m.id
  `;
}

describe("sendRefundMail", () => {
  it("sends the rendered letter to the buyer, in their checkout language, and records sent", async () => {
    const { lot, mailId } = await seedMail("pending");
    await suite.sql`
      UPDATE payments SET metadata = ${suite.sql.json({ locale: "ja", timeZone: "Asia/Tokyo" })}
      WHERE id = ${lot.paymentId}
    `;
    const expected = await renderRefundMail((await mailRepo.getMailView(mailId))!);

    expect(await sendRefundMail(mailId)).toBe(true);

    const letters = lettersTo(await emailOf(lot));
    expect(letters).toEqual([
      { to: expected.to, subject: expected.subject, html: expected.html, text: expected.text },
    ]);
    const row = await mailState(mailId);
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
  });

  it("never puts the operator's reason in the letter", async () => {
    const { lot, mailId } = await seedMail("pending");

    await sendRefundMail(mailId);

    const [letter] = lettersTo(await emailOf(lot));
    expect(letter).toBeDefined();
    for (const body of [letter!.subject, letter!.html, letter!.text]) {
      expect(body).not.toContain(OPERATOR_REASON);
      expect(body).not.toContain("7f3a");
    }
  });

  it.each([
    ["console", { status: "backend_console", to: "x", subject: "s", html: "h" }],
    ["disabled", { status: "skipped", reason: "backend_disabled" }],
  ])("the %s backend leaves the row skipped (M4)", async (_name, answer) => {
    sendMail.mockResolvedValue(answer);
    const { mailId } = await seedMail("pending");

    expect(await sendRefundMail(mailId)).toBe(false);

    expect(await mailState(mailId)).toEqual({ status: "skipped", last_error: null, sent_at: null });
  });

  it("an SMTP error leaves the row failed with the reason (M3)", async () => {
    sendMail.mockRejectedValue(new Error("550 mailbox unavailable"));
    const { mailId } = await seedMail("pending");

    expect(await sendRefundMail(mailId)).toBe(false);

    expect(await mailState(mailId)).toEqual({ status: "failed", last_error: "550 mailbox unavailable", sent_at: null });
  });

  it.each(["sending", "sent", "failed", "skipped", "unknown"] as const)(
    "a %s row is not sent again",
    async (status) => {
      const { lot, mailId } = await seedMail(status);

      expect(await sendRefundMail(mailId)).toBe(false);

      expect(lettersTo(await emailOf(lot))).toEqual([]);
      expect((await mailState(mailId)).status).toBe(status);
    },
  );

  it("sends a row once, however many times it is asked", async () => {
    const { lot, mailId } = await seedMail("pending");

    await Promise.all([sendRefundMail(mailId), sendRefundMail(mailId)]);
    await sendRefundMail(mailId);

    expect(lettersTo(await emailOf(lot))).toHaveLength(1);
  });

  it("a write-back arriving after the row went unknown is discarded (M5, then a late M2)", async () => {
    const { lot, mailId } = await seedMail("pending");
    const stale = getCreditRefundConfig().staleSendingMinutes;
    // While the letter is out, the loop finds the row stale and moves it on.
    sendMail.mockImplementationOnce(async () => {
      await suite.sql`
        UPDATE refund_mail_outbox SET updated_at = now() - make_interval(mins => ${stale + 1}::int)
        WHERE id = ${mailId}
      `;
      await markStaleRefundMailsUnknown();
      return { status: "sent" };
    });

    await sendRefundMail(mailId);

    expect(lettersTo(await emailOf(lot))).toHaveLength(1);
    expect(await mailState(mailId)).toEqual({ status: "unknown", last_error: null, sent_at: null });
  });
});

describe("markStaleRefundMailsUnknown: the configured stale_sending_minutes", () => {
  it("moves a sending row just past the limit to unknown, and leaves one just inside it", async () => {
    const stale = getCreditRefundConfig().staleSendingMinutes;
    const past = await seedMail("sending", stale + 1);
    const inside = await seedMail("sending", Math.max(stale - 1, 0));

    await markStaleRefundMailsUnknown();

    expect((await mailState(past.mailId)).status).toBe("unknown");
    expect((await mailState(inside.mailId)).status).toBe("sending");
  });
});

describe("sendDueRefundMails: the loop's sweep (§7.1 step 3)", () => {
  it("sends pending rows inserted more than a minute ago and leaves the rest", async () => {
    const due = await seedMail("pending", 2);
    const fresh = await seedMail("pending", 0);
    const failed = await seedMail("failed", 30);
    const unknown = await seedMail("unknown", 30);

    await sendDueRefundMails();

    expect((await mailState(due.mailId)).status).toBe("sent");
    expect(lettersTo(await emailOf(due.lot))).toHaveLength(1);
    expect((await mailState(fresh.mailId)).status).toBe("pending");
    expect(lettersTo(await emailOf(fresh.lot))).toEqual([]);
    expect((await mailState(failed.mailId)).status).toBe("failed");
    expect((await mailState(unknown.mailId)).status).toBe("unknown");
    expect(lettersTo(await emailOf(failed.lot))).toEqual([]);
    expect(lettersTo(await emailOf(unknown.lot))).toEqual([]);
  });

  it("one row whose send throws does not stop the others", async () => {
    const first = await seedMail("pending", 3);
    const second = await seedMail("pending", 2);
    const firstEmail = await emailOf(first.lot);
    sendMail.mockImplementation(async (letter: { to: string }) => {
      if (letter.to === firstEmail) throw new Error("smtp refused");
      return { status: "sent" };
    });

    await sendDueRefundMails();

    expect((await mailState(first.mailId)).status).toBe("failed");
    expect((await mailState(second.mailId)).status).toBe("sent");
  });
});

describe("sent right after the disposition commits, without waiting for the loop", () => {
  /**
   * A lot in `state` whose payment Stripe knows.
   * @param state - Where the lot stands.
   * @returns The lot.
   */
  async function lotOnStripe(state: LotState): Promise<SeededLot> {
    const lot = await seedRefundLot(suite.sql, state);
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
    return lot;
  }

  /**
   * Send a signed POST with a fresh key.
   * @param path - The endpoint.
   * @param body - JSON body.
   * @returns The answer.
   */
  function post(path: string, body: unknown) {
    return call(suite.baseUrl, path, { body, idempotencyKey: freshKey() });
  }

  /**
   * Wait until every mail row of a lot has left `pending` and `sending`.
   * @param lot - The lot.
   * @param count - How many rows to expect.
   * @returns The rows.
   */
  async function settledMails(lot: SeededLot, count: number) {
    let rows: Awaited<ReturnType<typeof mailsOfLot>> = [];
    await vi.waitFor(
      async () => {
        rows = await mailsOfLot(lot);
        expect(rows).toHaveLength(count);
        for (const row of rows) expect(["pending", "sending"]).not.toContain(row.status);
      },
      { timeout: 10_000, interval: 50 },
    );
    return rows;
  }

  it("a rejection's mail goes out to the buyer, and carries no operator reason", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.reject(lot.lotId), { reason: OPERATOR_REASON });

    expect(res.status).toBe(200);
    const rows = await settledMails(lot, 1);
    expect(rows[0]).toMatchObject({ kind: "refund_rejected", origin: "auto", status: "sent" });
    const letters = lettersTo(await emailOf(lot));
    expect(letters).toHaveLength(1);
    for (const body of [letters[0]!.subject, letters[0]!.html, letters[0]!.text]) {
      expect(body).not.toContain(OPERATOR_REASON);
    }
  });

  it("an approval that Stripe refunds at once sends the completed mail", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.approve(lot.lotId), { reason: OPERATOR_REASON, confirmedRefundIds: [] });

    expect(res.status).toBe(200);
    expect(res.json.result).toBe("refunded");
    const rows = await settledMails(lot, 1);
    expect(rows[0]).toMatchObject({ kind: "refund_completed", origin: "auto", status: "sent" });
    expect(lettersTo(await emailOf(lot))).toHaveLength(1);
  });

  it("a resend's row goes out once its request commits, beside the automatic one", async () => {
    const lot = await lotOnStripe("refund_pending");
    const rejected = await post(paths.reject(lot.lotId), { reason: OPERATOR_REASON });
    expect(rejected.status).toBe(200);
    await settledMails(lot, 1);

    const res = await post(paths.resend(rejected.json.id), { reason: RESEND_REASON });

    expect([200, 202]).toContain(res.status);
    const rows = await settledMails(lot, 2);
    expect(rows.map((r) => [r.origin, r.status])).toEqual([
      ["auto", "sent"],
      ["resend", "sent"],
    ]);
    const letters = lettersTo(await emailOf(lot));
    expect(letters).toHaveLength(2);
    for (const body of [letters[1]!.subject, letters[1]!.html, letters[1]!.text]) {
      expect(body).not.toContain(RESEND_REASON);
    }
  });

  it("a mail backend that throws does not change the disposition's answer", async () => {
    sendMail.mockRejectedValue(new Error("smtp refused"));
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.reject(lot.lotId), { reason: OPERATOR_REASON });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "succeeded", result: "rejected" });
    const rows = await settledMails(lot, 1);
    expect(rows[0]!.status).toBe("failed");
  });
});

describe("a rejection letter names the rejected request's time, after the buyer asked again (§5.1, §8)", () => {
  /** When the rejected request was made; days before any later ask. */
  const REJECTED_ASK = new Date("2026-09-03T02:45:00.000Z");

  /** When the pack was bought; apart from both request times, so no letter line is mistaken for another. */
  const PURCHASED = new Date("2026-09-01T01:30:00.000Z");

  /**
   * A `refund_pending` lot whose payment Stripe knows, bought at
   * {@link PURCHASED} and asked at {@link REJECTED_ASK}.
   * @returns The lot.
   */
  async function askedLot(): Promise<SeededLot> {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
    await suite.sql`
      UPDATE credit_lots SET refund_requested_at = ${REJECTED_ASK}, created_at = ${PURCHASED}
      WHERE id = ${lot.lotId}
    `;
    return lot;
  }

  /**
   * The buyer asks again; returns the new request's time.
   * @param lot - The lot, back to `active` after the rejection.
   * @returns The lot's `refund_requested_at` now.
   */
  async function askAgain(lot: SeededLot): Promise<Date> {
    await creditLotService.requestRefund({ lotId: lot.lotId, requestingUserId: lot.userId });
    const [row] = await suite.sql<{ at: Date }[]>`
      SELECT refund_requested_at AS at FROM credit_lots WHERE id = ${lot.lotId}
    `;
    expect(row!.at.getTime()).not.toBe(REJECTED_ASK.getTime());
    return row!.at;
  }

  /**
   * Assert a letter names one request time and not the other. The payment
   * stores no language or zone, so the letter is English in UTC.
   * @param text - The letter's plain-text part.
   * @param named - The time it must name.
   * @param notNamed - The time it must not name.
   */
  function expectNames(text: string, named: Date, notNamed: Date): void {
    expect(text).toContain(bothZones(named, "UTC", "en"));
    expect(text).not.toContain(bothZones(notNamed, "UTC", "en"));
  }

  it("a resend through the endpoint", async () => {
    const lot = await askedLot();
    const rejected = await call(suite.baseUrl, paths.reject(lot.lotId), {
      body: { reason: OPERATOR_REASON },
      idempotencyKey: freshKey(),
    });
    expect(rejected.status).toBe(200);
    await vi.waitFor(async () => expect(await mailsOfLot(lot)).toHaveLength(1));
    await mailsSettled(suite.sql, lot);
    const later = await askAgain(lot);

    const res = await call(suite.baseUrl, paths.resend(rejected.json.id), {
      body: { reason: RESEND_REASON },
      idempotencyKey: freshKey(),
    });

    expect([200, 202]).toContain(res.status);
    await vi.waitFor(async () => expect(await mailsOfLot(lot)).toHaveLength(2));
    await mailsSettled(suite.sql, lot);
    const letters = lettersTo(await emailOf(lot));
    expect(letters).toHaveLength(2);
    expectNames(letters[0]!.text, REJECTED_ASK, later);
    expectNames(letters[1]!.text, REJECTED_ASK, later);
  });

  it("an automatic row the loop's sweep sends after the re-ask", async () => {
    const lot = await askedLot();
    // E1 as the endpoint's phase 1 runs it; no send follows, so the row waits
    // for the sweep.
    const op = await inTx((tx) =>
      transitionOperation(tx, null, {
        type: "E1",
        create: {
          kind: "reject",
          lotId: lot.lotId,
          paymentId: lot.paymentId,
          idempotencyKey: `idem-${randomUUID()}`,
          requestHash: "a".repeat(64),
          requestedBy: "admin_7",
          reason: OPERATOR_REASON,
        },
        actor: "request",
      }),
    );
    const later = await askAgain(lot);
    await suite.sql`
      UPDATE refund_mail_outbox SET created_at = now() - interval '2 minutes', updated_at = now() - interval '2 minutes'
      WHERE operation_id = ${op!.id}
    `;

    await sendDueRefundMails();

    const letters = lettersTo(await emailOf(lot));
    expect(letters).toHaveLength(1);
    expectNames(letters[0]!.text, REJECTED_ASK, later);
  });
});

describe("the bell tells the buyer whatever the mail does, and the operator can resend (§5.5, §6.5, acceptance #13)", () => {
  const cases = [
    { kind: "reject", ending: "failed", result: "rejected", mail: "refund_rejected", bell: "credit.refund_rejected" },
    { kind: "reject", ending: "unknown", result: "rejected", mail: "refund_rejected", bell: "credit.refund_rejected" },
    { kind: "approve", ending: "failed", result: "refunded", mail: "refund_completed", bell: "credit.refund_completed" },
    { kind: "approve", ending: "unknown", result: "refunded", mail: "refund_completed", bell: "credit.refund_completed" },
  ] as const;

  it.each(cases)(
    "$kind whose automatic mail ends $ending: the answer is $result, the bell is written, and a resend goes out",
    async ({ kind, ending, result, mail, bell }) => {
      const lot = await seedRefundLot(suite.sql, "refund_pending");
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, []);
      const email = await emailOf(lot);
      const stale = getCreditRefundConfig().staleSendingMinutes;
      let first = true;
      sendMail.mockImplementation(async (letter: { to: string }) => {
        if (letter.to !== email || !first) return { status: "sent" };
        first = false;
        if (ending === "failed") throw new Error("smtp refused");
        // While the letter is out, the loop finds the row stale (M5); the
        // send's write-back then lands on an unknown row and is discarded.
        await suite.sql`
          UPDATE refund_mail_outbox m SET updated_at = now() - make_interval(mins => ${stale + 1}::int)
          FROM credit_refund_operations o
          WHERE o.id = m.operation_id AND o.lot_id = ${lot.lotId} AND m.status = 'sending'
        `;
        await markStaleRefundMailsUnknown();
        return { status: "sent" };
      });

      const res = await call(suite.baseUrl, kind === "reject" ? paths.reject(lot.lotId) : paths.approve(lot.lotId), {
        body: kind === "reject" ? { reason: OPERATOR_REASON } : { reason: OPERATOR_REASON, confirmedRefundIds: [] },
        idempotencyKey: freshKey(),
      });

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ kind, status: "succeeded", result });
      if (kind === "approve") expect(res.json.stripeRefundId).toBe(fakeStripe.refundsOf(lot.paymentIntentId)[0]!.id);
      await vi.waitFor(async () => expect(await mailsOfLot(lot)).toHaveLength(1));
      await mailsSettled(suite.sql, lot);
      expect((await mailsOfLot(lot)).map((m) => [m.kind, m.origin, m.status])).toEqual([[mail, "auto", ending]]);
      expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual([bell]);

      const resent = await call(suite.baseUrl, paths.resend(res.json.id), {
        body: { reason: RESEND_REASON },
        idempotencyKey: freshKey(),
      });

      expect([200, 202]).toContain(resent.status);
      await vi.waitFor(async () => expect(await mailsOfLot(lot)).toHaveLength(2));
      await mailsSettled(suite.sql, lot);
      expect((await mailsOfLot(lot)).map((m) => [m.kind, m.origin, m.status])).toEqual([
        [mail, "auto", ending],
        [mail, "resend", "sent"],
      ]);
      expect(lettersTo(email)).toHaveLength(2);
      expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual([bell]);
    },
  );
});
