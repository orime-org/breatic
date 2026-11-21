// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A sign-up's referral code (inner#1993 §8.4): the billing service checks it
 * before the account is created, and the account's creating transaction
 * appends it to the outbox for the billing service to bind. A code the
 * billing service calls inactive refuses the sign-up on the paths that refuse
 * and is dropped on the one that skips; a billing service out of reach keeps
 * the code for it to decide on delivery, and the sign-up hears "pending".
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { getCommerceConfig, initCore, referralBindingEventSchema } from "@breatic/core";
import { SignupReferralRefused, createAccount } from "@server/modules/auth/auth.service.js";
import { startCommerceRelay } from "@server/modules/commerce/commerce-relay.js";
import { initSellingCore, useCommerceApp } from "./commerce-harness.js";

const suite = useCommerceApp("commerce-signup-referral");

/**
 * Create an account carrying a code.
 * @param onRefused - What to do when the code is refused.
 * @returns The account's id and what became of the code.
 */
async function signUp(onRefused: "reject" | "skip"): Promise<{ userId: string; referral: unknown }> {
  const { user, referral } = await createAccount(
    { email: `signup-${randomUUID()}@example.test`, locale: "en", emailVerified: true },
    { code: "friend-2026", source: "signup_typed", onRefused },
  );
  return { userId: user.id, referral };
}

/**
 * The binding rows appended for an account.
 * @param userId - The account.
 * @returns Their payloads.
 */
async function bindings(userId: string): Promise<unknown[]> {
  const rows = await suite.sql<{ payload: unknown }[]>`SELECT payload FROM commerce_outbox WHERE aggregate_key = ${`referral:${userId}`}`;
  return rows.map((r) => r.payload);
}

describe("sign-up referral codes", () => {
  it("binds a code the billing service calls active, in the stored form it answers", async () => {
    suite.reply = () => ({ status: 200, body: { active: true, code: "FRIEND-2026" } });

    const { userId, referral } = await signUp("reject");

    expect(referral).toBe("applied");
    expect(suite.received).toEqual([expect.objectContaining({ method: "POST", path: "/v1/referral-codes/check", body: { code: "friend-2026" } })]);
    expect(await bindings(userId)).toEqual([{ userId, code: "FRIEND-2026", source: "signup_typed", requestedAt: expect.any(String) }]);
    expect((await bindings(userId)).every((payload) => referralBindingEventSchema.safeParse(payload).success)).toBe(true);
  });

  it("refuses the sign-up on a refusing path when the code is inactive, creating nothing", async () => {
    suite.reply = () => ({ status: 200, body: { active: false, code: "friend-2026" } });
    const before = await suite.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;

    await expect(signUp("reject")).rejects.toBeInstanceOf(SignupReferralRefused);

    expect(await suite.sql`SELECT count(*)::int AS n FROM users`).toEqual(before);
  });

  it("creates the account unbound on the skipping path when the code is inactive", async () => {
    suite.reply = () => ({ status: 200, body: { active: false, code: "friend-2026" } });

    const { userId, referral } = await signUp("skip");

    expect(referral).toBe("not_applied");
    expect(await bindings(userId)).toEqual([]);
  });

  it("keeps the code for the billing service to decide when it cannot be asked, and says it is pending", async () => {
    suite.reply = () => ({ status: 503, body: {} });

    const { userId, referral } = await signUp("reject");

    expect(referral).toBe("pending");
    expect(await bindings(userId)).toEqual([{ userId, code: "friend-2026", source: "signup_typed", requestedAt: expect.any(String) }]);
  });

  it("ignores the code where nothing is sold, and says so to the sign-up page", async () => {
    initCore(process.env);
    try {
      const { userId, referral } = await signUp("reject");
      expect(referral).toBeNull();
      expect(await bindings(userId)).toEqual([]);
      const options = await suite.app.request("/api/v1/auth/options");
      expect(await options.json()).toMatchObject({ data: { referralEnabled: false } });
    } finally {
      initSellingCore(suite.billingUrl);
    }
    expect(suite.received).toEqual([]);
    const options = await suite.app.request("/api/v1/auth/options");
    expect(await options.json()).toMatchObject({ data: { referralEnabled: true } });
  });

  it("wakes a started relay once the account commits, so the binding is delivered long before the next poll", async () => {
    expect(getCommerceConfig().relay_interval_ms).toBe(5000);
    suite.reply = (req) =>
      req.path.startsWith("/v1/inbox/") ? { status: 200, body: { result: "applied" } } : { status: 200, body: { active: true, code: "FRIEND-2026" } };
    const relay = startCommerceRelay();
    try {
      // Let the first pass, which runs at start, finish whatever earlier files left.
      await vi.waitFor(async () => {
        const [r] = await suite.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commerce_outbox WHERE sent_at IS NULL AND next_attempt_at <= now()`;
        expect(r!.n).toBe(0);
      }, { timeout: 4000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      const { userId } = await signUp("reject");
      await vi.waitFor(async () => {
        expect(await suite.sql`SELECT sent_at IS NOT NULL AS sent FROM commerce_outbox WHERE aggregate_key = ${`referral:${userId}`}`).toEqual([{ sent: true }]);
      }, { timeout: 1000, interval: 20 });
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      relay.stop();
    }
  });
});
