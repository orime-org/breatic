// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two entrances the buyer comes back through, plus the reconcile pass that
 * runs when the overlay opens (task #13 §4.4, §4.6).
 *
 * All three paths serve one guarantee: a purchase that was paid for must be
 * credited, and an abandoned checkout must stop showing as in flight.
 *
 * 1. `POST /payment/confirm` - the call the buyer makes on returning from a
 *    completed payment. Credits land there and then.
 *
 * 2. `POST /payment/cancel` - the call behind pressing Back. Stripe's expire
 *    endpoint only accepts a session that is still `open`, and when it refuses
 *    we do not guess: we retrieve the session and act on what it really says.
 *    The paid branch is the one that matters most - it is the real sequence
 *    "payment went through, the confirm call never landed, the buyer returned
 *    to the still-open checkout page and pressed Back". Writing `expired`
 *    locally there means taking the money and granting no credits.
 *
 * 3. Reconciling - the fallback for when both of the above fell through. It
 *    hangs off the one query the overlay makes every time it opens. Of its
 *    three bounds (only `pending` and `failed`, skip rows too young to have
 *    been abandoned, take a few ordered by `updated_at` ascending), the
 *    ordering is the easiest to get wrong: for the two hours a session lives,
 *    an abandoned checkout retrieves as `open` and stays `pending`, so picking
 *    the oldest few by creation time lets the same batch of abandoned rows
 *    hold those slots indefinitely and the row that was actually paid for
 *    never gets a turn.
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
  checkout: {
    sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() },
  },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

// Sending is a double: this suite is about what the three entrances do to our
// own rows, and a real send would hold each request.
vi.mock("@server/modules/payment/purchase-mail.js", () => ({
  sendPurchaseConfirmation: vi.fn(async () => true),
}));

import crypto from "node:crypto";
import {
  getPricingTiers,
  resetPricingCache,
} from "@server/config/pricing.js";
import type { Hono } from "hono";
import postgres from "postgres";
import {
  initCore,
  loadLocales,
  getRedis,
  setSession,
  sessionCookieName,
} from "@breatic/core";

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
    connection: { application_name: "topup-entrypoints-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Buyer {
  userId: string;
  cookie: string;
}

/** A signed-in account with a personal studio. */
async function seedBuyer(): Promise<Buyer> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`entry-${stamp}@example.test`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`entry-me-${stamp}`}, 'personal', ${`Entry ${stamp}`})
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * One payment waiting to be settled.
 * @param userId - Who is buying.
 * @param over - Columns to override.
 * @param over.status - Where the row starts.
 * @param over.createdAgoSeconds - How long ago it was created.
 * @returns Its id and session id.
 */
async function seedPending(
  userId: string,
  over: { status?: string; createdAgoSeconds?: number } = {},
): Promise<{ paymentId: string; sessionId: string }> {
  seq += 1;
  const sessionId = `cs_test_entry_${Date.now()}-${seq}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO payments (
      user_id, stripe_session_id, amount_cents, credits_granted, currency,
      status, created_at, updated_at
    )
    VALUES (
      ${userId}, ${sessionId}, 2000, 1700, 'usd', ${over.status ?? "pending"},
      now() - make_interval(secs => ${over.createdAgoSeconds ?? 600}),
      now() - make_interval(secs => ${over.createdAgoSeconds ?? 600})
    )
    RETURNING id
  `;
  return { paymentId: row!.id, sessionId };
}

/** Removes an account and everything hanging off it. */
async function dropBuyer(userId: string): Promise<void> {
  await sql`DELETE FROM credit_ledger WHERE payer_user_id = ${userId}`;
  await sql`DELETE FROM credit_lots WHERE user_id = ${userId}`;
  await sql`DELETE FROM purchase_mail_outbox WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM purchase_consents WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM studios WHERE created_by_user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/** A paid Checkout Session as the SDK returns it. */
function paidSession(sessionId: string): Record<string, unknown> {
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
    created: Math.floor(Date.now() / 1000),
    metadata: {},
  };
}

/** An unpaid Checkout Session in one of its two unpaid shapes. */
function unpaidSession(
  sessionId: string,
  status: "open" | "expired",
): Record<string, unknown> {
  return {
    id: sessionId,
    mode: "payment",
    status,
    payment_status: "unpaid",
    amount_subtotal: 2000,
    currency: "usd",
    consent: null,
    metadata: {},
  };
}

/** What one payment row says now. */
async function statusOf(paymentId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM payments WHERE id = ${paymentId}
  `;
  return row!.status;
}

