// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The terms acceptance recorded on `users` (#302).
 *
 * The sign-in and sign-up cards both carry the line "By continuing, you agree
 * to our Terms of Service and acknowledge our Privacy Policy". An account is
 * created by continuing from one of them, so every new row records when that
 * happened and which terms version was live. Signing in to an existing account
 * records nothing.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import * as authService from "@server/modules/auth/auth.service.js";
import { getLegalConfig } from "@server/config/legal.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
const createdEmails: string[] = [];

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "terms-acceptance-test-driver" },
  });
});

afterAll(async () => {
  for (const email of createdEmails) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
  await sql?.end({ timeout: 1 });
});

/**
 * A fresh address this suite owns.
 * @returns The address.
 */
function freshEmail(): string {
  const email = `terms-${crypto.randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
}

/**
 * The two terms columns of one account.
 * @param email - The account's address.
 * @returns The row, or undefined when there is none.
 */
async function terms(
  email: string,
): Promise<{ terms_accepted_at: Date | null; terms_version: string | null } | undefined> {
  const [row] = await sql<{ terms_accepted_at: Date | null; terms_version: string | null }[]>`
    SELECT terms_accepted_at, terms_version FROM users WHERE email = ${email} AND deleted_at IS NULL
  `;
  return row;
}

/**
 * Asserts a row records acceptance of the live terms at about now.
 * @param email - The account's address.
 * @param before - A moment taken just before the account was created.
 */
async function expectAccepted(email: string, before: Date): Promise<void> {
  const row = await terms(email);
  expect(row?.terms_version).toBe(getLegalConfig().terms_version);
  expect(row?.terms_accepted_at).toBeInstanceOf(Date);
  expect(row!.terms_accepted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  expect(row!.terms_accepted_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
}

describe("users terms columns", () => {
  it("exist and are nullable, so accounts made before them stay valid", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
        AND column_name IN ('terms_accepted_at', 'terms_version')
      ORDER BY column_name
    `;
    expect(rows).toEqual([
      { column_name: "terms_accepted_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "terms_version", data_type: "character varying", is_nullable: "YES" },
    ]);
  });
});

describe("an account records the terms it was created under", () => {
  it("when it signs up by email", async () => {
    const email = freshEmail();
    const before = new Date();
    await authService.register(email, "password1");
    await expectAccepted(email, before);
  });

  it("when it signs in with Google for the first time", async () => {
    const email = freshEmail();
    const before = new Date();
    await authService.loginOrCreateGoogle(`google-${crypto.randomUUID()}`, email, true);
    await expectAccepted(email, before);
  });
});

describe("signing in to an existing account", () => {
  it("records nothing when the account has no acceptance", async () => {
    const email = freshEmail();
    await authService.register(email, "password1");
    await sql`UPDATE users SET terms_accepted_at = NULL, terms_version = NULL WHERE email = ${email}`;

    await authService.loginEmail(email, "password1");

    expect(await terms(email)).toEqual({ terms_accepted_at: null, terms_version: null });
  });
});
