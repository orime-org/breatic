// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Consent receipts and the GPC signal on the account (inner#1442 design
 * §4.4.6) — real PG + Redis.
 *
 * A browser's choice is recorded once, on the first account that reports it;
 * a signed-in request carrying GPC opts the whole account out of ads; and the
 * account's ads record comes back with whose receipt the browser's cookie is.
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
  eraseAccountAnalytics,
  getAccountAdsEvents,
  getRedis,
  initCore,
  loadLocales,
  pruneConsentReceipts,
  recordConsentReceipts,
  recordOptOutRequest,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_REVISION,
  ConsentReportSchema,
  type ConsentReport,
} from "@breatic/shared";
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
    await sql`DELETE FROM analytics_consent_events WHERE user_id = ${id}`;
    await sql`UPDATE users SET deleted_at = coalesce(deleted_at, now()) WHERE id = ${id}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/**
 * Inserts an account with nothing on record.
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
 * One decision as a browser reports it.
 * @param over - Fields to change.
 * @returns The decision.
 */
type Decision = Record<string, unknown> & { value: boolean };

function decision(over: Record<string, unknown> = {}): Decision {
  return {
    decisionId: crypto.randomUUID(),
    category: "ads",
    value: true,
    source: "banner",
    noticeShown: false,
    gpcAtDecision: false,
    decidedAt: ago(HOUR),
    ...over,
  };
}

/**
 * A report as the server validated it.
 * @param decisions - The decisions.
 * @returns The parsed report.
 */
function parsed(decisions: Decision[]): ConsentReport {
  return ConsentReportSchema.parse(report(decisions));
}

/**
 * A report body.
 * @param decisions - The decisions.
 * @param extra - Other fields to set.
 * @returns The body.
 */
function report(decisions: Decision[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { decisions, revision: CONSENT_REVISION, ...extra };
}

/**
 * The consent cookie a browser holding this ads choice sends.
 * @param ads - The ads entry, with its value.
 * @returns The cookie pair.
 */
function consentCookie(ads: Decision): string {
  const { value, category: _category, ...entry } = ads;
  const body = { categories: ["necessary", ...(value ? ["ads"] : [])], revision: CONSENT_REVISION, data: { ads: entry } };
  return `${CONSENT_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(body))}`;
}

/**
 * Sends a request to `/users/me/analytics-consent` as the given account.
 * @param userId - The account.
 * @param init - Method, body, the browser's ads choice for its cookie, and whether it sends GPC.
 * @param init.method - `GET` or `PUT`.
 * @param init.body - The report, for `PUT`.
 * @param init.cookieAds - The ads choice the browser's cookie holds.
 * @param init.gpc - Whether the request carries `Sec-GPC: 1`.
 * @returns The response.
 */
async function call(
  userId: string,
  init: { method?: string; body?: unknown; cookieAds?: Decision; gpc?: boolean } = {},
): Promise<Response> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  const cookies = [`${sessionCookieName()}=${token}`];
  if (init.cookieAds) cookies.push(consentCookie(init.cookieAds));
  return app.request("/api/v1/users/me/analytics-consent", {
    method: init.method ?? "GET",
    headers: {
      Cookie: cookies.join("; "),
      "Content-Type": "application/json",
      ...(init.gpc ? { "Sec-GPC": "1" } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/**
 * The account's receipts as stored.
 * @param userId - The account.
 * @returns The rows, oldest first.
 */
async function receipts(userId: string): Promise<Record<string, unknown>[]> {
  return sql`SELECT decision_id, category, value, source, notice_shown, gpc_at_decision, decided_at, revision
    FROM analytics_consent_events WHERE user_id = ${userId} ORDER BY decided_at, category`;
}

/**
 * When the account last sent GPC, as stored.
 * @param userId - The account.
 * @returns The time, or null.
 */
async function gpcSeenAt(userId: string): Promise<Date | null> {
  const rows = await sql<{ at: Date | null }[]>`SELECT analytics_gpc_seen_at AS at FROM users WHERE id = ${userId}`;
  return rows[0]!.at;
}

describe("PUT /users/me/analytics-consent", () => {
  it("records one receipt per decision and returns the account's ads record", async () => {
    const id = await insertUser();
    const ads = decision();
    const res = await call(id, {
      method: "PUT",
      body: report([ads, decision({ category: "analytics", value: false })]),
      cookieAds: ads,
    });
    expect(res.status).toBe(200);
    const rows = await receipts(id);
    expect(rows.map((r) => [r.category, r.value])).toEqual(
      expect.arrayContaining([
        ["ads", true],
        ["analytics", false],
      ]),
    );
    const { data } = (await res.json()) as { data: { receipts: { decisionId: string }[]; ownership: string } };
    expect(data.receipts.map((r) => r.decisionId)).toEqual([ads.decisionId]);
    expect(data.ownership).toBe("self");
  });

  it("records a decision once, however often and with whatever value it is sent again", async () => {
    const id = await insertUser();
    const ads = decision();
    await call(id, { method: "PUT", body: report([ads]) });
    await call(id, { method: "PUT", body: report([{ ...ads, value: false }]) });
    const rows = await receipts(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(true);
  });

  it("does not take over a decision another account already recorded", async () => {
    const first = await insertUser();
    const second = await insertUser();
    const ads = decision({ value: false });
    await call(first, { method: "PUT", body: report([ads]) });
    const res = await call(second, { method: "PUT", body: report([ads]), cookieAds: ads });
    expect(await receipts(second)).toHaveLength(0);
    const { data } = (await res.json()) as { data: { ownership: string } };
    expect(data.ownership).toBe("other");
  });

  it("corrects a fast browser clock by the time the report was sent, and never dates a receipt ahead", async () => {
    const id = await insertUser();
    const now = Date.now();
    const skewed = decision({ decidedAt: new Date(now + 40 * 60_000).toISOString() });
    await call(id, { method: "PUT", body: report([skewed], { sentAt: new Date(now + HOUR).toISOString() }) });
    const ahead = decision({ category: "analytics", decidedAt: new Date(now + DAY).toISOString() });
    await call(id, { method: "PUT", body: report([ahead]) });
    const rows = await receipts(id);
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, (r.decided_at as Date).getTime()]));
    expect(Math.abs(byCategory.ads! - (now - 20 * 60_000))).toBeLessThan(5_000);
    expect(byCategory.analytics).toBeLessThanOrEqual(Date.now());
  });

  it("keeps an account-notice override and stores a GPC-notice override as a plain consent", async () => {
    const id = await insertUser();
    await call(id, {
      method: "PUT",
      body: report([decision({ source: "settings", noticeShown: "account" })]),
    });
    await call(id, {
      method: "PUT",
      body: report([decision({ source: "settings", noticeShown: "gpc", gpcAtDecision: true })]),
    });
    const rows = await receipts(id);
    expect(rows.map((r) => r.notice_shown).sort()).toEqual(["account", null]);
    expect(rows.find((r) => r.notice_shown === null)!.gpc_at_decision).toBe(true);
  });

  it("rejects a malformed report and records nothing", async () => {
    const id = await insertUser();
    const shared = crypto.randomUUID();
    for (const bad of [
      report([decision({ decisionId: undefined })]),
      report([decision({ decisionId: "not-a-uuid" })]),
      report([decision({ source: "implicit" })]),
      report([decision({ source: "request", value: false })]),
      report([decision({ source: "gpc", value: true })]),
      report([decision({ source: "gpc", value: false, category: "analytics" })]),
      report([decision({ noticeShown: "account" })]),
      report([decision({ category: "analytics", source: "settings", noticeShown: "gpc" })]),
      report([decision({ decisionId: shared }), decision({ decisionId: shared, category: "analytics" })]),
      report([]),
      {},
    ]) {
      const res = await call(id, { method: "PUT", body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await receipts(id)).toHaveLength(0);
  });

  it("rejects a revision outside the column's range and records nothing", async () => {
    const id = await insertUser();
    for (const revision of [0, 2_147_483_648]) {
      const res = await call(id, { method: "PUT", body: report([decision()], { revision }) });
      expect(res.status, String(revision)).toBe(422);
    }
    expect(await receipts(id)).toHaveLength(0);
  });

  it("records a report whose corrected time falls before the epoch, whole, at the epoch", async () => {
    const id = await insertUser();
    const body = report(
      [decision({ decidedAt: "0001-01-01T00:00:00.000Z" }), decision({ category: "analytics", decidedAt: "0001-01-01T00:00:00.000Z" })],
      { sentAt: "9999-12-31T00:00:00.000Z" },
    );
    const res = await call(id, { method: "PUT", body });
    expect(res.status).toBe(200);
    const rows = await receipts(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.decided_at as Date).getTime() === 0)).toBe(true);
  });

  it("refuses a report without a session", async () => {
    const res = await app.request("/api/v1/users/me/analytics-consent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report([decision()])),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /users/me/analytics-consent", () => {
  it("returns the ads receipts in force, the GPC signal and whose receipt the cookie is", async () => {
    const id = await insertUser();
    const old = decision({ decidedAt: ago((CONSENT_MAX_AGE_DAYS + 1) * DAY) });
    const oldRefusal = decision({ value: false, decidedAt: ago(1000 * DAY) });
    const recent = decision({ decidedAt: ago(DAY) });
    await recordConsentReceipts(id, parsed([old]), Date.now());
    await recordConsentReceipts(id, parsed([oldRefusal]), Date.now());
    await recordConsentReceipts(id, parsed([recent]), Date.now());
    const before = Date.now();
    const res = await call(id, { cookieAds: decision() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { receipts: { decisionId: string }[]; gpcSeenAt: string | null; ownership: string; serverTime: string };
    };
    expect(data.receipts.map((r) => r.decisionId).sort()).toEqual([oldRefusal.decisionId, recent.decisionId].sort());
    expect(data.gpcSeenAt).toBeNull();
    expect(data.ownership).toBe("none");
    // The browser times its own choice on this clock, the one the receipts are dated by.
    expect(Date.parse(data.serverTime)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(data.serverTime)).toBeLessThanOrEqual(Date.now());
  });
});

describe("the GPC signal", () => {
  it("records when a signed-in request carries GPC, and not again within the hour", async () => {
    const id = await insertUser();
    await call(id, { gpc: true });
    const first = await gpcSeenAt(id);
    expect(first).not.toBeNull();
    await call(id, { gpc: true });
    expect(await gpcSeenAt(id)).toEqual(first);
  });

  it("records again when an ads consent was given after it", async () => {
    const id = await insertUser();
    await sql`UPDATE users SET analytics_gpc_seen_at = now() - interval '10 minutes' WHERE id = ${id}`;
    await recordConsentReceipts(
      id,
      parsed([decision({ decidedAt: ago(60_000) })]),
      Date.now(),
    );
    const before = await gpcSeenAt(id);
    await call(id, { gpc: true });
    expect((await gpcSeenAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it("leaves out this browser's GPC for an override saved while it sent GPC", async () => {
    const id = await insertUser();
    const override = decision({ source: "settings", noticeShown: "gpc", gpcAtDecision: true });
    await call(id, { gpc: true, cookieAds: override });
    expect(await gpcSeenAt(id)).toBeNull();
    await call(id, { method: "PUT", body: report([override]), gpc: true, cookieAds: override });
    expect(await gpcSeenAt(id)).toBeNull();
  });

  it("counts GPC for an override another account left in the cookie", async () => {
    const owner = await insertUser();
    const id = await insertUser();
    const override = decision({ source: "settings", noticeShown: "gpc", gpcAtDecision: true });
    await call(owner, { method: "PUT", body: report([override]) });
    await call(id, { gpc: true, cookieAds: override });
    expect(await gpcSeenAt(id)).not.toBeNull();
  });
});

describe("the account's consent for events no browser is behind", () => {
  it("takes analytics from the receipts and ads from the account's events alone", async () => {
    const id = await insertUser();
    await recordConsentReceipts(
      id,
      parsed([decision({ category: "analytics", value: true }), decision({ value: true })]),
      Date.now(),
    );
    expect(await accountOnlyConsent(id, Date.now())).toEqual({ analytics: true, ads: true });
    await call(id, { gpc: true });
    expect(await accountOnlyConsent(id, Date.now())).toEqual({ analytics: true, ads: false });
  });

  it("is nothing for a deleted account, and a deleted account records nothing", async () => {
    const id = await insertUser();
    await recordConsentReceipts(id, parsed([decision()]), Date.now());
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    await recordConsentReceipts(id, parsed([decision()]), Date.now());
    expect(await receipts(id)).toHaveLength(1);
    expect(await getAccountAdsEvents(id, Date.now())).toBeNull();
    expect(await accountOnlyConsent(id, Date.now())).toEqual({ analytics: false, ads: false });
  });
});

/**
 * Insert a receipt as it would stand after the given age.
 * @param userId - The account.
 * @param row - The receipt's category, value, age and revision.
 * @param row.category - `analytics` or `ads`.
 * @param row.value - Consent or refusal.
 * @param row.ageDays - How old it is.
 * @param row.revision - Its policy revision.
 * @returns Its decision id.
 */
async function insertReceipt(
  userId: string,
  row: { category: "analytics" | "ads"; value: boolean; ageDays: number; revision?: number },
): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO analytics_consent_events (decision_id, user_id, category, value, source, decided_at, revision)
    VALUES (${id}, ${userId}, ${row.category}, ${row.value}, 'banner', ${new Date(Date.now() - row.ageDays * DAY).toISOString()},
            ${row.revision ?? CONSENT_REVISION})
  `;
  return id;
}

