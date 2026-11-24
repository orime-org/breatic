// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The sign-up routes carrying a referral code (inner#1993 §8.4), against a
 * stand-in billing service: a code it calls inactive is a field error on the
 * refusing paths and is dropped at step two of the mail sign-up; a new
 * account appends a kept code to the outbox; where nothing is sold the code
 * field is hidden and any code sent is ignored.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

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
import { env, getRedis, initCore } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { initSellingCore, useCommerceApp } from "./commerce-harness.js";

const suite = useCommerceApp("referral-signup-routes");
let app: Hono;

/** The two settings this suite adds to the environment, as they were before it. */
const outer = { EMAIL_BACKEND: process.env["EMAIL_BACKEND"], GOOGLE_CLIENT_ID: process.env["GOOGLE_CLIENT_ID"] };

/**
 * Starts core selling through the stand-in or selling nothing, with Google sign-in configured.
 * @param selling - Whether the deployment sells through the stand-in.
 * @param emailBackend - `disabled` for one-step sign-up, `console` for the two-step one with a code.
 */
function start(selling: boolean, emailBackend: "disabled" | "console" = "disabled"): void {
  process.env["EMAIL_BACKEND"] = emailBackend;
  process.env["GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com";
  if (selling) initSellingCore(suite.billingUrl);
  else initCore(process.env);
}

beforeAll(() => {
  start(true);
  app = withPeer(suite.app);
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
afterAll(() => {
  for (const [name, value] of Object.entries(outer)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The stand-in calls every code active, in upper case. */
function activeCodes(): void {
  suite.reply = (req) => ({ status: 200, body: { active: true, code: String((req.body as { code: string }).code).toUpperCase() } });
}

/** The stand-in calls every code inactive. */
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

describe("sign-up with a referral code while selling", () => {
  it("tells the sign-up page the code field exists", async () => {
    const res = await app.request("/api/v1/auth/options");
    expect(await res.json()).toEqual({ data: { emailVerification: false, referralEnabled: true } });
  });

  it("creates the account and appends the code carried in from a link", async () => {
    activeCodes();
    const { email, res } = await register({ referralCode: "friend-1", referralSource: "signup_link" });
    expect(res.status).toBe(201);
    expect(await bindingOfEmail(email)).toEqual({ code: "FRIEND-1", source: "signup_link" });
  });

  it("refuses an inactive code as a field error and creates no account", async () => {
    inactiveCodes();
    const { email, res } = await register({ referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { reason: string; field: string; message: string } };
    expect(body.error).toMatchObject({ reason: "invalid_code", field: "referralCode" });
    expect(body.error.message).not.toBe("");
    expect(await suite.sql`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it("treats a blank code as no code and asks nothing", async () => {
    const { res } = await register({ referralCode: "   ", referralSource: "signup_typed" });
    expect(res.status).toBe(201);
    expect(suite.received).toEqual([]);
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
async function signUpInTwoSteps(referralCode: string, between: () => void = () => {}): Promise<{ email: string; res: Response }> {
  const email = `ref-route-${crypto.randomUUID()}@example.test`;
  const first = await post("/register", { email, password: "correct horse battery", referralCode, referralSource: "signup_typed" });
  expect(first.status).toBe(202);
  const ticket = first.headers.getSetCookie().find((c) => c.startsWith("breatic_signup_"))!.split(";")[0]!;
  const mailed = /\b(\d{6})\b/.exec(sent.mails.at(-1)!.text)![1]!;
  between();
  return { email, res: await post("/register/verify", { code: mailed }, ticket) };
}

describe("two-step sign-up with a referral code", () => {
  it("refuses an inactive code at step one as a field error and sends no mail", async () => {
    start(true, "console");
    inactiveCodes();
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

  it("says the code was applied and appends it", async () => {
    start(true, "console");
    activeCodes();
    const { email, res } = await signUpInTwoSteps("friend-2");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { referral?: string } }).data.referral).toBe("applied");
    expect(await bindingOfEmail(email)).toEqual({ code: "FRIEND-2", source: "signup_typed" });
  });

  it("says the code was not applied, and appends nothing, when it went inactive between the steps", async () => {
    start(true, "console");
    activeCodes();
    const { email, res } = await signUpInTwoSteps("friend-3", inactiveCodes);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { referral?: string } }).data.referral).toBe("not_applied");
    expect(await bindingOfEmail(email)).toBeNull();
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
  it("refuses an inactive code for a new account as a field error and creates no account", async () => {
    inactiveCodes();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: object }).error).toMatchObject({ reason: "invalid_code", field: "referralCode" });
    expect(await suite.sql`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it("appends a code carried into a new account and says it was applied", async () => {
    activeCodes();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "friend-4", referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: boolean; referral?: string } }).data).toMatchObject({ created: true, referral: "applied" });
    expect(await bindingOfEmail(email)).toEqual({ code: "FRIEND-4", source: "signup_link" });
  });

  it("says a code carried into a new account is pending when the billing service cannot be asked, and keeps it", async () => {
    suite.reply = () => ({ status: 503, body: {} });
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "friend-6", referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: boolean; referral?: string } }).data).toMatchObject({ created: true, referral: "pending" });
    expect(await bindingOfEmail(email)).toEqual({ code: "friend-6", source: "signup_link" });
  });

  it("says a code carried into an existing account was not applied, and asks and appends nothing", async () => {
    const sub = crypto.randomUUID();
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    expect((await googleSignIn(sub, email)).status).toBe(200);
    activeCodes();
    const res = await googleSignIn(sub, email, { referralCode: "friend-5", referralSource: "signup_link" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: boolean; referral?: string } }).data).toMatchObject({ created: false, referral: "not_applied" });
    expect(await bindingOfEmail(email)).toBeNull();
    expect(suite.received).toEqual([]);
  });
});

describe("sign-up with a referral code where nothing is sold", () => {
  it("hides the code field and ignores any code sent", async () => {
    start(false);
    expect(await (await app.request("/api/v1/auth/options")).json()).toEqual({ data: { emailVerification: false, referralEnabled: false } });
    const { email, res } = await register({ referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(201);
    expect(await bindingOfEmail(email)).toBeNull();
    expect(suite.received).toEqual([]);
  });

  it("ignores a code on two-step sign-up: the code is mailed, and the account is created unbound", async () => {
    start(false, "console");
    const { email, res } = await signUpInTwoSteps("NOPE-NOPE");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("referral");
    expect(await bindingOfEmail(email)).toBeNull();
    expect(suite.received).toEqual([]);
  });

  it("ignores a code on Google sign-in for a new account", async () => {
    start(false);
    const email = `ref-google-${crypto.randomUUID()}@gmail.com`;
    const res = await googleSignIn(crypto.randomUUID(), email, { referralCode: "NOPE-NOPE", referralSource: "signup_typed" });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ created: true });
    expect(data).not.toHaveProperty("referral");
    expect(await bindingOfEmail(email)).toBeNull();
    expect(suite.received).toEqual([]);
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
