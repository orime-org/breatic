// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's latest reported consent (inner#1442 design §4.4.6) — real
 * PG + Redis.
 *
 * A signed-in browser reports its consent in force through
 * `PUT /users/me/consent`; the latest report replaces the previous one, and
 * events no browser is behind are decided from it.
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
import {
  accountOnlyConsent,
  adsAllowedFor,
  eraseAccountAnalytics,
  getRedis,
  initCore,
  loadLocales,
  recordReportedConsent,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import { CONSENT_REVISION } from "@breatic/shared";
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
    await sql`UPDATE users SET deleted_at = coalesce(deleted_at, now()) WHERE id = ${id}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Inserts an account with nothing on record.
 * @returns The account's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`consent-report-${crypto.randomUUID()}@example.test`}, true, 'base')
    RETURNING id
  `;
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

/**
 * Sends a signed-in report.
 * @param userId - The account.
 * @param body - The request body.
 * @returns The response.
 */
async function report(userId: string, body: unknown): Promise<Response> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return app.request("/api/v1/users/me/consent", {
    method: "PUT",
    headers: { Cookie: `${sessionCookieName()}=${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * The account's latest report as stored.
 * @param userId - The account.
 * @returns It, or null.
 */
async function stored(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ seen: Record<string, unknown> | null }[]>`SELECT consent_seen AS seen FROM users WHERE id = ${userId}`;
  return rows[0]!.seen;
}

/**
 * A report as it is stored.
 * @param analytics - The analytics consent.
 * @param ads - The ads consent.
 * @returns The stored shape, any report time.
 */
function record(analytics: boolean, ads: boolean): Record<string, unknown> {
  return {
    analytics: { value: analytics, revision: CONSENT_REVISION },
    ads: { value: ads, revision: CONSENT_REVISION },
    reportedAt: expect.any(String),
  };
}

describe("PUT /users/me/consent", () => {
  it("keeps the report whole and answers 204", async () => {
    const id = await insertUser();
    const res = await report(id, { analytics: true, ads: false });
    expect(res.status).toBe(204);
    expect(await stored(id)).toEqual(record(true, false));
  });

  it("replaces an earlier report from another browser with the later one", async () => {
    const id = await insertUser();
    await report(id, { analytics: true, ads: true });
    await report(id, { analytics: false, ads: false });
    expect(await stored(id)).toEqual(record(false, false));
  });

  it("refuses a request without a session", async () => {
    const res = await app.request("/api/v1/users/me/consent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analytics: true, ads: true }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body and changes nothing", async () => {
    const id = await insertUser();
    for (const bad of [{}, { analytics: true }, { analytics: "yes", ads: true }, { analytics: true, ads: true, gpc: true }]) {
      const res = await report(id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await report(id, "{oops")).status).toBe(400);
    expect(await stored(id)).toBeNull();
  });
});

describe("recordReportedConsent", () => {
  it("writes nothing for a missing or deleted account", async () => {
    expect(await recordReportedConsent(crypto.randomUUID(), { analytics: true, ads: true })).toBe(false);
    const id = await insertUser();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await recordReportedConsent(id, { analytics: true, ads: true })).toBe(false);
    expect(await stored(id)).toBeNull();
  });
});

describe("events no browser is behind", () => {
  it("follow the latest report, and are not measured for an account that never reported", async () => {
    const id = await insertUser();
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
    expect(await adsAllowedFor(id, null)).toBe(false);
    await report(id, { analytics: true, ads: true });
    expect(await accountOnlyConsent(id)).toEqual({ analytics: true, ads: true });
    expect(await adsAllowedFor(id, null)).toBe(true);
    await report(id, { analytics: true, ads: false });
    expect(await accountOnlyConsent(id)).toEqual({ analytics: true, ads: false });
    expect(await adsAllowedFor(id, null)).toBe(false);
  });

  it("count a report under a revision no longer in force as none", async () => {
    const id = await insertUser();
    const old = CONSENT_REVISION - 1;
    await sql`UPDATE users SET consent_seen = ${sql.json({
      analytics: { value: true, revision: old },
      ads: { value: true, revision: old },
      reportedAt: new Date().toISOString(),
    })} WHERE id = ${id}`;
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
  });

  it("are never measured for a deleted or missing account", async () => {
    const id = await insertUser();
    await report(id, { analytics: true, ads: true });
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
    expect(await adsAllowedFor(id, null)).toBe(false);
    expect(await adsAllowedFor(crypto.randomUUID(), null)).toBe(false);
  });
});

describe("adsAllowedFor with a browser", () => {
  it("follows the browser behind the event, whatever the account last reported", async () => {
    const id = await insertUser();
    await report(id, { analytics: false, ads: false });
    expect(await adsAllowedFor(id, { consent: true })).toBe(true);
    await report(id, { analytics: true, ads: true });
    expect(await adsAllowedFor(id, { consent: false })).toBe(false);
  });
});

describe("eraseAccountAnalytics", () => {
  /**
   * An account with a report, and consent kept on an order, an upload
   * ticket and an ad upload.
   * @returns Its id.
   */
  async function accountWithConsent(): Promise<string> {
    const id = await insertUser();
    await recordReportedConsent(id, { analytics: true, ads: true });
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted, metadata)
      VALUES (${source!.id}, ${id}, 1000, 'completed', 1000,
              ${sql.json({ locale: "en", analyticsConsent: { analytics: true, ads: true }, adsBrowser: { consent: true } })})
    `;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${id}, ${`erase-${crypto.randomUUID().slice(0, 8)}`}, 'team', 'Team') RETURNING id
    `;
    await sql`
      INSERT INTO upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, analytics_consent)
      VALUES (${id}, ${studio!.id}, ${`k/${crypto.randomUUID()}`}, 1, now() + interval '1 hour',
              ${sql.json({ analytics: true, ads: true })})
    `;
    const job = { userId: id, browser: { consent: true } };
    await sql`
      INSERT INTO ads_conversion_uploads (conversion, transaction_id, payment_id, status, job)
      VALUES ('signup', ${`signup:${id}`}, null, 'uploaded', ${sql.json(job)})
    `;
    return id;
  }

  it("refuses accounts that are not deleted, and changes nothing", async () => {
    const live = await accountWithConsent();
    const deleted = await accountWithConsent();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}`;
    expect(await eraseAccountAnalytics([live, deleted])).toEqual({ notDeleted: [live] });
    expect(await stored(deleted)).toEqual(record(true, true));
  });

  it("clears the latest report and every consent snapshot of deleted accounts", async () => {
    const id = await accountWithConsent();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await eraseAccountAnalytics([id])).toEqual({ notDeleted: [] });
    expect(await stored(id)).toBeNull();
    const [payment] = await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM payments WHERE user_id = ${id}`;
    expect(payment!.metadata).toEqual({ locale: "en" });
    const [grant] = await sql<{ c: unknown }[]>`SELECT analytics_consent AS c FROM upload_grants WHERE user_id = ${id}`;
    expect(grant!.c).toBeNull();
    const [upload] = await sql<{ job: Record<string, unknown> }[]>`
      SELECT job FROM ads_conversion_uploads WHERE transaction_id = ${`signup:${id}`}
    `;
    expect(upload!.job.browser).toBeNull();
  });
});