describe("pruneConsentReceipts", () => {
  it("deletes analytics receipts and ads consents past 395 days or from an older revision, and keeps ads refusals", async () => {
    const id = await insertUser();
    const old = CONSENT_MAX_AGE_DAYS + 1;
    const gone = [
      await insertReceipt(id, { category: "analytics", value: true, ageDays: old }),
      await insertReceipt(id, { category: "analytics", value: false, ageDays: old }),
      await insertReceipt(id, { category: "analytics", value: true, ageDays: 1, revision: CONSENT_REVISION - 1 }),
      await insertReceipt(id, { category: "ads", value: true, ageDays: old }),
      await insertReceipt(id, { category: "ads", value: true, ageDays: 1, revision: CONSENT_REVISION - 1 }),
    ];
    const kept = [
      await insertReceipt(id, { category: "analytics", value: false, ageDays: 1 }),
      await insertReceipt(id, { category: "ads", value: true, ageDays: 1 }),
      await insertReceipt(id, { category: "ads", value: false, ageDays: 1000, revision: CONSENT_REVISION - 1 }),
    ];
    await pruneConsentReceipts(Date.now());
    const left = (await receipts(id)).map((r) => r.decision_id as string);
    expect(left.sort()).toEqual([...kept].sort());
    expect(left.some((d) => gone.includes(d))).toBe(false);
  });
});

