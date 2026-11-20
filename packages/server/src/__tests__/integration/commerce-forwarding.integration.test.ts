// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The purchase, membership and referral endpoints the product hands to the
 * billing service (inner#1993 §3.2): each keeps its web path, auth and body
 * checks, forwards to the user's endpoint signed as `product` with the
 * request's language, and sends back what the billing service answered,
 * refusals included. A billing service out of reach is a 503
 * `billing_unavailable`; a deployment with none answers 404.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { initCore } from "@breatic/core";
import { initSellingCore, insertAccount, loginCookie, useCommerceApp } from "./commerce-harness.js";

const suite = useCommerceApp("commerce-forwarding");

/**
 * Send one request to the product as a signed-in account.
 * @param userId - The account.
 * @param method - The method.
 * @param path - The web path under `/api/v1`.
 * @param body - The JSON body, if any.
 * @param idempotencyKey - The key, if any.
 * @returns The response.
 */
async function send(userId: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: await loginCookie(userId) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  return suite.app.request(`/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const paymentId = randomUUID();

/** Web request → the billing service's path under the user, for each forwarded endpoint. */
const FORWARDED: Array<{ name: string; method: string; web: string; body?: unknown; keyed?: boolean; billing: string }> = [
  { name: "credit packs", method: "GET", web: "/payment/tiers", billing: "/payment/tiers" },
  { name: "purchase confirm", method: "POST", web: "/payment/confirm", body: { session_id: "cs_test_1" }, billing: "/payment/confirm" },
  { name: "purchase cancel", method: "POST", web: "/payment/cancel", body: { payment_id: paymentId }, billing: "/payment/cancel" },
  { name: "confirmation resend", method: "POST", web: `/payment/${paymentId}/resend-confirmation`, billing: `/payment/${paymentId}/resend-confirmation` },
  { name: "one purchase", method: "GET", web: `/payment/${paymentId}`, billing: `/payment/${paymentId}` },
  { name: "plan change", method: "POST", web: "/account/subscription/change", body: { tier: "team", period: "year" }, keyed: true, billing: "/subscription/change" },
  { name: "subscription cancel", method: "POST", web: "/account/subscription/cancel", billing: "/subscription/cancel" },
  { name: "subscription resume", method: "POST", web: "/account/subscription/resume", billing: "/subscription/resume" },
  { name: "referral panel", method: "GET", web: "/account/referral", billing: "/referral" },
  {
    name: "promoter application",
    method: "POST",
    web: "/account/referral/applications",
    body: { country: "SG", channels: ["blog"], plan: "posts", termsVersion: "v1" },
    keyed: true,
    billing: "/referral/applications",
  },
];

describe("forwarded endpoints", () => {
  it.each(FORWARDED)("forwards $name to the user's endpoint and sends its answer back", async (route) => {
    const userId = await insertAccount(suite.sql);
    const key = route.keyed === true ? `k-${randomUUID()}` : undefined;
    suite.reply = () => ({ status: 200, body: { data: { from: "billing" } } });

    const res = await send(userId, route.method, route.web, route.body, key);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { from: "billing" } });
    expect(suite.received).toEqual([
      {
        method: route.method,
        path: `/v1/users/${userId}${route.billing}?locale=en`,
        signer: "product",
        idempotencyKey: key ?? null,
        body: route.body ?? null,
      },
    ]);
  });

  it("adds the checkout snapshot to a credit checkout and carries the user's key", async () => {
    const userId = await insertAccount(suite.sql);
    const key = `k-${randomUUID()}`;
    const body = { price_cents: 1000, return_url: "https://app.example.test/credits", time_zone: "Asia/Singapore", consented: true };

    const res = await send(userId, "POST", "/payment/checkout", body, key);

    expect(res.status).toBe(200);
    expect(suite.received).toEqual([
      expect.objectContaining({
        path: `/v1/users/${userId}/payment/checkout?locale=en`,
        idempotencyKey: key,
        body: { ...body, checkoutSnapshot: { consent: expect.any(Object), click: null } },
      }),
    ]);
  });

  it("sends a refusal back as the billing service gave it", async () => {
    const userId = await insertAccount(suite.sql);
    const refusal = { error: { code: 422, message: "That code is not active.", reason: "code_inactive" } };
    suite.reply = () => ({ status: 422, body: refusal });

    const res = await send(userId, "GET", "/payment/tiers");

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refusal);
  });

  it("answers 503 billing_unavailable when the billing service cannot take it", async () => {
    const userId = await insertAccount(suite.sql);
    suite.reply = () => ({ status: 503, body: { error: { code: 503 } } });

    const res = await send(userId, "GET", "/payment/tiers");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 503, reason: "billing_unavailable", message: expect.not.stringMatching(/^server\./) } });
  });

  it("answers 404 and calls nothing where no billing service is configured", async () => {
    const userId = await insertAccount(suite.sql);
    initCore(process.env);
    try {
      for (const route of FORWARDED) {
        const res = await send(userId, route.method, route.web, route.body, route.keyed === true ? `k-${randomUUID()}` : undefined);
        expect(res.status, route.name).toBe(404);
      }
    } finally {
      initSellingCore(suite.billingUrl);
    }
    expect(suite.received).toEqual([]);
  });
});
