// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the operation counting suites share (inner#1968, test spec area B):
 * the standard account, requests through the real app, the ingest Worker's
 * report on stored bytes, and reading the operation ledger back.
 *
 * The standard account is a pro admin of a team studio with a project, whose
 * live subscription anchors the current period a minute ago, so every count
 * this period carries that `period_start`. Payments are on, or nothing is
 * metered. Nothing sleeps: expiry is reached by writing `expires_at`.
 */

import crypto from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, getStorageAdapter, initLogger, sessionCookieName, setSession } from "@breatic/core";
import { ingestReportService, operationService } from "@breatic/domain";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";

type Sql = ReturnType<typeof postgres>;

/** The pro tier's monthly operations. */
export const ALLOWANCE = 4000;

/** The environment every metering suite runs under: payments on. */
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
  /** The current period's start. */
  periodStart: Date;
}

/** What a case varies about the standard account. */
export interface AccountOptions {
  /** Allowance rows already counted this period. */
  used?: number;
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
 * @param options - What is counted, held and owed.
 * @returns The account.
 */
export async function seedAccount(sql: Sql, options: AccountOptions = {}): Promise<Account> {
  const { used = 0, credits = 100, debt = 0 } = options;
  const now = await dbNow(sql);
  const periodStart = new Date(now.getTime() - 60_000);
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, 'pro', ${new Date(now.getTime() - 200 * 86_400_000)})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`oc-${studioId}`}, 'team', 'Counting')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`oc-${projectId}`}, 'Counting')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${projectId}, ${userId}, 'owner', null)`;
  await sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end, billing_cycle_anchor)
    values (${userId}, ${`sub_${crypto.randomUUID()}`}, 'pro', 'month', 'active', ${new Date(now.getTime() + 30 * 86_400_000)}, false, ${periodStart})`;
  const a: Account = { userId, studioId, projectId, spaceId: crypto.randomUUID(), cookie: await signIn(userId), periodStart };
  if (used > 0) await countedRows(sql, a, used);
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
  await sql`insert into studio_members(studio_id, user_id, role) values (${a.studioId}, ${userId}, 'editor')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${a.projectId}, ${userId}, 'editor', ${a.userId})`;
  return { userId, cookie: await signIn(userId) };
}

/**
 * Allowance rows counted this period.
 * @param sql - The suite's connection.
 * @param a - The account.
 * @param n - How many.
 */