describe("recordOptOutRequest", () => {
  it("records an ads refusal on the person's behalf that keeps ads off", async () => {
    const id = await insertUser();
    await recordConsentReceipts(id, parsed([decision()]), Date.now());
    expect(await accountOnlyConsent(id, Date.now())).toMatchObject({ ads: true });
    expect(await recordOptOutRequest(id, crypto.randomUUID(), CONSENT_REVISION)).toBe(true);
    expect((await receipts(id)).at(-1)).toMatchObject({ category: "ads", value: false, source: "request" });
    expect(await accountOnlyConsent(id, Date.now())).toMatchObject({ ads: false });
  });

  it("records nothing for a missing or deleted account", async () => {
    expect(await recordOptOutRequest(crypto.randomUUID(), crypto.randomUUID(), CONSENT_REVISION)).toBe(false);
    const id = await insertUser();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await recordOptOutRequest(id, crypto.randomUUID(), CONSENT_REVISION)).toBe(false);
  });
});

describe("eraseAccountAnalytics", () => {
  /**
   * An account with a receipt, a GPC signal and consent kept on an order, an upload ticket and an ad upload.
   * @returns Its id.
   */
  async function accountWithConsent(): Promise<string> {
    const id = await insertUser();
    await insertReceipt(id, { category: "ads", value: false, ageDays: 1 });
    await sql`UPDATE users SET analytics_gpc_seen_at = now() WHERE id = ${id}`;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted, metadata)
      VALUES (${source!.id}, ${id}, 1000, 'completed', 1000,
              ${sql.json({ locale: "en", analyticsConsent: { analytics: true, ads: true }, adsBrowser: { choice: null } })})
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
    const job = { kind: "conversion", userId: id, browser: { choice: null, gpcAt: null, at: new Date().toISOString() } };
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
    expect(await receipts(deleted)).toHaveLength(1);
  });

  it("removes the receipts, the GPC signal and every consent snapshot of deleted accounts", async () => {
    const id = await accountWithConsent();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await eraseAccountAnalytics([id])).toEqual({ notDeleted: [] });
    expect(await receipts(id)).toHaveLength(0);
    expect(await gpcSeenAt(id)).toBeNull();
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
