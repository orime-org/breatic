// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sign-up routes with no email backend (#287): register creates the
 * account at once and hands back a recovery code, as it always has, and the
 * code routes do not exist.
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
import { initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const createdEmails: string[] = [];

beforeAll(async () => {
  initCore({ ...process.env, EMAIL_BACKEND: "disabled" });
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  for (const email of createdEmails.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

describe("sign-up without an email backend", () => {
  it("tells the page that sign-up needs no code", async () => {
    const res = await app.request("/api/v1/auth/options");
    expect(await res.json()).toEqual({ data: { emailVerification: false } });
  });

  it("creates the account at once and returns a recovery code", async () => {
    const email = `signup-disabled-${crypto.randomUUID()}@example.test`;
    createdEmails.push(email);
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { status: string; recoveryCode: string; user: { email: string } } };
    expect(body.data.status).toBe("created");
    expect(body.data.user.email).toBe(email);
    expect(body.data.recoveryCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  });

  it.each(["/register/resend", "/register/verify"])("does not serve %s", async (path) => {
    const res = await app.request(`/api/v1/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(404);
  });
});
