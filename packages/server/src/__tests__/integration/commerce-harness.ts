// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A stand-in billing service and the product app pointed at it (inner#1993
 * §3.2), for the suites that drive forwarded user requests. Not a test file.
 *
 * The stand-in checks the `product` signature with core's own middleware, so
 * a request it records is one the real billing service would accept; it
 * answers whatever the case scripts.
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { createInternalAuth, env, getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { serveOnLoopback, type RunningApp } from "./internal-api-harness.js";

/** The product's secret on the billing service's listener. */
const PRODUCT_SECRET = "commerce-secret-current-0123456789abcdef";

/** One request the stand-in received. */
export interface BillingRequest {
  method: string;
  /** Path with query. */
  path: string;
  signer: string;
  idempotencyKey: string | null;
  body: unknown;
}

/** How the stand-in answers; a case may hold an answer back to line up concurrent requests. */
export type BillingReply = (req: BillingRequest) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** What a suite reads inside its tests. */
export interface CommerceSuite {
  sql: ReturnType<typeof postgres>;
  /** The product's public app. */
  app: Hono;
  /** What the stand-in received, oldest first; emptied before each case. */
  received: BillingRequest[];
  /** Set by a case; answers 200 `{ data: { ok: true } }` until then. */
  reply: BillingReply;
  /** The stand-in's base URL. */
  billingUrl: string;
}

/**
 * Core configured to sell through the stand-in.
 * @param billingUrl - Where the stand-in listens.
 */
export function initSellingCore(billingUrl: string): void {
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef",
    COMMERCE_API_URL: billingUrl,
    COMMERCE_API_SECRET: PRODUCT_SECRET,
  });
}

/**
 * Register a suite's setup: the stand-in, core pointed at it, locales, a raw
 * SQL client and the public app.
 * @param appName - `application_name` for the suite's connections.
 * @returns A holder filled before the first case runs.
 */
export function useCommerceApp(appName: string): CommerceSuite {
  const suite = { received: [] as BillingRequest[], reply: defaultReply } as Partial<CommerceSuite> as CommerceSuite;
  let running: RunningApp | undefined;
  beforeAll(async () => {
    const billing = new Hono();
    billing.use(
      "*",
      createInternalAuth({
        secretsFor: (signer) => (signer === "product" ? { current: PRODUCT_SECRET, previous: "" } : null),
        mayAccess: () => true,
        redis: getRedis,
        keyPrefix: () => `${env.ENV}:commerce-harness`,
        report: () => undefined,
      })(),
    );
    billing.all("*", async (c) => {
      const text = await c.req.text();
      const url = new URL(c.req.url);
      const req: BillingRequest = {
        method: c.req.method,
        path: `${url.pathname}${url.search}`,
        signer: c.req.header("x-internal-admin") ?? "",
        idempotencyKey: c.req.header("idempotency-key") ?? null,
        body: text === "" ? null : (JSON.parse(text) as unknown),
      };
      suite.received.push(req);
      const { status, body } = await suite.reply(req);
      return c.json(body as object, status as 200);
    });
    running = await serveOnLoopback(billing);
    suite.billingUrl = running.baseUrl;
    initSellingCore(running.baseUrl);
    loadLocales();
    suite.sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: appName } });
    const { createApp } = await import("@server/app.js");
    suite.app = createApp();
  });
  beforeEach(async () => {
    suite.received.length = 0;
    suite.reply = defaultReply;
    // Rows other files left would be taken by the relay before this test's own.
    await suite.sql`DELETE FROM commerce_outbox`;
  });
  afterAll(async () => {
    await running?.close();
    await suite.sql?.end({ timeout: 1 });
    initCore(process.env);
  });
  return suite;
}

/**
 * The stand-in's answer until a case sets its own.
 * @returns 200 with an `ok` body.
 */
function defaultReply(): { status: number; body: unknown } {
  return { status: 200, body: { data: { ok: true } } };
}

/**
 * One verified account with its personal Studio.
 * @param sql - Raw client.
 * @returns Its id.
 */
export async function insertAccount(sql: ReturnType<typeof postgres>): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`commerce-${crypto.randomUUID()}@example.test`}, true) RETURNING id`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`c-${crypto.randomUUID().slice(0, 12)}`}, 'personal', 'Mine') RETURNING id`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  return user!.id;
}

/**
 * A real session for an account.
 * @param userId - The account.
 * @returns The `Cookie` header value.
 */
export async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}
