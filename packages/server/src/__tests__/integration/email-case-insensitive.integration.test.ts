// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One mailbox is one account (#288): every way an address comes in —
 * sign-up, login, both recovery paths, Google — is read without regard to
 * case or surrounding space, and the table refuses an address that was not
 * normalized.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const createdIds: string[] = [];

beforeAll(async () => {
  initCore({ ...process.env, EMAIL_BACKEND: "disabled" });
  sql = postgres(inject("DATABASE_URL"), { max: 3, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  const throttled = await getRedis().keys(`${env.ENV}:ratelimit:*`);
  if (throttled.length > 0) await getRedis().del(...throttled);
  for (const id of createdIds.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
  }
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/** A fresh lower-case address and the same address as a reader might type it. */
function addressPair(): { stored: string; typed: string } {
  const stored = `case-${crypto.randomUUID()}@example.test`;
  return { stored, typed: `  ${stored.toUpperCase()} ` };
}

/** POST a JSON body to an auth route. */
async function post(path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Register through the route and return the created account. */
async function register(email: string): Promise<{ id: string; email: string; recoveryCode: string }> {
  const res = await post("/register", { email, password: "password1" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    data: { user: { id: string; email: string }; recoveryCode: string };
  };
  createdIds.push(body.data.user.id);
  return { ...body.data.user, recoveryCode: body.data.recoveryCode };
}

describe("an address is one account whatever its case", () => {
  it("stores the address normalized when it is typed in mixed case", async () => {
    const { stored, typed } = addressPair();
    const user = await register(typed);
    expect(user.email).toBe(stored);
    const [row] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${user.id}`;
    expect(row!.email).toBe(stored);
  });

  it("refuses a second sign-up for the same mailbox in another case", async () => {
    const { stored, typed } = addressPair();
    await register(stored);
    const res = await post("/register", { email: typed, password: "password1" });
    expect(res.status).toBe(409);
  });

  it("logs in with the address typed in another case", async () => {
    const { stored, typed } = addressPair();
    await register(stored);
    const res = await post("/login", { email: typed, password: "password1" });
    expect(res.status).toBe(200);
  });

  it("resets with the recovery code when the address is typed in another case", async () => {
    const { stored, typed } = addressPair();
    const user = await register(stored);
    const res = await post("/reset-password-with-recovery-code", {
      email: typed,
      recoveryCode: user.recoveryCode,
      newPassword: "password2",
    });
    expect(res.status).toBe(200);
  });

  it("finds the account for an emailed reset requested in another case", async () => {
    const { stored, typed } = addressPair();
    const user = await register(stored);
    const { forgotPassword } = await import("@server/modules/auth/auth.service.js");
    const result = await forgotPassword(typed, "http://localhost/reset");
    expect(result).toMatchObject({ status: "reset_email_sent", userId: user.id });
  });

  it("signs in the existing account when Google reports the address in another case", async () => {
    const { stored } = addressPair();
    const user = await register(stored);
    const { loginOrCreateGoogle } = await import("@server/modules/auth/auth.service.js");
    const result = await loginOrCreateGoogle(crypto.randomUUID(), stored.toUpperCase(), true);
    createdIds.push(result.user.id);
    expect(result.user.id).toBe(user.id);
    expect(result.user.emailVerified).toBe(true);
  });
});

describe("two sign-ups for one mailbox at the same time", () => {
  it("creates one account and tells the other it is already registered", async () => {
    const { stored } = addressPair();
    const { register } = await import("@server/modules/auth/auth.service.js");
    const { ConflictError } = await import("@breatic/core");

    // Hold inserts into users (reads still pass) so both sign-ups get past
    // the "is it taken" lookup before either one writes.
    const gate = await sql.reserve();
    await gate`BEGIN`;
    await gate`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
    const racing = Promise.allSettled([
      register(stored, "password1"),
      register(stored.toUpperCase(), "password1"),
    ]);
    for (let waiting = 0; waiting < 2; ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "users"%'`;
      waiting = row!.n;
    }
    await gate`COMMIT`;
    gate.release();

    const results = await racing;
    for (const r of results) if (r.status === "fulfilled") createdIds.push(r.value.user.id);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictError);
  });
});

describe("the users table", () => {
  it("refuses an address that is not normalized", async () => {
    const email = `Case-${crypto.randomUUID()}@Example.test`;
    await expect(
      sql`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "users_email_normalized" });
  });
});
