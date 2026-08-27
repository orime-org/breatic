// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one transaction that grants a top-up (task #13 §4.3) — real PG, doubled
 * Stripe client.
 *
 * `fulfillPayment(sessionId, eventId | null)` has four callers: the
 * return-side confirmation endpoint, the webhook, the overlay reconciliation
 * pass, and the branch cancel takes when it reads the session as already
 * paid. All four go through the same function, so every assertion below is
 * really the same one: whoever gets there first, there is only one outcome.
 *
 * Two idempotency guards each cover a different half, and that split is the
 * easiest thing to get wrong at this layer:
 *
 * 1. **The claim stops the same event being delivered twice.** Stripe
 *    delivers at least once, so redelivery is routine. The claim and the
 *    grant share one transaction — the same shape the membership leg uses
 *    (`subscription-events.ts:286`) and what the note in `schema.ts` says to
 *    do. Committing the claim first and granting in a separate transaction is
 *    wrong: once the grant fails, the event is already marked handled, every
 *    redelivery over the next three days short-circuits, and the money is in
 *    while the credits never arrive.
 *
 * 2. **The CAS stops two of the four callers racing each other.** The webhook
 *    and the confirmation endpoint can both read `paid` in the same second
 *    holding different events, or no event at all; the claim cannot separate
 *    them, so the CAS on `payments.status` is what lets exactly one win.
 *
 * 3. **The confirmation mail goes out only on the pass that actually created
 *    the lot.** Every caller runs the transaction to completion and commits,
 *    including the passes that wrote nothing (claim collided, or CAS did not
 *    match and the answer was `replay`) — and `replay` is the common path:
 *    the confirmation endpoint grants first, the webhook lands seconds later,
 *    claims successfully, and finds the CAS no longer matching. Without that
 *    condition, every purchase where the endpoint beats the webhook sends two
 *    emails.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  inject,
  vi,
} from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

