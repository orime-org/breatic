// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purchase history (inner#1993 §3.2 #5): the product's own lots (bought,
 * gifted) merged, newest first, with the payments the billing service holds
 * that opened no lot yet, one keyset across both; whether a bought row's
 * letter can be sent again is the billing service's answer. A deployment
 * that sells nothing answers its own lots only.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { decodeActivityCursor, initCore } from "@breatic/core";
import { CREDIT_AMOUNT_FORMAT } from "@breatic/shared";
import { initSellingCore, insertAccount, loginCookie, useCommerceApp, type BillingRequest } from "./commerce-harness.js";
import { recordPaymentReceipt } from "./payment-source.js";

const suite = useCommerceApp("commerce-purchase-history");

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
