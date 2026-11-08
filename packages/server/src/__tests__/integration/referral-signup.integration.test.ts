// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { initCore, loadLocales } from "@breatic/core";

import * as authService from "@server/modules/auth/auth.service";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "referral-signup-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Inserts an approved promoter holding a code in the given status.
 * @param status - The code's status.
 * @returns The code.
 */
async function code(status: "active" | "disabled" = "active"): Promise<string> {
  const promoterId = randomUUID();
  await sql`insert into users(id,email) values(${promoterId},${`${promoterId}@example.test`})`;
  const value = `S${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const [app] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${promoterId},'approved','US',${sql.json(["x"])},'p','2026-11-07',now(),now(),'admin_7') returning id`;
  await sql`insert into referral_codes(code,promoter_id,application_id,status) values(${value},${promoterId},${app!.id},${status})`;
  return value;
}

/**
 * Reads the binding of the account with this email.
 * @param email - The account's email.
 * @returns The bound code and source, or null.
 */
async function bindingOfEmail(email: string): Promise<{ code: string; source: string } | null> {
  const [row] = await sql<{ code: string; source: string }[]>`select c.code, b.source from referral_bindings b
    join referral_codes c on c.id = b.referral_code_id join users u on u.id = b.user_id where u.email = ${email}`;
  return row ?? null;
}

const email = (): string => `signup-${randomUUID()}@example.test`;

describe("signing up by email with a referral code", () => {
  it("creates the account and binds the code in one go", async () => {
    const value = await code();
    const address = email();
    const result = await authService.register(address, "correct horse battery", null, { code: value.toLowerCase(), source: "signup_link" });
    expect(result.referral).toBe("applied");
    expect(await bindingOfEmail(address)).toEqual({ code: value, source: "signup_link" });
  });

  it("refuses an invalid code with 422 and creates no account", async () => {
    const address = email();
    await expect(authService.register(address, "correct horse battery", null, { code: "NOPE-NOPE", source: "signup_typed" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await sql`select 1 from users where email = ${address}`).toHaveLength(0);
  });

  it("creates the account with no binding when no code is given", async () => {
    const address = email();
    const result = await authService.register(address, "correct horse battery");
    expect(result.referral).toBeNull();
    expect(await bindingOfEmail(address)).toBeNull();
  });
});

describe("signing in with Google with a referral code", () => {
  it("binds the code to a new account", async () => {
    const value = await code();
    const address = email();
    const result = await authService.loginOrCreateGoogle(`g-${randomUUID()}`, address, true, null, { code: value, source: "signup_typed" });
    expect(result.created).toBe(true);
    expect(result.referral).toBe("applied");
    expect(await bindingOfEmail(address)).toEqual({ code: value, source: "signup_typed" });
  });

  it("refuses an invalid code for a new account with 422 and creates nothing", async () => {
    const address = email();
    await expect(authService.loginOrCreateGoogle(`g-${randomUUID()}`, address, true, null, { code: "NOPE-NOPE", source: "signup_link" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await sql`select 1 from users where email = ${address}`).toHaveLength(0);
  });

  it("does not bind on signing in to an existing account and says the code was not used", async () => {
    const value = await code();
    const googleId = `g-${randomUUID()}`;
    const address = email();
    await authService.loginOrCreateGoogle(googleId, address, true);
    const again = await authService.loginOrCreateGoogle(googleId, address, true, null, { code: value, source: "signup_link" });
    expect(again.created).toBe(false);
    expect(again.referral).toBe("not_applied");
    expect(await bindingOfEmail(address)).toBeNull();
  });
});
