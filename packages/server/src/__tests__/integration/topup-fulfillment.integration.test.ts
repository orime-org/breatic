// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 入账那一个事务（任务 #13 §4.3）—— 真 PG，Stripe 客户端替身。
 *
 * `fulfillPayment(sessionId, eventId | null)` 有四个调用方：返回侧确认端点 ·
 * webhook · 覆盖层对账 · cancel 读到已付款那一支。四个调的是同一个函数，
 * 所以下面每一条断言的都是「不管谁先到，结果只有一种」。
 *
 * 两道幂等各管一段，这是这一层最容易写错的地方：
 *
 * 一、**认领挡的是同一个事件被投递两次**。Stripe 至少投递一次，重投是常态。
 * 认领跟入账在同一个事务里——这一点照会员腿（`subscription-events.ts:286`）
 * 与 `schema.ts` 上那条注释办。认领先提交、入账另开事务是错的：入账失败之后
 * 事件已被标记为已处理，三天内的重投全部短路，钱进了而积分永远不发。
 *
 * 二、**CAS 挡的是四个调用方之间的并发**。webhook 与确认端点同一秒各自读到
 * paid，两边手上的事件不同或没有事件，认领拦不住，靠 `payments.status` 上的
 * CAS 只成一次。
 *
 * 三、**首发确认邮件只在这一趟真的建了 lot 时才发**。每个调用方都会走完事务
 * 并提交，包括什么都没写的那几种（认领撞了的、CAS 不匹配答 replay 的），而
 * replay 是最常见的一条路：确认端点抢先入账，几秒后 webhook 到、认领成功、
 * CAS 不匹配。少了这个条件，每一笔确认端点跑赢 webhook 的购买都收两封信。
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
import { fulfillPayment } from "@server/modules/payment/payment.service.js";

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

      const outcome = await fulfillPayment(sessionId, `evt_${sessionId}`);

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
      // 发信有意不被 await——请求不能等 SMTP，那是 §4.5 的承诺。所以这里等
      // 它自己跑到替身，而不是断言「已经跑完了」。
      await waitForMail(1);
      expect(sentMail).toHaveBeenCalledTimes(1);

      // The webhook arrives seconds later with an event id of its own: the
      // claim succeeds, the CAS no longer matches, and this pass wrote
      // nothing. It must not mail again.
      const replay = await fulfillPayment(sessionId, `evt_${sessionId}`);
      expect(replay.status).toBe("replay");
      // 给它同样长的机会去发第二封；没发才是对的。
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

      const first = await fulfillPayment(sessionId, eventId);
      const second = await fulfillPayment(sessionId, eventId);

      expect(first.status).toBe("granted");
      expect(second.status).toBe("replay");
      const counts = await countsFor(userId);
      expect(counts.lots).toBe(1);
      expect(counts.ledger).toBe(1);
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
        fulfillPayment(sessionId, `evt_race_${sessionId}`),
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

      await expect(fulfillPayment(sessionId, eventId)).rejects.toThrow();

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

    const outcome = await fulfillPayment("cs_test_stranger", "evt_stranger");

    expect(outcome.status).toBe("unknown");
  });
});
