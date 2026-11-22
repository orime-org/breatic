// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The forwarded endpoints that do more than forward (inner#1993 §3.2, §5.5):
 * a membership checkout and a later referral binding send the account's
 * pending binding to the inbox themselves first, once, without touching its
 * attempts or backoff; a membership confirm answers the product's own
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
import { forwardNextCommerceEvent } from "@server/modules/commerce/commerce-relay.js";
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

/** A membership checkout's body. */
const CHECKOUT = { tier: "pro", period: "month", return_url: "https://app.example.test/m" };

/**
 * Push a pending binding into backoff, as the relay leaves it after failed attempts.
 * @param outboxId - The row.
 * @returns How the row stands.
 */
async function backOff(outboxId: string): Promise<{ attempts: number; next: string; last_error: string | null }> {
  const [row] = await suite.sql<{ attempts: number; next: string; last_error: string | null }[]>`
    UPDATE commerce_outbox SET attempts = 6, next_attempt_at = now() + interval '1 hour', last_error = 'billing down'
    WHERE id = ${outboxId} RETURNING attempts, next_attempt_at::text AS next, last_error`;
  return row!;
}

/**
 * How an outbox row stands now.
 * @param outboxId - The row.
 * @returns Its delivery state, or none once it left the outbox.
 */
async function outboxRow(outboxId: string): Promise<Array<{ sent: boolean; attempts: number; next: string; last_error: string | null }>> {
  return suite.sql`SELECT sent_at IS NOT NULL AS sent, attempts, next_attempt_at::text AS next, last_error FROM commerce_outbox WHERE id = ${outboxId}`;
}

/**
 * What the stand-in saw for one account: its inbox row and its user endpoints.
 * @param userId - The account.
 * @param outboxId - Its binding row.
 * @returns The paths, oldest first.
 */
function mine(userId: string, outboxId: string): string[] {
  return suite.received.map(pathOf).filter((p) => p === `/v1/inbox/${outboxId}` || p.startsWith(`/v1/users/${userId}/`));
}

describe("the pending referral binding goes first", () => {
  it("sends a binding in backoff itself before a membership checkout, as the relay would, and forwards the checkout", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    const before = await backOff(outboxId);
    suite.reply = (req) => (pathOf(req).startsWith("/v1/inbox/") ? { status: 200, body: { result: "applied" } } : { status: 200, body: { data: { url: "https://checkout" } } });

    const res = await send(userId, "POST", "/account/subscription/checkout", CHECKOUT);

    expect(res).toMatchObject({ status: 200, json: { data: { url: "https://checkout" } } });
    expect(mine(userId, outboxId)).toEqual([`/v1/inbox/${outboxId}`, `/v1/users/${userId}/subscription/checkout`]);
    const [seq] = await suite.sql<{ seq: string }[]>`SELECT seq::text AS seq FROM commerce_outbox WHERE id = ${outboxId}`;
    expect(suite.received[0]).toMatchObject({
      method: "POST",
      signer: "product",
      body: { type: "referral_binding", aggregateKey: `referral:${userId}`, seq: Number(seq!.seq), payload: { userId, code: "FRIEND" } },
    });
    expect(await outboxRow(outboxId)).toEqual([{ sent: true, attempts: 6, next: before.next, last_error: before.last_error }]);
  });

  it("refuses the checkout with 503 while the billing service is down, leaving the row exactly as it was", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    const before = await backOff(outboxId);
    suite.reply = () => ({ status: 503, body: {} });

    const res = await send(userId, "POST", "/account/subscription/checkout", CHECKOUT);

    expect(res).toMatchObject({ status: 503, json: { error: { reason: "billing_unavailable" } } });
    expect(mine(userId, outboxId)).toEqual([`/v1/inbox/${outboxId}`]);
    expect(await outboxRow(outboxId)).toEqual([{ sent: false, ...before }]);
  });

  it("moves a binding the inbox answers permanent_failure to the dead letters and forwards the checkout", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    suite.reply = (req) =>
      pathOf(req).startsWith("/v1/inbox/") ? { status: 200, body: { result: "permanent_failure", detail: "bad code" } } : { status: 200, body: { data: { url: "https://checkout" } } };

    const res = await send(userId, "POST", "/account/subscription/checkout", CHECKOUT);

    expect(res).toMatchObject({ status: 200, json: { data: { url: "https://checkout" } } });
    expect(mine(userId, outboxId)).toEqual([`/v1/inbox/${outboxId}`, `/v1/users/${userId}/subscription/checkout`]);
    expect(await outboxRow(outboxId)).toEqual([]);
    expect(await suite.sql`SELECT reason FROM commerce_outbox_dead_letters WHERE id = ${outboxId}`).toEqual([{ reason: "permanent_failure" }]);
  });

  it("lets the inbox decide once when the relay and the checkout send the same row at once", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    // Hold both deliveries until both have arrived, then answer the first applied and the second duplicate.
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((resolve) => (release = resolve));
    suite.reply = async (req) => {
      if (!pathOf(req).startsWith("/v1/inbox/")) return { status: 200, body: { data: { url: "https://checkout" } } };
      const n = ++arrived;
      if (n === 2) release();
      await both;
      return { status: 200, body: { result: n === 1 ? "applied" : "duplicate" } };
    };

    const [, res] = await Promise.all([forwardNextCommerceEvent(), send(userId, "POST", "/account/subscription/checkout", CHECKOUT)]);

    expect(res).toMatchObject({ status: 200, json: { data: { url: "https://checkout" } } });
    expect(mine(userId, outboxId)).toEqual([`/v1/inbox/${outboxId}`, `/v1/inbox/${outboxId}`, `/v1/users/${userId}/subscription/checkout`]);
    expect(await outboxRow(outboxId)).toMatchObject([{ sent: true, attempts: 0 }]);
  });

  it("sends the pending binding itself before a later binding", async () => {
    const userId = await insertAccount(suite.sql);
    const outboxId = await pendingBinding(userId);
    suite.reply = (req) => (pathOf(req).startsWith("/v1/inbox/") ? { status: 200, body: { result: "applied" } } : { status: 200, body: { data: { bound: true } } });

    await send(userId, "POST", "/account/referral/binding", { code: "OTHER" });

    expect(mine(userId, outboxId)).toEqual([`/v1/inbox/${outboxId}`, `/v1/users/${userId}/referral/binding`]);
    expect(await outboxRow(outboxId)).toMatchObject([{ sent: true, attempts: 0 }]);
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
