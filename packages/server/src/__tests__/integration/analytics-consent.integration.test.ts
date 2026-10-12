// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's latest analytics consent (`users.analytics_consent`,
 * inner#1442 design §4.4.6) — real PG + Redis.
 *
 * Events no browser is behind follow this record, so it has to settle on the
 * choice the person made last, whichever device reported it, and never on a
 * choice made under an older policy.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

// `ai` is stubbed so the app's module graph reaches no network.
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
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION, type AccountConsent } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const created: string[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Inserts an account with no consent on record.
 * @returns The account's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`consent-${crypto.randomUUID()}@example.test`}, true, 'base')
    RETURNING id
  `;
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

/**
 * Builds a report as a browser sends it.
 * @param analytics - Analytics category.
 * @param ads - Ads category.
 * @param decidedAt - When the choice was made.
 * @returns The report.
 */
function choice(analytics: boolean, ads: boolean, decidedAt: string): AccountConsent {
  return { analytics, ads, decidedAt, source: "banner", revision: CONSENT_REVISION };
}

/**
 * A time this many hours before now, as an ISO timestamp.
 * @param hours - How long ago.
 * @returns The timestamp.
 */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/**
 * Sends `PUT /users/me/analytics-consent` as the given account.
 * @param userId - The account.
 * @param body - The report.
 * @returns The response.
 */
async function putConsent(userId: string, body: unknown): Promise<Response> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return app.request("/api/v1/users/me/analytics-consent", {
    method: "PUT",
    headers: { Cookie: `${sessionCookieName()}=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Reads the account's choice through the service events use.
 * @param userId - The account.
 * @returns The choice, or null.
 */
async function accountConsent(userId: string): Promise<AccountConsent | null> {
  const { authService } = await import("@server/modules");
  return authService.getAnalyticsConsent(userId);
}

describe("users.analytics_consent", () => {
  it("starts empty and keeps the first report", async () => {
    const id = await insertUser();
    expect(await accountConsent(id)).toBeNull();
    const res = await putConsent(id, choice(true, false, hoursAgo(6)));
    expect(res.status).toBe(204);
    expect(await accountConsent(id)).toMatchObject({ analytics: true, ads: false });
  });

  it("ignores a report decided before the stored one", async () => {
    const id = await insertUser();
    await putConsent(id, choice(false, false, hoursAgo(5)));
    const res = await putConsent(id, choice(true, true, hoursAgo(6)));
    expect(res.status).toBe(204);
    expect(await accountConsent(id)).toMatchObject({ analytics: false, ads: false });
  });

  it("keeps a category on only if both of two simultaneous reports accepted it", async () => {
    const id = await insertUser();
    const at = hoursAgo(4);
    await Promise.all([putConsent(id, choice(true, false, at)), putConsent(id, choice(true, true, at))]);
    expect(await accountConsent(id)).toMatchObject({ analytics: true, ads: false });
  });

  it("takes a report dated in the future as made now", async () => {
    const id = await insertUser();
    await putConsent(id, choice(true, true, "2099-01-01T00:00:00.000Z"));
    await putConsent(id, choice(false, false, new Date(Date.now() + 1000).toISOString()));
    expect(await accountConsent(id)).toMatchObject({ analytics: false, ads: false });
  });

  it("ignores a report from an older policy revision", async () => {
    const id = await insertUser();
    const res = await putConsent(id, { ...choice(true, true, hoursAgo(3)), revision: CONSENT_REVISION - 1 });
    expect(res.status).toBe(204);
    expect(await accountConsent(id)).toBeNull();
  });

  it("keeps an explicit choice when a regional default the person never chose arrives later", async () => {
    const id = await insertUser();
    await putConsent(id, choice(false, false, hoursAgo(2)));
    const res = await putConsent(id, { ...choice(true, true, hoursAgo(1)), source: "implicit" });
    expect(res.status).toBe(204);
    expect(await accountConsent(id)).toMatchObject({ analytics: false, ads: false, source: "banner" });
  });

  it("reads no consent for a choice older than the consent cookie lasts", async () => {
    const id = await insertUser();
    const old = choice(true, true, new Date(Date.now() - (CONSENT_MAX_AGE_DAYS + 1) * 86_400_000).toISOString());
    await sql`UPDATE users SET analytics_consent = ${sql.json({ ...old })} WHERE id = ${id}`;
    expect(await accountConsent(id)).toBeNull();
  });

  it("reads no consent for a stored choice from an older policy revision", async () => {
    const id = await insertUser();
    const stale = { ...choice(true, true, hoursAgo(3)), revision: CONSENT_REVISION - 1 };
    await sql`UPDATE users SET analytics_consent = ${sql.json(stale)} WHERE id = ${id}`;
    expect(await accountConsent(id)).toBeNull();
  });

  it("rejects a malformed report and leaves the record alone", async () => {
    const id = await insertUser();
    await putConsent(id, choice(true, false, hoursAgo(2)));
    const good = choice(false, false, hoursAgo(1));
    for (const bad of [
      { ...good, decidedAt: "yesterday" },
      { ...good, source: "cookie-wall" },
      { ...good, analytics: "yes" },
      { ...good, revision: 1.5 },
      {},
    ]) {
      const res = await putConsent(id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await accountConsent(id)).toMatchObject({ analytics: true, ads: false });
  });

  it("refuses a report without a session", async () => {
    const res = await app.request("/api/v1/users/me/analytics-consent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(choice(true, true, hoursAgo(1))),
    });
    expect(res.status).toBe(401);
  });
});
