// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The billing service's endpoints on the internal listener (inner#1993 §3.1,
 * §3.3), driven over a real socket and signed as `commerce`: each route
 * reaches its service, bodies are checked, only the `commerce` signer gets
 * in, and its requests count against `commerce-api` alone.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { env, getRedis } from "@breatic/core";
import { COMMERCE_SECRET, call, useInternalApp, type CallOptions } from "./internal-api-harness.js";

const suite = useInternalApp("commerce-routes");

/**
 * Send one request signed by the billing service.
 * @param path - Path under the commerce prefix.
 * @param opts - What to send.
 * @returns What came back.
 */
function commerce(path: string, opts: CallOptions = {}): ReturnType<typeof call> {
  return call(suite.baseUrl, `/internal/v1/commerce${path}`, { admin: "commerce", secret: COMMERCE_SECRET, ...opts });
}

/**
 * The rate-limit buckets one limit name holds.
 * @param name - The limit.
 * @returns How many keys it has.
 */
async function buckets(name: string): Promise<number> {
  // One SCAN call covers only part of the keyspace; keys other files left make the first call miss.
  let count = 0;
  let cursor = "0";
  do {
    const [next, keys] = await getRedis().scan(cursor, "MATCH", `${env.ENV}:ratelimit:${name}*`, "COUNT", 1000);
    count += keys.length;
    cursor = next;
  } while (cursor !== "0");
  return count;
}

describe("commerce routes", () => {
  it("routes each endpoint to its service", async () => {
    const nobody = randomUUID();
    const unknown = { code: "account_not_found" };

    expect(await commerce(`/accounts/${nobody}`)).toMatchObject({ status: 404, json: unknown });
    expect(await commerce("/accounts/lookup", { body: { userIds: [nobody] } })).toMatchObject({ status: 200, json: [] });
    expect(await commerce("/refund-lots/facts", { body: { lotIds: [randomUUID()] } })).toMatchObject({ status: 200, json: [] });
    expect(
      await commerce("/conversions", {
        body: { name: "subscription_renewed", userId: nobody, insertId: `evt_${randomUUID()}`, properties: {}, consent: "account", ads: null },
      }),
    ).toMatchObject({ status: 404, json: unknown });
    expect(
      await commerce(`/subscription-facts/${randomUUID()}`, {
        method: "PUT",
        body: {
          userId: nobody,
          fact: {
            stripeSubscriptionId: `sub_${randomUUID()}`, tier: "pro", period: "month", status: "active", currentPeriodEnd: null,
            cancelAtPeriodEnd: false, hasPendingUpdate: false, pendingTier: null, pendingPeriod: null,
            observedAt: "2026-11-20T10:00:00.000Z", firstActiveAt: null,
          },
          notices: [],
          started: null,
          referenceId: "evt_route",
        },
      }),
    ).toMatchObject({ status: 404, json: unknown });
    expect(
      await commerce(`/payment-grants/${randomUUID()}`, {
        body: {
          userId: nobody, purchasedCredits: 100, amountCents: 100, taxCents: null, totalCents: null, currency: "usd",
          orderedAt: "2026-11-20T10:00:00.000Z", conversion: { consent: { analytics: false, ads: false }, click: null, transactionId: "tx" },
        },
      }),
    ).toMatchObject({ status: 404, json: unknown });
    expect(
      await commerce(`/refund-steps/${randomUUID()}/mark_refunding`, {
        body: { lotId: randomUUID(), step: "mark_refunding", referenceId: "op", settled: null, tell: null },
      }),
    ).toMatchObject({ status: 404, json: { code: "lot_not_found" } });
  });

  it("refuses a malformed body, text the database cannot store and a step the path does not name", async () => {
    expect(await commerce("/refund-lots/facts", { body: { lotIds: Array.from({ length: 101 }, () => randomUUID()) } })).toMatchObject({
      status: 422,
      json: { code: "invalid_body" },
    });
    expect(
      await commerce(`/refund-steps/${randomUUID()}/settle`, { body: { lotId: randomUUID(), step: "reject", referenceId: "op", settled: null, tell: null } }),
    ).toMatchObject({ status: 422, json: { code: "invalid_body" } });
    expect(
      await commerce(`/refund-steps/${randomUUID()}/settle`, { body: { lotId: randomUUID(), step: "settle", referenceId: "o\u0000p", settled: { amountCents: 1, currency: "usd" }, tell: null } }),
    ).toMatchObject({ status: 422, json: { code: "invalid_body" } });
    expect(
      await commerce(`/refund-steps/${randomUUID()}/settle`, { body: { lotId: randomUUID(), step: "settle", referenceId: "re", settled: null, tell: null } }),
    ).toMatchObject({ status: 422, json: { code: "invalid_body" } });
  });

  it("lets only the billing service in, and only here", async () => {
    expect((await call(suite.baseUrl, `/internal/v1/commerce/accounts/${randomUUID()}`)).status).toBe(403);
    expect((await call(suite.baseUrl, `/internal/v1/accounts/${randomUUID()}/credit-grants/profile`, { admin: "commerce", secret: COMMERCE_SECRET })).status).toBe(403);
  });

  it("counts the billing service's requests against its own limit", async () => {
    // Other files' back-office calls may have left internal-api buckets behind.
    const internalBefore = await buckets("internal-api");

    await commerce(`/accounts/${randomUUID()}`);

    expect(await buckets("commerce-api")).toBeGreaterThan(0);
    expect(await buckets("internal-api")).toBe(internalBefore);
  });
});
