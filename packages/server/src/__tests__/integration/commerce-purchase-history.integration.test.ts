// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purchase history (inner#1993 §3.2 #5): the product's own lots (bought,
 * gifted) and the completed payments it has a receipt for but no live lot,
 * merged, newest first, with the payments the billing service holds that the
 * product has no receipt for yet, one keyset across both; whether a bought row's
 * letter can be sent again is the billing service's answer. A deployment
 * that sells nothing answers its own lots only.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

/** The page bounds each case reads; one case raises the maximum above the mail-status bound. */
const pageBounds = vi.hoisted(() => ({ max: 100 }));
vi.mock("@server/config/limits.js", async (importOriginal) => {
  const actual = await importOriginal<{ getCreditPageLimits: () => { default: number; max: number } }>();
  return { ...actual, getCreditPageLimits: () => ({ ...actual.getCreditPageLimits(), max: pageBounds.max }) };
});

import { decodeActivityCursor, initCore, MAIL_STATUS_IDS_MAX, mailStatusRequestSchema } from "@breatic/core";
import { CREDIT_AMOUNT_FORMAT } from "@breatic/shared";
import { initSellingCore, insertAccount, loginCookie, useCommerceApp, type BillingRequest } from "./commerce-harness.js";
import { recordPaymentReceipt } from "./payment-source.js";

const suite = useCommerceApp("commerce-purchase-history");

afterEach(() => {
  pageBounds.max = 100;
});

/**
 * Give an account `count` bought lots, one minute apart.
 * @param userId - Whose.
 * @param count - How many.
 */
async function manyBought(userId: string, count: number): Promise<void> {
  await suite.sql`
    WITH ids AS (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${count}::int) AS n),
    src AS (INSERT INTO credit_sources(id,kind) SELECT id, 'payment' FROM ids),
    rec AS (INSERT INTO payment_receipts(id,user_id,amount_cents,currency,credits_granted,ordered_at)
      SELECT id, ${userId}, 100, 'usd', 100, now() - make_interval(mins => n) FROM ids)
    INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
    SELECT id, 'payment', ${userId}, 100, 100, 'active' FROM ids`;
}

/**
 * A payment the billing service holds without a lot.
 * @param at - When it was ordered, as a keyset instant.
 * @returns Its row as the billing service answers it.
 */
function unlanded(at: string): Record<string, unknown> {
  return {
    paymentId: randomUUID(),
    amountCents: 500,
    taxCents: null,
    totalCents: null,
    currency: "usd",
    creditsGranted: "500.000000",
    status: "pending",
    createdAt: new Date(at.replace(" ", "T").replace("+00", "Z")).toISOString(),
    cursorAt: at,
    canResend: false,
  };
}

/**
 * Answer the billing service's two history endpoints from fixed rows.
 * @param rows - Its unlanded payments, newest first.
 * @param resendable - Payment ids whose letter can be sent again.
 * @returns The reply.
 */
function billingHistory(rows: Array<Record<string, unknown>>, resendable: Set<string>): (req: BillingRequest) => { status: number; body: unknown } {
  return (req) => {
    const url = new URL(`http://x${req.path}`);
    if (url.pathname.endsWith("/payment/mail-status")) {
      const ids = (req.body as { paymentIds: string[] }).paymentIds;
      return { status: 200, body: { data: Object.fromEntries(ids.map((id) => [id, resendable.has(id)])) } };
    }
    const limit = Number(url.searchParams.get("limit"));
    const before = url.searchParams.get("before");
    const cursor = before === null ? null : decodeActivityCursor(before);
    const after = cursor === null ? rows : rows.filter((r) => `${r["cursorAt"] as string}|${r["paymentId"] as string}` < `${cursor.createdAt}|${cursor.id}`);
    return { status: 200, body: { data: after.slice(0, limit) } };
  };
}

/**
 * A lot the account holds.
 * @param userId - Whose.
 * @param kind - Bought or gifted.
 * @param at - When it was ordered or granted.
 * @returns Its source id.
 */