describe("POST /payment/confirm — the buyer came back from a payment", () => {
  it("grants the credits there and then", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      const res = await app.request("/api/v1/payment/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ session_id: sessionId }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("completed");

      const lots = await sql`SELECT id FROM credit_lots WHERE user_id = ${buyer.userId}`;
      expect(lots).toHaveLength(1);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("answers the same way when the webhook already did the work", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId, {
      status: "completed",
    });
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      const res = await app.request("/api/v1/payment/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ session_id: sessionId }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("completed");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("refuses a session that belongs to somebody else", async () => {
    const buyer = await seedBuyer();
    const stranger = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      const res = await app.request("/api/v1/payment/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: stranger.cookie },
        body: JSON.stringify({ session_id: sessionId }),
      });
      expect(res.status).toBe(404);
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
      await dropBuyer(stranger.userId);
    }
  });

  it("refuses a session we hold no row for", async () => {
    const buyer = await seedBuyer();
    try {
      const res = await app.request("/api/v1/payment/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ session_id: "cs_test_nothing_here" }),
      });
      expect(res.status).toBe(404);
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("turns a signed-out caller away", async () => {
    const res = await app.request("/api/v1/payment/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "cs_test_whatever" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /payment/cancel — the buyer pressed Back", () => {
  it("expires the session and stops showing the purchase as in flight", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.expire.mockResolvedValue(
      unpaidSession(sessionId, "expired"),
    );
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(200);
      // Bounded and not retried, the same as every other Stripe call on this
      // leg: a buyer is waiting on the answer and the SDK's default is eighty
      // seconds twice retried.
      expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(
        sessionId,
        undefined,
        expect.objectContaining({ maxNetworkRetries: 0 }),
      );
      expect(await statusOf(paymentId)).toBe("expired");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("asks Stripe what happened when the expire is refused, and takes its word for expired", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.expire.mockRejectedValue(
      new Error("You may only expire a session that is open"),
    );
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      unpaidSession(sessionId, "expired"),
    );
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("expired");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("leaves the row alone when the session turns out to still be open", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.expire.mockRejectedValue(new Error("refused"));
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      unpaidSession(sessionId, "open"),
    );
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("grants the credits when the session turns out to have been paid", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.expire.mockRejectedValue(new Error("refused"));
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("completed");

      const lots = await sql`SELECT id FROM credit_lots WHERE user_id = ${buyer.userId}`;
      expect(lots).toHaveLength(1);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("leaves the row for reconciling when Stripe cannot be reached at all", async () => {
    const buyer = await seedBuyer();
    const { paymentId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.expire.mockRejectedValue(new Error("timeout"));
    stripe.checkout.sessions.retrieve.mockRejectedValue(new Error("timeout"));
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      // The buyer is behind this call and their purchase is unharmed, so the
      // answer is 200 and the repair is left to the next reconcile pass.
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("refuses a payment that belongs to somebody else", async () => {
    const buyer = await seedBuyer();
    const stranger = await seedBuyer();
    const { paymentId } = await seedPending(buyer.userId);
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: stranger.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(404);
      expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
      await dropBuyer(stranger.userId);
    }
  });

  it("leaves a settled purchase settled", async () => {
    const buyer = await seedBuyer();
    const { paymentId } = await seedPending(buyer.userId, {
      status: "completed",
    });
    try {
      const res = await app.request("/api/v1/payment/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: buyer.cookie },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      expect(res.status).toBe(200);
      expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
      expect(await statusOf(paymentId)).toBe("completed");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });
});

describe("GET /credits/overview — reconciling what both other paths missed", () => {
  it("settles a payment that neither the return nor the webhook finished", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      const res = await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      expect(res.status).toBe(200);
      expect(await statusOf(paymentId)).toBe("completed");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("settles a payment that failed and was paid afterwards", async () => {
    const buyer = await seedBuyer();
    const { paymentId, sessionId } = await seedPending(buyer.userId, {
      status: "failed",
    });
    stripe.checkout.sessions.retrieve.mockResolvedValue(paidSession(sessionId));
    try {
      await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      expect(await statusOf(paymentId)).toBe("completed");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("leaves alone a payment the buyer may still be paying for", async () => {
    const buyer = await seedBuyer();
    const { paymentId } = await seedPending(buyer.userId, {
      createdAgoSeconds: 30,
    });
    try {
      await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("never asks about a purchase that is already settled", async () => {
    const buyer = await seedBuyer();
    await seedPending(buyer.userId, { status: "completed" });
    await seedPending(buyer.userId, { status: "expired" });
    try {
      await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("takes three at a time and reaches the fourth on the next pass", async () => {
    const buyer = await seedBuyer();
    // Four abandoned checkouts, each older than the last. Stripe says all four
    // are still open, so none of them leaves `pending` — which is exactly the
    // shape that starves the fourth if a pass keeps picking the oldest.
    const rows = [];
    for (const ago of [3000, 2000, 1000, 900]) {
      rows.push(await seedPending(buyer.userId, { createdAgoSeconds: ago }));
    }
    stripe.checkout.sessions.retrieve.mockImplementation(
      async (id: string) => unpaidSession(id, "open"),
    );
    try {
      await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      const firstPass = stripe.checkout.sessions.retrieve.mock.calls.map(
        ([id]) => id as string,
      );
      expect(firstPass).toHaveLength(3);
      expect(firstPass).not.toContain(rows[3]!.sessionId);

      stripe.checkout.sessions.retrieve.mockClear();
      await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      const secondPass = stripe.checkout.sessions.retrieve.mock.calls.map(
        ([id]) => id as string,
      );
      expect(secondPass).toContain(rows[3]!.sessionId);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("settles the rest of the batch when one payment throws", async () => {
    const buyer = await seedBuyer();
    const bad = await seedPending(buyer.userId);
    const good = await seedPending(buyer.userId);
    try {
      // The passes run concurrently. Joined on the first rejection, whatever
      // the others found goes with it — including a charge that disagrees
      // with the price table, which nothing else in the system produces.
      stripe.checkout.sessions.retrieve.mockImplementation(
        async (id: string) => {
          if (id === bad.sessionId) throw new Error("timeout");
          return paidSession(id);
        },
      );

      const res = await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });

      expect(res.status).toBe(200);
      expect(await statusOf(good.paymentId)).toBe("completed");
      expect(await statusOf(bad.paymentId)).toBe("pending");
    } finally {
      stripe.checkout.sessions.retrieve.mockReset();
      await dropBuyer(buyer.userId);
    }
  });

  it("answers with what we hold locally when Stripe cannot be reached", async () => {
    const buyer = await seedBuyer();
    const { paymentId } = await seedPending(buyer.userId);
    stripe.checkout.sessions.retrieve.mockRejectedValue(new Error("timeout"));
    try {
      const res = await app.request("/api/v1/credits/overview", {
        headers: { cookie: buyer.cookie },
      });
      // Seven sections of the overlay wait behind this one query. A repair
      // that could not run is not a reason to show the buyer nothing.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toBeDefined();
      expect(await statusOf(paymentId)).toBe("pending");
    } finally {
      await dropBuyer(buyer.userId);
    }
  });
});

/**
 * The three guards on the endpoint that starts a purchase.
 *
 * Everything else about this endpoint is exercised through the service, which
 * is where the session parameters are decided. What only the route can answer
 * for is who may reach it and under what conditions, and each of the three is
 * a different refusal a buyer can hit.
 */
describe("POST /payment/checkout — who may start a purchase", () => {
  /**
   * Ask the endpoint to start a checkout.
   * @param cookie - The session cookie, or none for a signed-out caller.
   * @param priceCents - Which pack, by face value.
   * @returns The response.
   */
  async function checkout(
    cookie: string | null,
    priceCents = 1000,
  ): Promise<Response> {
    return app.request("/api/v1/payment/checkout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === null ? {} : { cookie }),
      },
      body: JSON.stringify({
        price_cents: priceCents,
        return_url: "https://app.example.test/studio",
        time_zone: "UTC",
      }),
    });
  }

  it("turns a signed-out caller away", async () => {
    expect((await checkout(null)).status).toBe(401);
  });

  it("refuses a pack this deployment does not sell", async () => {
    const buyer = await seedBuyer();
    try {
      // 1234 is not a face value in the price table. The request named
      // something that does not exist, which is the caller's mistake, so it
      // comes back 400 rather than as a missing resource.
      const res = await checkout(buyer.cookie, 1234);
      expect(res.status).toBe(400);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("refuses and names the pack when its Price ID is not configured", async () => {
    const original = getPricingTiers();
    // The `live` ids are blank in the file, so reading it as production is
    // exactly the shape this guard exists for: a pack on the price list that
    // Stripe has nothing to charge for. The account is made after the switch
    // because the session cookie is named from the environment.
    resetPricingCache();
    initCore({
      ...process.env,
      ENV: "prod",
      PAYMENT_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
    const buyer = await seedBuyer();
    try {
      const res = await checkout(buyer.cookie, original[0]!.priceCents);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { message: string } };
      // Named, so whoever reads it knows which of the five to go and fill in.
      expect(body.error.message).toContain(original[0]!.name);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      await dropBuyer(buyer.userId);
      resetPricingCache();
      initCore({
        ...process.env,
        PAYMENT_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
        STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
      });
    }
  });

  it("turns a caller away once they are over the limit", async () => {
    const buyer = await seedBuyer();
    try {
      // The window is per account, so one buyer asking too fast is what this
      // catches. `config/rate-limits.yaml` gives this endpoint ten a minute.
      const codes: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        codes.push((await checkout(buyer.cookie, 1234)).status);
      }
      expect(codes).toContain(429);
    } finally {
      await dropBuyer(buyer.userId);
    }
  });

  it("answers 404 where this deployment sells nothing", async () => {
    const buyer = await seedBuyer();
    initCore({
      ...process.env,
      PAYMENT_ENABLED: "false",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
    try {
      // Not 403: an install that sells nothing has no such endpoint, and
      // saying "forbidden" would say it exists.
      expect((await checkout(buyer.cookie)).status).toBe(404);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      initCore({
        ...process.env,
        PAYMENT_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
        STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
      });
      await dropBuyer(buyer.userId);
    }
  });
});