const stripe = {
  checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

// The send is a double so the suite can assert it was reached exactly once
// per granted purchase. Counting is the whole point of the third promise
// above: a replay commits its transaction like any other caller.
const sentMail = vi.fn();

vi.mock("@server/modules/payment/purchase-mail.js", () => ({
  sendPurchaseConfirmation: (...args: unknown[]) => sentMail(...args),
}));

import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import {
  fulfillPayment,
  handlePaymentFailed,
} from "@server/modules/payment/payment.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "topup-fulfillment-test" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Wait until the confirmation send has reached its double.
 * @param count - How many sends to wait for.
 */
async function waitForMail(count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (sentMail.mock.calls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A user with one pending payment; returns the ids and the session id. */
async function seedPending(): Promise<{
  userId: string;
  paymentId: string;
  sessionId: string;
}> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const sessionId = `cs_test_fulfil_${stamp}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`fulfil-${stamp}@example.test`}, true) RETURNING id
  `;
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, stripe_session_id, amount_cents, credits_granted, currency, status)
    VALUES (${user!.id}, ${sessionId}, 2000, 1700, 'usd', 'pending')
    RETURNING id
  `;
  return { userId: user!.id, paymentId: payment!.id, sessionId };
}

/** Removes an account and everything hanging off it. */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM credit_ledger WHERE payer_user_id = ${userId}`;
  await sql`DELETE FROM credit_lots WHERE user_id = ${userId}`;
  await sql`DELETE FROM purchase_mail_outbox WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM purchase_consents WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/**
 * A webhook event.
 *
 * The claim records the id and the type together, so both travel as one
 * argument. Defaults to `checkout.session.completed`, the most common of the
 * four types.
 * @param id - The event's own id; this is what the claim deduplicates on.
 * @param type - The event type.
 * @returns That event.
 */
function evt(
  id: string,
  type = "checkout.session.completed",
): { id: string; type: string } {
  return { id, type };
}

/** A paid Checkout Session as the SDK returns it. */
function paidSession(
  sessionId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: sessionId,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_subtotal: 2000,
    amount_total: 2240,
    currency: "usd",
    total_details: { amount_tax: 240 },
    payment_intent: `pi_${sessionId}`,
    consent: { terms_of_service: "accepted" },
    metadata: { locale: "en", consent_text_version: "v1" },
    ...over,
  };
}

/** How many lots and ledger rows this account holds. */
async function countsFor(
  userId: string,
): Promise<{ lots: number; ledger: number; mail: number; consents: number }> {
  const [lots] =
    await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_lots WHERE user_id = ${userId}`;
  const [ledger] =
    await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_ledger WHERE payer_user_id = ${userId}`;
  const [mail] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM purchase_mail_outbox
    WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})
  `;
  const [consents] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM purchase_consents
    WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})
  `;
  return {
    lots: lots!.n,
    ledger: ledger!.n,
    mail: mail!.n,
    consents: consents!.n,
  };
}

describe("one paid session grants exactly once", () => {
  it("writes the lot, its ledger row, the consent and the outbox row together", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      const outcome = await fulfillPayment(sessionId, evt(`evt_${sessionId}`));

      expect(outcome.status).toBe("granted");
      expect(await countsFor(userId)).toEqual({
        lots: 1,
        ledger: 1,
        mail: 1,
        consents: 1,
      });

      const [row] = await sql<
        { status: string; tax_cents: number; total_cents: number }[]
      >`
        SELECT status, tax_cents, total_cents FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("completed");
      expect(row!.tax_cents).toBe(240);
      expect(row!.total_cents).toBe(2240);
    } finally {
      await dropUser(userId);
    }
  });

  it("sends the confirmation once, and only for the pass that granted", async () => {
    const { userId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      await fulfillPayment(sessionId, null);
      // The send is deliberately not awaited — a request must never wait on
      // SMTP, which is what §4.5 promises. So wait for it to reach the double
      // on its own rather than asserting it has already finished.
      await waitForMail(1);
      expect(sentMail).toHaveBeenCalledTimes(1);

      // The webhook arrives seconds later with an event id of its own: the
      // claim succeeds, the CAS no longer matches, and this pass wrote
      // nothing. It must not mail again.
      const replay = await fulfillPayment(sessionId, evt(`evt_${sessionId}`));
      expect(replay.status).toBe("replay");
      // Give a second send the same chance to happen; not happening is the
      // correct outcome.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sentMail).toHaveBeenCalledTimes(1);
    } finally {
      await dropUser(userId);
    }
  });
});

