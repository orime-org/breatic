// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What backs the purchase history screen (task #13 §4.6) — against real PG.
 *
 * The screen lists payments rather than credit lots, because the question it
 * answers is "what became of my money". A payment still in flight and an
 * abandoned one both have no lot, and those are exactly the two a buyer most
 * needs to find here.
 *
 * Three things follow from that, each pinned down by a group of cases:
 *
 * 1. On a row that has not landed, the whole lot side reads null. What was
 *    actually charged, what is left, where it points — none of it exists yet.
 *    That is not missing data; it is a purchase that has not landed.
 *
 * 2. Paging must key on `payments`. Key it on the lot and both the sort key
 *    and the cursor go null on these rows: the walk reaches an empty cursor
 *    and every earlier payment becomes unreachable.
 *
 * 3. Where a purchase points is read through whether that studio still
 *    exists. One purchase counting as unassigned in the overview while this
 *    screen says "assigned to X" with X already gone is two answers to the
 *    same question.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
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

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => ({
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
  }),
}));

import crypto from "node:crypto";
import type { Hono } from "hono";
import postgres from "postgres";
import {
  initCore,
  loadLocales,
  getRedis,
  setSession,
  sessionCookieName,
} from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { CreditPage, PurchaseRow } from "@breatic/shared";
import { getConfirmationView } from "@server/modules/payment/payment.repo.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "topup-history-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Buyer {
  userId: string;
  studioId: string;
  cookie: string;
}

