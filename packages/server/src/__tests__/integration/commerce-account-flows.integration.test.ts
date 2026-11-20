// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The forwarded endpoints that do more than forward (inner#1993 §3.2): a
 * membership checkout and a later referral binding send the account's
 * pending binding first; a membership confirm answers the product's own
 * panel; the credits overview asks the billing service to retry ungranted
 * payments and answers regardless; the membership panel quotes the billing
 * service's prices and falls back to the last ones it quoted.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { CREDIT_AMOUNT_FORMAT } from "@breatic/shared";
import { insertAccount, loginCookie, useCommerceApp, type BillingRequest } from "./commerce-harness.js";

const suite = useCommerceApp("commerce-account-flows");

/**
 * Send one request to the product as a signed-in account.
 * @param userId - The account.
 * @param method - The method.
 * @param path - The web path under `/api/v1`.
 * @param body - The JSON body, if any.
 * @returns Status and parsed body.
 */
async function send(userId: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: await loginCookie(userId) };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `k-${randomUUID()}`;
  }
  const res = await suite.app.request(`/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/**
 * Leave an account's sign-up code waiting in the outbox.
 * @param userId - The account.
 * @returns The outbox row's id.
 */
async function pendingBinding(userId: string): Promise<string> {
  const [row] = await suite.sql<{ id: string }[]>`
    INSERT INTO commerce_outbox(aggregate_key,type,payload)
    VALUES (${`referral:${userId}`},'referral_binding',${suite.sql.json({ userId, code: "FRIEND", source: "signup_typed", requestedAt: new Date().toISOString() })})
    RETURNING id`;
  return row!.id;
}

/**
 * The path a request reached, without its query.
 * @param req - The request.
 * @returns Its path.
 */
function pathOf(req: BillingRequest): string {
  return req.path.split("?")[0]!;
}

describe("the pending referral binding goes first", () => {
  it("sends it before a membership checkout", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    suite.reply = (req) => (pathOf(req).startsWith("/v1/inbox/") ? { status: 200, body: { result: "applied" } } : { status: 200, body: { data: { url: "https://checkout" } } });

    const res = await send(userId, "POST", "/account/subscription/checkout", { tier: "pro", period: "month", return_url: "https://app.example.test/m" });

    expect(res).toMatchObject({ status: 200, json: { data: { url: "https://checkout" } } });
    expect(suite.received.map(pathOf)).toEqual([`/v1/inbox/${outboxId}`, `/v1/users/${userId}/subscription/checkout`]);
    expect(await suite.sql`SELECT sent_at IS NOT NULL AS sent FROM commerce_outbox WHERE id = ${outboxId}`).toEqual([{ sent: true }]);
  });

  it("refuses the checkout with 503 while the binding cannot be sent, and keeps it for the relay", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    suite.reply = () => ({ status: 503, body: {} });

    const res = await send(userId, "POST", "/account/subscription/checkout", { tier: "pro", period: "month", return_url: "https://app.example.test/m" });

    expect(res).toMatchObject({ status: 503, json: { error: { reason: "billing_unavailable" } } });
    expect(suite.received.map(pathOf)).toEqual([`/v1/inbox/${outboxId}`]);
    expect(await suite.sql`SELECT sent_at IS NULL AS unsent, attempts FROM commerce_outbox WHERE id = ${outboxId}`).toEqual([{ unsent: true, attempts: 1 }]);
  });

  it("sends it before a later binding", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    suite.reply = (req) => (pathOf(req).startsWith("/v1/inbox/") ? { status: 200, body: { result: "applied" } } : { status: 200, body: { data: { bound: true } } });

    await send(userId, "POST", "/account/referral/binding", { code: "OTHER" });

    expect(suite.received.map(pathOf)).toEqual([`/v1/inbox/${outboxId}`, `/v1/users/${userId}/referral/binding`]);
  });
});

describe("membership confirm", () => {
  it("answers the product's own panel, withholding the conversion when ads may not run", async () => {
    const userId = await insertAccount(suite.sql);
    suite.reply = () => ({ status: 200, body: { data: { conversion: { transactionId: "sub:x", amountCents: 2000, currency: "usd" } } } });

    const res = await send(userId, "POST", "/account/subscription/confirm", { session_id: "cs_test_1" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ data: { tier: "base", catalog: expect.any(Array), conversion: null } });
  });
});

describe("credits overview", () => {
  it("asks the billing service to retry ungranted payments and answers either way", async () => {
    const userId = await insertAccount(suite.sql);
    suite.reply = () => ({ status: 503, body: {} });

    const res = await send(userId, "GET", `/credits/overview?amountFormat=${CREDIT_AMOUNT_FORMAT}`);

    expect(res.status).toBe(200);
    expect(suite.received.map((r) => [r.method, pathOf(r)])).toEqual([["POST", `/v1/users/${userId}/payment/reconcile`]]);
  });
});

describe("membership panel", () => {
  const prices = { pro: { month: { priceCents: 2000, currency: "usd" }, year: null }, team: { month: null, year: { priceCents: 50000, currency: "usd" } } };

  it("quotes no price before the billing service has ever answered", async () => {
    const userId = await insertAccount(suite.sql);
    suite.reply = () => ({ status: 503, body: {} });

    const res = await send(userId, "GET", "/account/membership");

    expect(res.status).toBe(200);
    const catalog = (res.json["data"] as { catalog: Array<{ tier: string; prices: unknown }> }).catalog;
    expect(catalog.every((row) => JSON.stringify(row.prices) === JSON.stringify({ month: null, year: null }))).toBe(true);
  });

  it("quotes the billing service's prices and its invoice page, then the last prices when it cannot answer", async () => {
    const userId = await insertAccount(suite.sql);
    suite.reply = () => ({ status: 200, body: { data: { prices, payableInvoiceUrl: "https://invoice.example/1" } } });

    const quoted = await send(userId, "GET", "/account/membership");
    suite.reply = () => ({ status: 503, body: {} });
    const fallback = await send(userId, "GET", "/account/membership");

    const pricesOf = (json: Record<string, unknown>, tier: string): unknown =>
      (json["data"] as { catalog: Array<{ tier: string; prices: unknown }> }).catalog.find((row) => row.tier === tier)?.prices;
    expect(pricesOf(quoted.json, "pro")).toEqual(prices.pro);
    expect(pricesOf(quoted.json, "base")).toEqual({ month: null, year: null });
    expect(pricesOf(fallback.json, "team")).toEqual(prices.team);
    expect(suite.received.map(pathOf)).toEqual([`/v1/users/${userId}/membership-panel`, `/v1/users/${userId}/membership-panel`]);
  });
});
