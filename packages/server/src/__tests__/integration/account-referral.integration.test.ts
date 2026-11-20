// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A later referral binding (inner#1993 §3.2, §8.4): the product checks the
 * body, sends the account's pending sign-up binding first, then forwards the
 * request to the billing service, which decides it. Where nothing is sold
 * the route does not exist.
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

const suite = useCommerceApp("account-referral");

/**
 * Ask for a later binding as a signed-in account.
 * @param userId - The account.
 * @param body - The JSON body.
 * @param key - The idempotency key.
 * @returns The response.
 */
async function bind(userId: string, body: unknown, key = `k-${randomUUID()}`): Promise<Response> {
  return suite.app.request("/api/v1/account/referral/binding", {
    method: "POST",
    headers: { cookie: await loginCookie(userId), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

describe("a later referral binding", () => {
  it("forwards straight to the user's endpoint when nothing is pending, and sends the answer back", async () => {
    const userId = await insertAccount(suite.sql);
    const key = `k-${randomUUID()}`;
    suite.reply = () => ({ status: 200, body: { data: { bound: true } } });

    const res = await bind(userId, { code: "OTHER" }, key);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { bound: true } });
    expect(suite.received).toEqual([
      { method: "POST", path: `/v1/users/${userId}/referral/binding?locale=en`, signer: "product", idempotencyKey: key, body: { code: "OTHER" } },
    ]);
  });

  it("answers 503 and forwards nothing while the pending sign-up binding cannot be sent", async () => {
    const userId = await insertAccount(suite.sql);
    const [row] = await suite.sql<{ id: string }[]>`
      INSERT INTO commerce_outbox(aggregate_key,type,payload)
      VALUES (${`referral:${userId}`},'referral_binding',${suite.sql.json({ userId, code: "FRIEND", source: "signup_typed", requestedAt: new Date().toISOString() })})
      RETURNING id`;
    suite.reply = () => ({ status: 503, body: {} });

    const res = await bind(userId, { code: "OTHER" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "billing_unavailable" } });
    expect(suite.received.map((r) => r.path.split("?")[0])).toEqual([`/v1/inbox/${row!.id}`]);
  });

  it("refuses an empty code without asking the billing service", async () => {
    const userId = await insertAccount(suite.sql);

    const res = await bind(userId, { code: "" });

    expect(res.status).toBe(422);
    expect(suite.received).toEqual([]);
  });

  it("answers 404 where nothing is sold", async () => {
    const userId = await insertAccount(suite.sql);
    initCore(process.env);
    try {
      expect((await bind(userId, { code: "OTHER" })).status).toBe(404);
    } finally {
      initSellingCore(suite.billingUrl);
    }
    expect(suite.received).toEqual([]);
  });
});