describe("the two guards cover different things", () => {
  it("claiming stops the same event delivered twice", async () => {
    const { userId, sessionId } = await seedPending();
    const eventId = `evt_dup_${sessionId}`;
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      const first = await fulfillPayment(sessionId, evt(eventId));
      const second = await fulfillPayment(sessionId, evt(eventId));

      expect(first.status).toBe("granted");
      expect(second.status).toBe("replay");
      const counts = await countsFor(userId);
      expect(counts.lots).toBe(1);
      expect(counts.ledger).toBe(1);

      // Asserted on the claim itself. The CAS alone would produce the same
      // three figures above, so without this the case would stay green with
      // the claim removed — and the claim is also what carries the event's
      // type into the audit table.
      const [claim] = await sql<{ n: number; type: string }[]>`
        SELECT count(*)::int AS n, max(type) AS type
        FROM stripe_webhook_events WHERE event_id = ${eventId}
      `;
      expect(claim!.n).toBe(1);
      expect(claim!.type).toBe("checkout.session.completed");
    } finally {
      await dropUser(userId);
    }
  });

  it("the CAS stops two callers that hold different events, or none", async () => {
    const { userId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      // The confirmation endpoint holds no event; the webhook holds its own.
      // Neither collides on the claim, so only the CAS separates them.
      const [a, b] = await Promise.all([
        fulfillPayment(sessionId, null),
        fulfillPayment(sessionId, evt(`evt_race_${sessionId}`)),
      ]);

      const granted = [a, b].filter((r) => r.status === "granted");
      expect(granted).toHaveLength(1);
      const counts = await countsFor(userId);
      expect(counts.lots).toBe(1);
      expect(counts.ledger).toBe(1);
      expect(counts.consents).toBe(1);
    } finally {
      await dropUser(userId);
    }
  });

  it("rolls the claim back with the rest when a later step fails", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    const eventId = `evt_rollback_${sessionId}`;
    try {
      // A lot already exists for this payment, so creating the second one
      // violates the unique constraint partway through the transaction.
      await sql`
        INSERT INTO credit_lots (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${paymentId}, ${userId}, 1700, 1700, 'active')
      `;
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      await expect(fulfillPayment(sessionId, evt(eventId))).rejects.toThrow();

      // The claim must be gone with it: otherwise Stripe's redelivery — the
      // only automatic recovery there is — short-circuits forever.
      const [claim] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM stripe_webhook_events WHERE event_id = ${eventId}
      `;
      expect(claim!.n).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("pending");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("what the session says decides", () => {
  it("leaves an unpaid session that is still open in pending", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, {
          payment_status: "unpaid",
          status: "open",
        }),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("noop");
      expect((await countsFor(userId)).lots).toBe(0);
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("pending");
    } finally {
      await dropUser(userId);
    }
  });

  it("records what Stripe worked out on a checkout whose money is still clearing", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      // A delayed payment method: the buyer typed their address and finished
      // the checkout, so Stripe has the tax and the final figure, while the
      // money itself has not moved.
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, {
          payment_status: "unpaid",
          status: "complete",
        }),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("noop");
      // Nothing has been paid, so nothing is granted and the row stays where
      // it is — but the figure Stripe holds is the only thing that can tell
      // the buyer what this will cost, and this is the one moment it is
      // available before the money lands.
      expect((await countsFor(userId)).lots).toBe(0);
      const [row] = await sql<
        { status: string; total_cents: number | null; tax_cents: number | null }[]
      >`
        SELECT status, total_cents, tax_cents FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("pending");
      expect(row!.total_cents).toBe(2240);
      expect(row!.tax_cents).toBe(240);
    } finally {
      await dropUser(userId);
    }
  });

  it("leaves the figures alone on a session still being filled in", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      // Still `open`: Stripe has no address yet, so its `amount_total` is the
      // face value with no tax worked out. Recording that as the final figure
      // would say the buyer pays no tax.
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, {
          payment_status: "unpaid",
          status: "open",
          amount_total: 2000,
          total_details: { amount_tax: 0 },
        }),
      );

      await fulfillPayment(sessionId, null);

      const [row] = await sql<
        { total_cents: number | null; tax_cents: number | null }[]
      >`
        SELECT total_cents, tax_cents FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.total_cents).toBeNull();
      expect(row!.tax_cents).toBeNull();
    } finally {
      await dropUser(userId);
    }
  });

  it("expires a row whose session Stripe reports as expired", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, {
          payment_status: "unpaid",
          status: "expired",
        }),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("expired");
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("expired");
    } finally {
      await dropUser(userId);
    }
  });

  it("grants money that arrives after the payment was judged failed", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      await sql`UPDATE payments SET status = 'failed' WHERE id = ${paymentId}`;
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("granted");
      expect((await countsFor(userId)).lots).toBe(1);
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses to grant when Stripe charged something other than the tier", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, { amount_subtotal: 1000 }),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("mismatch");
      expect((await countsFor(userId)).lots).toBe(0);
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("pending");
    } finally {
      await dropUser(userId);
    }
  });

  it("answers without throwing when no payment row names this session", async () => {
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      paidSession("cs_test_stranger"),
    );

    const outcome = await fulfillPayment("cs_test_stranger", evt("evt_stranger"));

    expect(outcome.status).toBe("unknown");
  });

  it("says the same about a session it is told the payment for failed", async () => {
    // The fourth of the four Checkout Session events the webhook receives.
    // Three of them come through here and answer for a session we have no row
    // for; if this one throws, the endpoint replies 404 and Stripe redelivers
    // that 404 for three days.
    const outcome = await handlePaymentFailed("cs_test_stranger_failed");

    expect(outcome.status).toBe("unknown");
  });

  it("moves a purchase of ours to failed when its delayed payment is refused", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      const outcome = await handlePaymentFailed(sessionId);

      expect(outcome.status).toBe("failed");
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("failed");
      // Nothing was granted: the money never arrived. The row saying `failed`
      // is what stops the history showing it as in flight, and reconciling
      // still picks it up if the money lands after all.
      expect((await countsFor(userId)).lots).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("says so rather than writing it twice when the same refusal arrives again", async () => {
    const { userId, sessionId } = await seedPending();
    try {
      await handlePaymentFailed(sessionId);
      const second = await handlePaymentFailed(sessionId);

      // Stripe redelivers, and the row has already moved out of the states
      // this transition accepts. Answering `replay` is what keeps the route
      // from reporting a second failure for one refusal.
      expect(second.status).toBe("replay");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("what a purchase agreed to is read off our own row", () => {
  it("records the language and both wording versions the checkout was made in", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      // The four things checkout stored, which only our row holds: a webhook
      // carries no `Accept-Language` and no hint of a time zone.
      await sql`
        UPDATE payments SET metadata = ${sql.json({
          locale: "ja",
          timeZone: "Asia/Tokyo",
          consentTextVersion: "consent-credits-v1",
          refundTextVersion: "refund-credits-v1",
        })} WHERE id = ${paymentId}
      `;
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, { metadata: {} }),
      );

      const outcome = await fulfillPayment(sessionId, null);
      expect(outcome.status).toBe("granted");

      const [consent] = await sql<
        { locale: string; consent_text_version: string; refund_text_version: string }[]
      >`
        SELECT locale, consent_text_version, refund_text_version
        FROM purchase_consents WHERE payment_id = ${paymentId}
      `;
      expect(consent!.locale).toBe("ja");
      expect(consent!.consent_text_version).toBe("consent-credits-v1");
      expect(consent!.refund_text_version).toBe("refund-credits-v1");

      // The letter is written in the language stored on the payment, which
      // this record already pins; the outbox row keeps no second copy of it.
      const [mail] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM purchase_mail_outbox
        WHERE payment_id = ${paymentId}
      `;
      expect(mail!.n).toBe(1);
    } finally {
      await dropUser(userId);
    }
  });

  it("writes no consent when the session carries none", async () => {
    const { userId, paymentId, sessionId } = await seedPending();
    try {
      // A session from before the consent control shipped, or one Stripe
      // reports without an answer. The credits are still owed — the card was
      // charged — but a record of an agreement nobody made would be invented.
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, { consent: null }),
      );

      const outcome = await fulfillPayment(sessionId, null);

      expect(outcome.status).toBe("granted");
      expect(outcome).toMatchObject({ consentRecorded: false });
      const counts = await countsFor(userId);
      expect(counts.lots).toBe(1);
      expect(counts.consents).toBe(0);
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${paymentId}
      `;
      expect(row!.status).toBe("completed");
    } finally {
      await dropUser(userId);
    }
  });

  it("reports on the outcome that a consent was recorded", async () => {
    const { userId, sessionId } = await seedPending();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId),
      );
      const outcome = await fulfillPayment(sessionId, null);
      expect(outcome).toMatchObject({ consentRecorded: true });
    } finally {
      await dropUser(userId);
    }
  });

  /**
   * A checkout page can sit open for two hours (`expires_at`), so when the
   * session was created and when the buyer actually ticked the box can be up
   * to two hours apart. A consent record is our evidence for a distance sale,
   * so its timestamp may only be the moment we genuinely observed the consent
   * to exist.
   */
  it("stamps the consent at the moment we saw it, not when the page was opened", async () => {
    const { userId, sessionId, paymentId } = await seedPending();
    try {
      const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession(sessionId, { created: twoHoursAgo }),
      );
      const before = Date.now();

      await fulfillPayment(sessionId, null);

      const [consent] = await sql<{ consented_at: Date }[]>`
        SELECT consented_at FROM purchase_consents WHERE payment_id = ${paymentId}
      `;
      const stamped = consent!.consented_at.getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(Date.now());
    } finally {
      await dropUser(userId);
    }
  });
});
