// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The paid account the spend-cap and queued-task suites share (inner#1968):
 * the standard account and requests through the real app.
 *
 * The standard account is a pro admin of a team studio with a project and a
 * live pro subscription, with a designated credit lot and, when a case asks,
 * a debt. Payments are on, or no spend limit applies.
 */

import crypto from "node:crypto";
import type postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, sessionCookieName, setSession } from "@breatic/core";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";

type Sql = ReturnType<typeof postgres>;

/** The environment every paid-account suite runs under: payments on. */
export const PAYMENTS_ON = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  WAVESPEED_API_KEY: "unused_by_this_suite",
};

/** The standard account and where it works. */
export interface Account {
  userId: string;
  studioId: string;
  projectId: string;
  /** A canvas Space id the requests name. */
  spaceId: string;
  cookie: string;
}

/** What a case varies about the standard account. */
export interface AccountOptions {
  /** The studio's spendable balance; 0 seeds no purchase. */
  credits?: number;
  /** What the studio owes. */
  debt?: number;
}

/**
 * The database clock, to millisecond precision.
 * @param sql - The suite's connection.
 * @returns The current statement time.
 */
export async function dbNow(sql: Sql): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  return row!.now;
}

/**
 * Sign a user in.
 * @param userId - Who.
 * @returns The session cookie.
 */
export async function signIn(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * The standard account: a signed-in pro admin of a team studio with a project.
 * @param sql - The suite's connection.
 * @param options - What is held and owed.
 * @returns The account.
 */
export async function seedAccount(sql: Sql, options: AccountOptions = {}): Promise<Account> {
  const { credits = 100, debt = 0 } = options;
  const now = await dbNow(sql);
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, 'pro', ${new Date(now.getTime() - 200 * 86_400_000)})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`pa-${studioId}`}, 'team', 'Paid')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`pa-${projectId}`}, 'Paid')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${projectId}, ${userId}, 'owner', null)`;
  await sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end)
    values (${userId}, ${`sub_${crypto.randomUUID()}`}, 'pro', 'month', 'active', ${new Date(now.getTime() + 30 * 86_400_000)}, false)`;
  const a: Account = { userId, studioId, projectId, spaceId: crypto.randomUUID(), cookie: await signIn(userId) };
  if (credits > 0) {
    const lot = await seedDesignatedLot(sql, a, Math.max(1, Math.ceil(credits)));
    await sql`update credit_lots set remaining_credits = ${credits} where id = ${lot}`;
  }
  if (debt > 0) await sql`insert into studio_credit_debts(studio_id, amount) values (${studioId}, ${debt})`;
  return a;
}

/**
 * Another signed-in member of the account's studio and project.
 * @param sql - The suite's connection.
 * @param a - Whose studio.
 * @returns The member's id and cookie.
 */
export async function seedMember(sql: Sql, a: Account): Promise<Actor> {
  const userId = crypto.randomUUID();
  await sql`insert into users(id, email, email_verified) values (${userId}, ${`${userId}@example.test`}, true)`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${a.studioId}, ${userId}, 'maintainer')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${a.projectId}, ${userId}, 'editor', ${a.userId})`;
  return { userId, cookie: await signIn(userId) };
}

/**
 * Send one JSON request through the app.
 * @param app - The server app.
 * @param cookie - Who sends.
 * @param method - The HTTP method.
 * @param path - The path under /api/v1.
 * @param body - The JSON body.
 * @param headers - Extra headers; a fresh UUID `Idempotency-Key` unless one is given (`null` sends none).
 * @returns The response.
 */
export function request(
  app: Hono,
  cookie: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const all: Record<string, string | null> = { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), ...headers };
  const sent = Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null));
  return Promise.resolve(app.request(`/api/v1${path}`, { method, headers: sent, body: JSON.stringify(body) }));
}

/** Someone signed in. */
export interface Actor {
  userId: string;
  cookie: string;
}