/** A signed-in account with a team studio it can point credits at. */
async function seedBuyer(): Promise<Buyer> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`hist-${stamp}@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`hist-s-${stamp}`}, 'team', ${`Hist ${stamp}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`hist-me-${stamp}`}, 'personal', ${`Me ${stamp}`})
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return {
    userId: user!.id,
    studioId: studio!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * One payment row, in whatever state the case needs.
 * @param userId - Whose it is.
 * @param over - What to set.
 * @param over.status - Where the payment stands.
 * @param over.createdAgoSeconds - How long ago it was made.
 * @param over.totalCents - What was actually charged, once known.
 * @param over.taxCents - The tax within that.
 * @returns Its id.
 */
async function seedPayment(
  userId: string,
  over: {
    status?: string;
    createdAgoSeconds?: number;
    totalCents?: number | null;
    taxCents?: number | null;
  } = {},
): Promise<string> {
  seq += 1;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO payments (
      user_id, stripe_session_id, amount_cents, tax_cents, total_cents,
      credits_granted, currency, status, created_at, updated_at
    )
    VALUES (
      ${userId}, ${`cs_hist_${Date.now()}-${seq}`}, 2000,
      ${over.taxCents ?? null}, ${over.totalCents ?? null},
      1700, 'usd', ${over.status ?? "pending"},
      now() - make_interval(secs => ${over.createdAgoSeconds ?? 60}),
      now()
    )
    RETURNING id
  `;
  return row!.id;
}

/**
 * A landed purchase: the payment, its lot, and where it points.
 * @param userId - Whose it is.
 * @param designateTo - The studio to point it at, or null to leave it unassigned.
 * @param createdAgoSeconds - How long ago it was made.
 * @returns The payment's id.
 */
async function seedLanded(
  userId: string,
  designateTo: string | null = null,
  createdAgoSeconds = 60,
): Promise<string> {
  const paymentId = await seedPayment(userId, {
    status: "completed",
    totalCents: 2240,
    taxCents: 240,
    createdAgoSeconds,
  });
  const lot = await creditLotService.grantFromPayment({
    paymentId,
    userId,
    purchasedCredits: 1700,
  });
  if (designateTo !== null) {
    await sql`
      UPDATE credit_lots SET designated_studio_id = ${designateTo}
      WHERE id = ${lot.id}
    `;
  }
  await sql`
    INSERT INTO purchase_mail_outbox (payment_id, locale, status)
    VALUES (${paymentId}, 'en', 'sent')
  `;
  return paymentId;
}

/** Removes an account and everything hanging off it. */
async function dropBuyer(userId: string): Promise<void> {
  await sql`DELETE FROM credit_ledger WHERE payer_user_id = ${userId}`;
  await sql`DELETE FROM credit_lots WHERE user_id = ${userId}`;
  await sql`DELETE FROM purchase_mail_outbox WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM purchase_consents WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM studio_members WHERE user_id = ${userId}`;
  await sql`DELETE FROM studios WHERE created_by_user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/**
 * Ask for one page of the history.
 * @param buyer - Who is asking.
 * @param query - The query string, without its leading `?`.
 * @returns The page.
 */
async function history(
  buyer: Buyer,
  query = "",
): Promise<CreditPage<PurchaseRow>> {
  const res = await app.request(
    `/api/v1/payment/history${query === "" ? "" : `?${query}`}`,
    { headers: { cookie: buyer.cookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: CreditPage<PurchaseRow> };
  return body.data;
}

describe("GET /payment/history — every purchase, landed or not", () => {
  it("lists the four states a purchase can be in", async () => {
    const buyer = await seedBuyer();
    try {
      await seedPayment(buyer.userId, { status: "pending" });
      await seedPayment(buyer.userId, { status: "expired" });
      await seedPayment(buyer.userId, { status: "failed" });
      await seedLanded(buyer.userId);

      const page = await history(buyer);
      expect(page.items).toHaveLength(4);
      expect(page.items.map((r) => r.status).sort()).toEqual([
        "completed",
        "expired",
        "failed",
        "pending",
      ]);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("carries nulls, not zeroes, for a purchase that has not landed", async () => {
    const buyer = await seedBuyer();
    try {
      const paymentId = await seedPayment(buyer.userId, { status: "pending" });
      const [row] = (await history(buyer)).items;
      expect(row!.paymentId).toBe(paymentId);
      // The listed price is known — it is what we charged for. Everything the
      // Session and the lot would have told us is not.
      expect(row!.amountCents).toBe(2000);
      expect(row!.totalCents).toBeNull();
      expect(row!.taxCents).toBeNull();
      expect(row!.remainingCredits).toBeNull();
      expect(row!.lifecycle).toBeNull();
      expect(row!.designatedStudioId).toBeNull();
      expect(row!.mailStatus).toBeNull();
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("carries what was actually charged once the purchase lands", async () => {
    const buyer = await seedBuyer();
    try {
      await seedLanded(buyer.userId, buyer.studioId);
      const [row] = (await history(buyer)).items;
      expect(row!.totalCents).toBe(2240);
      expect(row!.taxCents).toBe(240);
      expect(row!.remainingCredits).toBe(1700);
      expect(row!.lifecycle).toBe("active");
      expect(row!.designatedStudioId).toBe(buyer.studioId);
      expect(row!.designatedStudioName).not.toBeNull();
      expect(row!.mailStatus).toBe("sent");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("reads a purchase pointed at a deleted studio as pointed nowhere", async () => {
    const buyer = await seedBuyer();
    try {
      await seedLanded(buyer.userId, buyer.studioId);
      await sql`UPDATE studios SET deleted_at = now() WHERE id = ${buyer.studioId}`;

      const [row] = (await history(buyer)).items;
      // The same predicate the overview uses. One purchase cannot count as
      // unassigned there and read "assigned to X" here with X gone.
      expect(row!.designatedStudioId).toBeNull();
      expect(row!.designatedStudioName).toBeNull();
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("shows only this account's purchases", async () => {
    const buyer = await seedBuyer();
    const stranger = await seedBuyer();
    try {
      await seedPayment(buyer.userId);
      await seedPayment(stranger.userId);
      const page = await history(buyer);
      expect(page.items).toHaveLength(1);
    } finally {
      await dropBuyer(buyer.userId);
      await dropBuyer(stranger.userId);
    }
  });
});

describe("GET /payment/history — paging", () => {
  it("walks every purchase, newest first, including ones with no lot", async () => {
    const buyer = await seedBuyer();
    try {
      // Interleaved on purpose: paging keyed on the lot would collapse on the
      // rows that have none, and those are every other row here.
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const ago = 600 - i * 60;
        ids.push(
          i % 2 === 0
            ? await seedPayment(buyer.userId, { createdAgoSeconds: ago })
            : await seedLanded(buyer.userId, null, ago),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: CreditPage<PurchaseRow> = await history(
          buyer,
          `limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        seen.push(...page.items.map((r) => r.paymentId));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      // Newest first: the last one seeded is the newest.
      expect(seen[0]).toBe(ids[5]);
      expect(seen[5]).toBe(ids[0]);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("starts from the beginning when the cursor is unreadable", async () => {
    const buyer = await seedBuyer();
    try {
      await seedPayment(buyer.userId);
      const page = await history(buyer, "cursor=not-a-cursor");
      expect(page.items).toHaveLength(1);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });
});

describe("GET /payment/history — whether the confirmation can be sent again", () => {
  it.each([
    ["pending", true],
    ["failed", true],
    ["skipped", true],
    ["sent", false],
  ])("offers a resend on %s: %s", async (mailStatus, expected) => {
    const buyer = await seedBuyer();
    try {
      const paymentId = await seedLanded(buyer.userId);
      await sql`
        UPDATE purchase_mail_outbox SET status = ${mailStatus}
        WHERE payment_id = ${paymentId}
      `;
      const [row] = (await history(buyer)).items;
      expect(row!.canResend).toBe(expected);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("holds off while a send is in flight, and offers it once that is stale", async () => {
    const buyer = await seedBuyer();
    try {
      const paymentId = await seedLanded(buyer.userId);
      await sql`
        UPDATE purchase_mail_outbox
        SET status = 'sending', updated_at = now()
        WHERE payment_id = ${paymentId}
      `;
      expect((await history(buyer)).items[0]!.canResend).toBe(false);

      // A process replaced between claiming the send and writing the result
      // strands the row here, and nothing sweeps it: this timeout is what
      // frees it.
      await sql`
        UPDATE purchase_mail_outbox
        SET updated_at = now() - interval '30 minutes'
        WHERE payment_id = ${paymentId}
      `;
      expect((await history(buyer)).items[0]!.canResend).toBe(true);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("never offers a resend on a purchase that has not landed", async () => {
    const buyer = await seedBuyer();
    try {
      await seedPayment(buyer.userId, { status: "pending" });
      expect((await history(buyer)).items[0]!.canResend).toBe(false);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });
});

describe("POST /payment/:id/resend-confirmation", () => {
  it("sends the confirmation again for a purchase of theirs", async () => {
    const buyer = await seedBuyer();
    try {
      const paymentId = await seedLanded(buyer.userId);
      await sql`
        UPDATE purchase_mail_outbox SET status = 'failed'
        WHERE payment_id = ${paymentId}
      `;
      const res = await app.request(
        `/api/v1/payment/${paymentId}/resend-confirmation`,
        { method: "POST", headers: { cookie: buyer.cookie } },
      );
      expect(res.status).toBe(200);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("refuses a purchase that belongs to somebody else", async () => {
    const buyer = await seedBuyer();
    const stranger = await seedBuyer();
    try {
      const paymentId = await seedLanded(buyer.userId);
      const res = await app.request(
        `/api/v1/payment/${paymentId}/resend-confirmation`,
        { method: "POST", headers: { cookie: stranger.cookie } },
      );
      expect(res.status).toBe(404);
    } finally {
      await dropBuyer(buyer.userId);
      await dropBuyer(stranger.userId);
    }
  });

  it("turns a signed-out caller away", async () => {
    const res = await app.request(
      "/api/v1/payment/9f1c7c2e-0000-4000-8000-000000000001/resend-confirmation",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });
});

/**
 * The current balance printed on the confirmation mail.
 *
 * It is the only number in that mail that moves: everything else is read off
 * this purchase's own row and comes back identical on a resend months later.
 * Since it claims to be current, it has to come from the same place as the
 * figure at the top of the overlay — what is left (`remaining_credits`), not
 * what was ever bought (`purchased_credits`).
 */
describe("what the confirmation calls the balance", () => {
  it("counts what is left, not what was ever bought", async () => {
    const buyer = await seedBuyer();
    try {
      const paymentId = await seedLanded(buyer.userId);
      // 1700 bought, 1200 of it spent.
      await sql`
        UPDATE credit_lots SET remaining_credits = 500
        WHERE payment_id = ${paymentId}
      `;
      const view = await getConfirmationView(paymentId);
      expect(view?.balanceCredits).toBe(500);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("leaves out a lot that is no longer active", async () => {
    const buyer = await seedBuyer();
    try {
      const live = await seedLanded(buyer.userId);
      const refunded = await seedLanded(buyer.userId);
      await sql`
        UPDATE credit_lots SET lifecycle = 'refunded'
        WHERE payment_id = ${refunded}
      `;
      const view = await getConfirmationView(live);
      // Only the live lot's 1700 counts; the refunded one's does not.
      expect(view?.balanceCredits).toBe(1700);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("adds up every live lot the account holds, not just this purchase's", async () => {
    const buyer = await seedBuyer();
    try {
      const first = await seedLanded(buyer.userId);
      await seedLanded(buyer.userId);
      const view = await getConfirmationView(first);
      expect(view?.balanceCredits).toBe(3400);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });
});