async function lot(userId: string, kind: "payment" | "gift", at: string): Promise<string> {
  // A sign-up gift's id is its account's (credit_gifts_metadata_check).
  const sourceId = kind === "gift" ? userId : randomUUID();
  await suite.sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},${kind})`;
  if (kind === "payment") {
    await recordPaymentReceipt(suite.sql, { id: sourceId, userId, amountCents: 1000, taxCents: 90, totalCents: 1090, credits: 1000 });
    await suite.sql`UPDATE payment_receipts SET ordered_at = ${at} WHERE id = ${sourceId}`;
  } else {
    const [studio] = await suite.sql<{ id: string }[]>`SELECT id FROM studios WHERE created_by_user_id = ${userId} AND type = 'personal'`;
    await suite.sql`INSERT INTO credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits)
      VALUES (${sourceId},'gift','registration',${userId},${studio!.id},200)`;
  }
  await suite.sql`
    INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle,created_at)
    VALUES (${sourceId},${kind},${userId},${kind === "payment" ? 1000 : 200},${kind === "payment" ? 1000 : 200},'active',${at})`;
  return sourceId;
}

/**
 * A completed payment the product has a receipt for but no lot.
 * @param userId - Whose.
 * @param at - When it was ordered.
 * @returns Its id.
 */
async function receiptOnly(userId: string, at: string): Promise<string> {
  const id = randomUUID();
  await suite.sql`INSERT INTO credit_sources(id,kind) VALUES (${id},'payment')`;
  await recordPaymentReceipt(suite.sql, { id, userId, amountCents: 1000, taxCents: 90, totalCents: 1090, credits: 1000 });
  await suite.sql`UPDATE payment_receipts SET ordered_at = ${at} WHERE id = ${id}`;
  return id;
}

/**
 * Read one page.
 * @param userId - The account.
 * @param query - The query string.
 * @returns Status and body.
 */
async function page(userId: string, query: string): Promise<{ status: number; body: { data?: { items: Array<Record<string, unknown>>; nextCursor: string | null } } }> {
  const res = await suite.app.request(`/api/v1/payment/history${query}&amountFormat=${CREDIT_AMOUNT_FORMAT}`, { headers: { cookie: await loginCookie(userId) } });
  return { status: res.status, body: (await res.json()) as never };
}

describe("purchase history", () => {
  it("merges the product's lots with the billing service's unlanded payments, newest first, across pages", async () => {
    const userId = await insertAccount(suite.sql);
    const bought = await lot(userId, "payment", "2026-11-20 10:00:00.000000+00");
    const gifted = await lot(userId, "gift", "2026-11-20 09:00:00.000000+00");
    const clearing = unlanded("2026-11-20 11:00:00.000000+00");
    const abandoned = unlanded("2026-11-20 08:00:00.000000+00");
    suite.reply = billingHistory([clearing, abandoned], new Set([bought]));

    const first = await page(userId, "?limit=2");

    expect(first.status).toBe(200);
    expect(first.body.data!.items.map((r) => r["rowId"])).toEqual([clearing["paymentId"], bought]);
    expect(first.body.data!.items[1]).toMatchObject({ sourceKind: "payment", paymentId: bought, totalCents: 1090, status: "completed", canResend: true });
    expect(first.body.data!.items[0]).toMatchObject({ sourceKind: "payment", paymentId: clearing["paymentId"], lifecycle: null, status: "pending" });

    const second = await page(userId, `?limit=2&cursor=${first.body.data!.nextCursor!}`);

    expect(second.body.data!.items.map((r) => r["rowId"])).toEqual([expect.any(String), abandoned["paymentId"]]);
    expect(second.body.data!.items[0]).toMatchObject({ sourceKind: "gift", giftOrigin: "registration", paymentId: null, canResend: false });
    expect(second.body.data!.nextCursor).toBeNull();
    expect(gifted).toBeTruthy();
  });

  it("lists a completed payment whose lot is gone or never opened, once each, across a page boundary", async () => {
    const userId = await insertAccount(suite.sql);
    const live = await lot(userId, "payment", "2026-11-20 11:00:00.000000+00");
    const noLot = await receiptOnly(userId, "2026-11-20 10:00:00.000000+00");
    const deletedLot = await lot(userId, "payment", "2026-11-20 09:00:00.000000+00");
    await suite.sql`UPDATE credit_lots SET deleted_at = now() WHERE source_id = ${deletedLot}`;
    await lot(userId, "gift", "2026-11-20 08:00:00.000000+00");
    suite.reply = billingHistory([], new Set([noLot]));

    const first = await page(userId, "?limit=2");
    const second = await page(userId, `?limit=2&cursor=${first.body.data!.nextCursor!}`);

    expect(first.body.data!.items.map((r) => r["rowId"])).toEqual([live, noLot]);
    expect(first.body.data!.items[1]).toMatchObject({
      sourceKind: "payment", paymentId: noLot, status: "completed", lifecycle: null, remainingCredits: null, totalCents: 1090, canResend: true,
    });
    expect(second.body.data!.items.map((r) => r["rowId"])).toEqual([deletedLot, expect.any(String)]);
    expect(second.body.data!.items[0]).toMatchObject({ sourceKind: "payment", paymentId: deletedLot, status: "completed", lifecycle: null, canResend: false });
    expect(second.body.data!.items[1]).toMatchObject({ sourceKind: "gift" });
    expect(second.body.data!.nextCursor).toBeNull();
  });

  it("asks the billing service about the returned page only, never the look-ahead row", async () => {
    const userId = await insertAccount(suite.sql);
    await suite.sql`
      WITH ids AS (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 101) AS n),
      src AS (INSERT INTO credit_sources(id,kind) SELECT id, 'payment' FROM ids),
      rec AS (INSERT INTO payment_receipts(id,user_id,amount_cents,currency,credits_granted,ordered_at)
        SELECT id, ${userId}, 100, 'usd', 100, now() - make_interval(mins => n) FROM ids)
      INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
      SELECT id, 'payment', ${userId}, 100, 100, 'active' FROM ids`;
    suite.reply = billingHistory([], new Set());

    const res = await page(userId, "?limit=100");

    expect(res.status).toBe(200);
    expect(res.body.data!.items).toHaveLength(100);
    const asked = suite.received.filter((r) => r.path.includes("/payment/mail-status")).map((r) => (r.body as { paymentIds: string[] }).paymentIds);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(100);
    expect(new Set(asked[0])).toEqual(new Set(res.body.data!.items.map((r) => r["paymentId"])));
  });

  it("asks about a page larger than the mail-status bound in chunks, and answers every row", async () => {
    pageBounds.max = 250;
    const userId = await insertAccount(suite.sql);
    await manyBought(userId, 230);
    const resendable = new Set<string>();
    // The stand-in holds each request to the contract, as the billing service's validate does.
    const answer = billingHistory([], resendable);
    suite.reply = (req) => (req.path.includes("/payment/mail-status") && !mailStatusRequestSchema.safeParse(req.body).success
      ? { status: 400, body: { error: { code: "VALIDATION_ERROR" } } }
      : answer(req));
    const ids = await suite.sql<{ id: string }[]>`SELECT id FROM payment_receipts WHERE user_id = ${userId} ORDER BY ordered_at DESC`;
    // Every third row can be resent, so a lost chunk shows as a wrong answer.
    ids.forEach((r, i) => {
      if (i % 3 === 0) resendable.add(r.id);
    });

    const res = await page(userId, "?limit=230");

    expect(res.status).toBe(200);
    expect(res.body.data!.items).toHaveLength(230);
    for (const item of res.body.data!.items) expect(item["canResend"]).toBe(resendable.has(item["paymentId"] as string));
    const asked = suite.received.filter((r) => r.path.includes("/payment/mail-status")).map((r) => (r.body as { paymentIds: string[] }).paymentIds);
    expect(asked.length).toBeGreaterThan(1);
    for (const chunk of asked) expect(chunk.length).toBeLessThanOrEqual(MAIL_STATUS_IDS_MAX);
    expect(new Set(asked.flat())).toEqual(new Set(res.body.data!.items.map((r) => r["paymentId"])));
    expect(asked.flat()).toHaveLength(230);
  });

  it("answers 503 billing_unavailable when the billing service cannot answer", async () => {
    const userId = await insertAccount(suite.sql);
    await lot(userId, "payment", "2026-11-20 10:00:00.000000+00");
    suite.reply = () => ({ status: 503, body: {} });

    const res = await page(userId, "?limit=5");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { reason: "billing_unavailable" } });
  });

  it("answers the product's own lots where nothing is sold", async () => {
    const userId = await insertAccount(suite.sql);
    const gifted = await lot(userId, "gift", "2026-11-20 09:00:00.000000+00");
    initCore(process.env);
    try {
      const res = await page(userId, "?limit=5");
      expect(res.status).toBe(200);
      expect(res.body.data!.items).toHaveLength(1);
      expect(res.body.data!.items[0]).toMatchObject({ sourceKind: "gift", canResend: false });
    } finally {
      initSellingCore(suite.billingUrl);
    }
    expect(suite.received).toEqual([]);
    expect(gifted).toBeTruthy();
  });
});
