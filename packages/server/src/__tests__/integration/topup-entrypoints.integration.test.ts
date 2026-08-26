// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 买家回来那两个端点，加覆盖层打开时的对账（任务 #13 §4.4、§4.6）。
 *
 * 三条路各自解决同一件事的一部分：**一笔付了钱的购买必须到账，而一笔弃单
 * 必须停止显示成「处理中」**。
 *
 * 一、`POST /payment/confirm`——买家付完款回来打的那一下，即时到账。
 *
 * 二、`POST /payment/cancel`——买家点「返回」那一下。Stripe 的 expire 端点
 * 只收 `open` 的 session，**被拒时不猜**：接着 retrieve 一次按真实状态办。
 * 读到已付款那一支尤其要紧——它是「付完款、确认端点没成、买家回到还开着
 * 的结账页点了返回」这条真实路径，这时候把本地写成 `expired` 就是收了钱
 * 不发积分。
 *
 * 三、对账——两条路都断了的兜底，挂在覆盖层每次打开都要打的那个查询上。
 * 三个界（只取 `pending` 与 `failed`、跳过太新的、按 `updated_at` 升序取
 * 几笔）里最容易漏的是**排序那一条**：弃单在 session 的两小时里 retrieve
 * 回来都是 `open`、都会留在 `pending`，按创建时间取最老的几笔，这几个名额
 * 会被同一批弃单长期占满，而真正付了钱的那一笔永远轮不到。
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
      expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(sessionId);
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
