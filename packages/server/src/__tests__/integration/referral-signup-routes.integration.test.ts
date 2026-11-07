// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";

loadLocales();

const PAYMENTS = { STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite", STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite" };
let sql: ReturnType<typeof postgres>;
let app: Hono;

/**
 * Starts core with email sign-up taking no code and payments on or off.
 * @param payments - Whether payments are enabled.
 */
function start(payments: boolean): void {
  initCore({ ...process.env, ...PAYMENTS, EMAIL_BACKEND: "disabled", PAYMENT_ENABLED: payments ? "true" : "false" });
}

beforeAll(async () => {
  start(true);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});
afterEach(async () => {
  const throttled = await getRedis().keys(`${env.ENV}:ratelimit:register*`);
  if (throttled.length > 0) await getRedis().del(...throttled);
  start(true);
});
afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * Inserts an approved promoter with an active code.
 * @returns The code.
 */
async function activeCode(): Promise<string> {
  const promoterId = crypto.randomUUID();
  await sql`insert into users(id,email) values(${promoterId},${`${promoterId}@example.test`})`;
  const code = `W${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const [row] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${promoterId},'approved','US',${sql.json(["x"])},'p','2026-11-07',now(),now(),'admin_7') returning id`;
  await sql`insert into referral_codes(code,promoter_id,application_id) values(${code},${promoterId},${row!.id})`;
  return code;
}

/**
 * Registers through the route.
 * @param body - Extra body fields.
 * @returns The email used and the response.
 */
async function register(body: Record<string, unknown>): Promise<{ email: string; res: Response }> {
  const email = `ref-route-${crypto.randomUUID()}@example.test`;
  const res = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", ...body }),
  });
  return { email, res };
}

describe("sign-up with a referral code while payments are on", () => {
  it("tells the sign-up page the code field exists", async () => {
    const res = await app.request("/api/v1/auth/options");
    expect(await res.json()).toEqual({ data: { emailVerification: false, referralEnabled: true } });
  });

  it("creates the account and binds the code carried in from a link", async () => {
    const code = await activeCode();
    const { email, res } = await register({ referralCode: code.toLowerCase(), referralSource: "signup_link" });
    expect(res.status).toBe(201);
    const [row] = await sql`select b.source from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`;
    expect(row).toEqual({ source: "signup_link" });
  });

  it("refuses an invalid code as a field error and creates no account", async () => {
    const { email, res } = await register({ referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { reason: string; field: string; message: string } };
    expect(body.error).toMatchObject({ reason: "invalid_code", field: "referralCode" });
    expect(body.error.message).not.toBe("");
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it("treats a blank code as no code", async () => {
    const { res } = await register({ referralCode: "   ", referralSource: "signup_typed" });
    expect(res.status).toBe(201);
  });
});

describe("sign-up with a referral code while payments are off", () => {
  it("hides the code field and ignores any code sent", async () => {
    start(false);
    expect(await (await app.request("/api/v1/auth/options")).json()).toEqual({ data: { emailVerification: false, referralEnabled: false } });
    const { email, res } = await register({ referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(201);
    expect(await sql`select 1 from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`).toHaveLength(0);
  });
});
