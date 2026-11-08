// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const sent = vi.hoisted(() => ({ mails: [] as { to: string; text: string }[] }));
vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  sendMail: async (mail: { to: string; text: string }) => {
    sent.mails.push(mail);
    return { status: "sent" };
  },
}));

// Google's token check is answered here; the rest of the route runs for real.
const google = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken: google.verifyIdToken })),
}));

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
 * Starts core with payments on or off and Google sign-in configured.
 * @param payments - Whether payments are enabled.
 * @param emailBackend - `disabled` for one-step sign-up, `console` for the two-step one with a code.
 */
function start(payments: boolean, emailBackend: "disabled" | "console" = "disabled"): void {
  initCore({
    ...process.env,
    ...PAYMENTS,
    EMAIL_BACKEND: emailBackend,
    PAYMENT_ENABLED: payments ? "true" : "false",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  });
}

beforeAll(async () => {
  start(true);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});
afterEach(async () => {
  const throttled = [
    ...(await getRedis().keys(`${env.ENV}:ratelimit:register*`)),
    ...(await getRedis().keys(`${env.ENV}:ratelimit:google*`)),
  ];
  if (throttled.length > 0) await getRedis().del(...throttled);
  sent.mails.length = 0;
  google.verifyIdToken.mockReset();
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

/**
 * POSTs a JSON body to an auth route.
 * @param path - The route under `/api/v1/auth`.
 * @param body - The JSON body.
 * @param cookie - A Cookie header to send.
 * @returns The response.
 */
async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return await app.request(`/api/v1/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * Runs step one of the two-step sign-up and answers step two with the mailed code.
 * @param referralCode - The code step one carries.
 * @param between - What happens between the two steps.
 * @returns The email used and step two's response.
 */
async function signUpInTwoSteps(referralCode: string, between: () => Promise<void> = async () => {}): Promise<{ email: string; res: Response }> {
  const email = `ref-route-${crypto.randomUUID()}@example.test`;
  const first = await post("/register", { email, password: "correct horse battery", referralCode, referralSource: "signup_typed" });
  expect(first.status).toBe(202);
  const ticket = first.headers.getSetCookie().find((c) => c.startsWith("breatic_signup_"))!.split(";")[0]!;
  const mailed = /\b(\d{6})\b/.exec(sent.mails.at(-1)!.text)![1]!;
  await between();
  return { email, res: await post("/register/verify", { code: mailed }, ticket) };
}

describe("two-step sign-up with a referral code", () => {
  it("refuses an invalid code at step one as a field error and sends no mail", async () => {
    start(true, "console");
    const res = await post("/register", {
      email: `ref-route-${crypto.randomUUID()}@example.test`,
      password: "correct horse battery",
      referralCode: "NOPE-NOPE",
      referralSource: "signup_typed",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: object }).error).toMatchObject({ reason: "invalid_code", field: "referralCode" });
    expect(sent.mails).toHaveLength(0);
  });

  it("says the code was applied and binds it", async () => {
    start(true, "console");
    const code = await activeCode();
    const { email, res } = await signUpInTwoSteps(code);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { referral?: string } }).data.referral).toBe("applied");
    const [row] = await sql`select b.source from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`;
    expect(row).toEqual({ source: "signup_typed" });
  });

  it("says the code was not applied when it was disabled between the steps", async () => {
    start(true, "console");
    const code = await activeCode();
    const { email, res } = await signUpInTwoSteps(code, async () => {
      await sql`update referral_codes set status = 'disabled' where code = ${code}`;
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { referral?: string } }).data.referral).toBe("not_applied");
    expect(await sql`select 1 from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`).toHaveLength(0);
  });
});

/**
 * Signs in with Google as one Google account.
 * @param sub - The Google account id.
 * @param email - Its address.
 * @param body - Extra body fields.
 * @returns The response.
 */
async function googleSignIn(sub: string, email: string, body: Record<string, unknown> = {}): Promise<Response> {
  google.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ iss: "https://accounts.google.com", sub, email, email_verified: true }),
  });
  return await post("/google", { credential: "signed-token", ...body });
}

describe("Google sign-in with a referral code", () => {
  it("refuses an invalid code for a new account as a field error and creates no account", async () => {
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: object }).error).toMatchObject({ reason: "invalid_code", field: "referralCode" });
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it("binds a code carried into a new account and says it was applied", async () => {
    const code = await activeCode();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: code, referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: boolean; referral?: string } }).data).toMatchObject({ created: true, referral: "applied" });
    const [row] = await sql`select b.source from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`;
    expect(row).toEqual({ source: "signup_link" });
  });

  it("says a code carried into an existing account was not applied, and binds nothing", async () => {
    const sub = crypto.randomUUID();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    expect((await googleSignIn(sub, email)).status).toBe(200);
    const code = await activeCode();
    const res = await googleSignIn(sub, email, { referralCode: code, referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: boolean; referral?: string } }).data).toMatchObject({ created: false, referral: "not_applied" });
    expect(await sql`select 1 from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`).toHaveLength(0);
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

  it("ignores a code on two-step sign-up: the code is mailed, and the account is created unbound", async () => {
    start(false, "console");
    const { email, res } = await signUpInTwoSteps("NOPE-NOPE");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("referral");
    expect(await sql`select 1 from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`).toHaveLength(0);
  });

  it("ignores a code on Google sign-in for a new account", async () => {
    start(false);
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ created: true });
    expect(data).not.toHaveProperty("referral");
    expect(await sql`select 1 from referral_bindings b join users u on u.id = b.user_id where u.email = ${email}`).toHaveLength(0);
  });

  it("says nothing about a code on Google sign-in to an existing account", async () => {
    start(false);
    const sub = crypto.randomUUID();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    expect((await googleSignIn(sub, email)).status).toBe(200);
    const res = await googleSignIn(sub, email, { referralCode: "NOPE-NOPE", referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("referral");
  });
});