export async function countedRows(sql: Sql, a: Account, n: number): Promise<void> {
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'counted', 'covered', 'allowance', ${a.periodStart}, ${a.periodStart}, ${a.periodStart}::timestamptz + interval '2 hours', ${a.periodStart}
    from generate_series(1, ${n})`;
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

/** One operation ledger row, as the cases read it. */
export interface LedgerRow {
  operation_key: string;
  kind: string;
  account_user_id: string;
  studio_id: string;
  project_id: string | null;
  actor_user_id: string;
  status: string;
  admitted_as: string;
  slot: string | null;
  period_start: Date | null;
  counted_at: Date | null;
  charge_request_id: string | null;
  asset_id: string | null;
  absorbed_by: string | null;
  absorbed_hold_released: boolean;
  input_asset_ids: string[];
  released_at: Date | null;
  release_reason: string | null;
  expires_at: Date;
}

/**
 * One ledger row by key.
 * @param sql - The suite's connection.
 * @param key - The operation key.
 * @returns The row, or undefined.
 */
export async function ledgerRow(sql: Sql, key: string): Promise<LedgerRow | undefined> {
  const [row] = await sql<LedgerRow[]>`select * from operation_ledger where operation_key = ${key}`;
  return row;
}

/**
 * Every ledger row of an account, oldest first, without the seeded counted rows.
 * @param sql - The suite's connection.
 * @param a - The account.
 * @returns The rows written since the account was seeded.
 */
export async function ledgerRows(sql: Sql, a: Account): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`select * from operation_ledger where account_user_id = ${a.userId} and created_at > ${a.periodStart} order by created_at, operation_key`;
}

/**
 * Operations counted into this period's allowance (`U`).
 * @param a - The account.
 * @returns The count.
 */
export async function used(a: Account): Promise<number> {
  return (await operationService.readOperationUsage(a.userId)).allowanceUsed;
}

/** Someone signed in. */
export interface Actor {
  userId: string;
  cookie: string;
}

/** A file the browser asks a ticket for. */
export interface TicketFile {
  filename?: string;
  content_type?: string;
  size?: number;
  client_hash?: string;
  [field: string]: unknown;
}

/**
 * Ask for an upload ticket in the account's project.
 * @param app - The server app.
 * @param a - The account.
 * @param file - What differs from a fresh 4 KB PNG with a fresh hash; `project_id: undefined` drops the project.
 * @param key - The operation id (`Idempotency-Key`); fresh by default.
 * @param who - Who asks; the account by default.
 * @returns The response and the ledger key the upload is counted under.
 */
export async function ticket(
  app: Hono,
  a: Account,
  file: TicketFile = {},
  key: string = crypto.randomUUID(),
  who: Actor = a,
): Promise<{ res: Response; key: string; storageKey: string | undefined; hash: string }> {
  const hash = typeof file.client_hash === "string" ? file.client_hash : crypto.randomBytes(32).toString("hex");
  const body = Object.fromEntries(
    Object.entries({ filename: "photo.png", content_type: "image/png", size: 4096, project_id: a.projectId, ...file, client_hash: hash }).filter(([, v]) => v !== undefined),
  );
  const res = await request(app, who.cookie, "POST", "/assets/upload-ticket", body, { "Idempotency-Key": key });
  const json = (await res.clone().json().catch(() => null)) as { data?: { storageKey?: string } } | null;
  return { res, key: `upload:${who.userId}:${key}`, storageKey: json?.data?.storageKey, hash };
}

/**
 * The ingest Worker's report that the bytes of an opened upload are stored.
 * @param storageKey - The upload's key.
 * @param contentType - What the Worker read the bytes as.
 * @param sha256 - Their hash; fresh by default.
 * @returns What applying the report answered.
 */
export async function stored(storageKey: string, contentType = "image/png", sha256: string = crypto.randomBytes(32).toString("hex")): Promise<unknown> {
  return ingestReportService.applyIngestReport({ storageKey, outcome: "completed", sha256, sizeBytes: 4096, contentType });
}

/**
 * Register an asset in the account's studio directly, as an earlier upload would have.
 * @param sql - The suite's connection.
 * @param studioId - Whose studio.
 * @param userId - Who produced it.
 * @param kind - Its kind.
 * @param storageKey - Its storage key; fresh by default.
 * @returns Its id, hash, storage key and public URL.
 */
export async function seedAsset(
  sql: Sql,
  studioId: string,
  userId: string,
  kind: "image" | "video" | "model" = "image",
  storageKey?: string,
): Promise<{ id: string; hash: string; storageKey: string; url: string }> {
  const hash = crypto.randomBytes(32).toString("hex");
  const key = storageKey ?? `${kind}/${hash}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "glb"}`;
  const mime = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "model/gltf-binary";
  const url = (await getStorageAdapter()).publicUrl(key);
  const [row] = await sql<{ id: string }[]>`insert into studio_assets(studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    values (${studioId}, ${hash}, ${key}, ${url}, 4096, ${mime}, ${kind}, 'upload', ${userId}) returning id`;
  return { id: row!.id, hash, storageKey: key, url };
}

/** A derived image the browser uploaded, deferred in the ledger. */
export interface Derived {
  /** Its ledger key. */
  key: string;
  assetId: string;
  /** Its public URL, as an operation's inputs carry it. */
  url: string;
}

/**
 * Upload a derived image (a crop, a drawing, a screenshot): `derived: true`
 * with a Space and no node, purpose or source, and have the Worker store it.
 * @param app - The server app.
 * @param sql - The suite's connection.
 * @param a - The account.
 * @param who - Who uploads; the account by default.
 * @returns The deferred row's key, the registered asset and its URL.
 */
export async function derivedUpload(app: Hono, sql: Sql, a: Account, who: Actor = a): Promise<Derived> {
  const { res, key, storageKey } = await ticket(app, a, { derived: true, space_id: a.spaceId }, crypto.randomUUID(), who);
  if (res.status !== 201 || storageKey === undefined) throw new Error(`derived ticket answered ${String(res.status)}: ${await res.text()}`);
  await stored(storageKey);
  const [asset] = await sql<{ id: string; storage_key: string }[]>`select id, storage_key from studio_assets where studio_id = ${a.studioId} and storage_key = ${storageKey}`;
  if (asset === undefined) throw new Error("the derived upload registered no asset");
  return { key, assetId: asset.id, url: (await getStorageAdapter()).publicUrl(asset.storage_key) };
}

/**
 * Admit one operation in the account's project.
 * @param a - The account.
 * @param kind - Its kind.
 * @param inputs - The media URLs it uses.
 * @param key - Its key; a fresh task key by default.
 * @param actorUserId - Who starts it; the account by default.
 * @returns The key and the admission's answer.
 */
export async function admit(
  a: Account,
  kind: "generation" | "tool_run" | "upload" | "url_paste" | "chat_message" | "text_tool" | "timeline" = "generation",
  inputs: string[] = [],
  key = `task:${crypto.randomUUID()}`,
  actorUserId: string = a.userId,
): Promise<{ key: string; answer: unknown }> {
  const answer = await operationService.admitOperation({ kind, key, projectId: a.projectId, actorUserId, inputs });
  return { key, answer };
}

/**
 * Send every log line of this process to a fresh file sink, so a case can
 * read the audit lines the code under test wrote.
 * @param serviceName - The sink's service name.
 * @returns A reader of the records written so far with one message.
 */
export function captureLogs(serviceName: string): (msg: string) => Record<string, unknown>[] {
  const logsRoot = mkdtempSync(join(tmpdir(), `${serviceName}-`));
  initLogger(serviceName, { logsRoot, debug: false, console: "none" });
  return (msg) => readdirSync(join(logsRoot, serviceName))
    .flatMap((file) => readFileSync(join(logsRoot, serviceName, file), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.msg === msg);
}
