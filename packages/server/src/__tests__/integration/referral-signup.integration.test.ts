// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one-step email sign-up and Google sign-in carrying a referral code
 * (inner#1993 §8.4): both refuse a code the billing service calls inactive,
 * and a new account appends an active code to the outbox; signing in to an
 * existing account uses no code.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import * as authService from "@server/modules/auth/auth.service";
import { useCommerceApp } from "./commerce-harness.js";

const suite = useCommerceApp("referral-signup-test");

/** The stand-in calls the code active, in upper case. */
function activeCodes(): void {
  suite.reply = (req) => ({ status: 200, body: { active: true, code: String((req.body as { code: string }).code).toUpperCase() } });
}

/** The stand-in calls the code inactive. */
function inactiveCodes(): void {
  suite.reply = (req) => ({ status: 200, body: { active: false, code: (req.body as { code: string }).code } });
}

/**
 * Reads the binding appended for the account with this email.
 * @param email - The account's email.
 * @returns The appended code and source, or null.
 */
async function bindingOfEmail(email: string): Promise<{ code: string; source: string } | null> {
  const [row] = await suite.sql<{ payload: { code: string; source: string } }[]>`select o.payload from commerce_outbox o
    join users u on o.aggregate_key = 'referral:' || u.id::text where o.type = 'referral_binding' and u.email = ${email}`;
  return row === undefined ? null : { code: row.payload.code, source: row.payload.source };
}

const email = (): string => `signup-${randomUUID()}@example.test`;

describe("signing up by email with a referral code", () => {
  it("creates the account and appends the code in its stored form", async () => {
    activeCodes();
    const address = email();
    const result = await authService.register(address, "correct horse battery", null, { code: "friend-1", source: "signup_link" });
    expect(result.referral).toBe("applied");
    expect(await bindingOfEmail(address)).toEqual({ code: "FRIEND-1", source: "signup_link" });
  });

  it("refuses an inactive code with 422 and creates no account", async () => {
    inactiveCodes();
    const address = email();
    await expect(authService.register(address, "correct horse battery", null, { code: "NOPE-NOPE", source: "signup_typed" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await suite.sql`select 1 from users where email = ${address}`).toHaveLength(0);
  });

  it("creates the account with no binding, asking nothing, when no code is given", async () => {
    const address = email();
    const result = await authService.register(address, "correct horse battery");
    expect(result.referral).toBeNull();
    expect(await bindingOfEmail(address)).toBeNull();
    expect(suite.received).toEqual([]);
  });
});

describe("signing in with Google with a referral code", () => {
  it("appends the code for a new account", async () => {
    activeCodes();
    const address = email();
    const result = await authService.resolveGoogleAccount(`g-${randomUUID()}`, address, true, null, { code: "FRIEND-2", source: "signup_typed" });
    expect(result.created).toBe(true);
    expect(result.referral).toBe("applied");
    expect(await bindingOfEmail(address)).toEqual({ code: "FRIEND-2", source: "signup_typed" });
  });

  it("refuses an inactive code for a new account with 422 and creates nothing", async () => {
    inactiveCodes();
    const address = email();
    await expect(authService.resolveGoogleAccount(`g-${randomUUID()}`, address, true, null, { code: "NOPE-NOPE", source: "signup_link" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await suite.sql`select 1 from users where email = ${address}`).toHaveLength(0);
  });

  it("does not ask or bind on signing in to an existing account, and says the code was not used", async () => {
    const googleId = `g-${randomUUID()}`;
    const address = email();
    await authService.resolveGoogleAccount(googleId, address, true);
    activeCodes();
    const again = await authService.resolveGoogleAccount(googleId, address, true, null, { code: "FRIEND-3", source: "signup_link" });
    expect(again.created).toBe(false);
    expect(again.referral).toBe("not_applied");
    expect(await bindingOfEmail(address)).toBeNull();
    expect(suite.received).toEqual([]);
  });
});
