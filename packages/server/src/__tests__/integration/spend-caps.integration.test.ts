// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Monthly spend caps of a team studio (inner#1968, test spec area H: H-01 to
 * H-26, H-28 to H-30; invariants L1 to L3; PT-5; 5.1 resolutions #9, #10).
 * Real Postgres and Redis through the real Hono app, payments on.
 *
 * A studio admin sets a default per-person monthly cap and a studio-wide
 * monthly cap (`studio_spend_limits`), and may override one person's cap
 * (`studio_member_spend_limits`; `monthly_credits` null means no cap for that
 * person). The month is the UTC calendar month. Spent this month is every
 * charge request of the studio and person created this month, pending or
 * settled, plus every live `held` hold not taken over by a pending request
 * (`release_hold`). Under the studio's debt lock, an admission that holds
 * credits passes when spent + estimate stays within both caps; one admitted on
 * a balance above zero (chat, text tool, Timeline) passes while spent is below
 * both. A refusal is a `SpendCapReachedError` (402) carrying `scope`
 * (`member` or `studio`), `limit` and `resetsAt`; the wire answer is
 * `{ error: { code: 402, message, reason: "spend_cap_reached", scope, limit, resetsAt } }`.
 *
 * Shapes this suite chose where the design names none: the error carries
 * `scope`, `limit` (read as a number) and `resetsAt` (read through `new Date`)
 * as own properties; a member row of `GET …/spend-limits` carries
 * `effective: null` for no cap; amounts are compared as numbers.
 *
 * Placement: the spec puts most of these at domain integration; domain has no
 * integration harness, so they drive the server's admission functions, which
 * are the domain calls under one more layer.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

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

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import type { Hono } from "hono";
import { db, getRedis, initCore, loadLocales } from "@breatic/core";
import { creditHoldService, creditLotService, SMALLEST_CREDIT } from "@breatic/domain";
import { precheckCredits, reserveForRun } from "@server/modules/payment/credit-precheck.service.js";
import { keysOf } from "./chat-run-harness.js";
import { chargeNow } from "./studio-credit-fixtures.js";
import { startRun } from "@server/agent/chat-run.js";
import { chatQueue } from "@server/modules/chat-queue/chat-queue.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import { PAYMENTS_ON, dbNow, request, seedAccount, seedMember, signIn, ticket, type Account, type Actor } from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false, connection: { application_name: "spend-caps-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** This UTC month's start and the next one's. */
async function month(): Promise<{ start: Date; next: Date }> {
  const now = await dbNow(sql);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, next };
}

/**
 * The studio's two caps.
 * @param a - Whose studio.
 * @param memberDefault - The default per-person cap; null for none.
 * @param studioMonthly - The studio-wide cap; null for none.
 */
async function caps(a: Account, memberDefault: number | null, studioMonthly: number | null = null): Promise<void> {
  await sql`insert into studio_spend_limits(studio_id, member_default_credits, studio_monthly_credits, updated_by_user_id)
    values (${a.studioId}, ${memberDefault}, ${studioMonthly}, ${a.userId})`;
}

/**
 * One person's override.
 * @param a - Whose studio.
 * @param userId - Whose cap.
 * @param monthly - The cap; null for no cap.
 */
async function override(a: Account, userId: string, monthly: number | null): Promise<void> {
  await sql`insert into studio_member_spend_limits(studio_id, user_id, monthly_credits, updated_by_user_id) values (${a.studioId}, ${userId}, ${monthly}, ${a.userId})`;
}

/**
 * A charge request of the studio's, by one person.
 * @param a - Whose studio.
 * @param userId - Who spent it.
 * @param amount - How much.
 * @param at - When it was recorded; now by default.
 * @param releaseHold - The hold it takes over, if any; such a request is left pending.
 */
async function spend(a: Account, userId: string, amount: number, at?: Date, releaseHold?: string): Promise<void> {
  const settled = releaseHold === undefined;
  await sql`insert into credit_charge_requests(kind, actor_user_id, reference_id, project_id, studio_id, amount, release_hold, status, settled_at, created_at)
    values ('operation', ${userId}, ${`spent-${crypto.randomUUID()}`}, ${a.projectId}, ${a.studioId}, ${amount}, ${releaseHold ?? null},
      ${settled ? "settled" : "pending"}, ${settled ? new Date() : null}, ${at ?? new Date()})`;
}

/**
 * A credit hold of the studio's, by one person.
 * @param a - Whose studio.
 * @param userId - Whose.
 * @param amount - How much.
 * @param opts - Its status and expiry; held for an hour by default.
 * @param opts.status - `held` or `released`.
 * @param opts.expiresAt - When it stops counting.
 * @returns Its reference.
 */
async function hold(a: Account, userId: string, amount: number, opts: { status?: "held" | "released"; expiresAt?: Date } = {}): Promise<string> {
  const reference = `hold-${crypto.randomUUID()}`;
  const status = opts.status ?? "held";
  await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at, released_at)
    values (${a.studioId}, ${userId}, ${reference}, ${amount}, ${status}, ${opts.expiresAt ?? new Date(Date.now() + 3_600_000)}, ${status === "released" ? new Date() : null})`;
  return reference;
}

/** What an admission came to. */
type Admitted = "ok" | { scope: unknown; limit: number; resetsAt: string };

/**
 * Run an admission and read what it came to.
 * @param admission - The admission.
 * @returns `ok`, or the cap that refused it.
 */
async function outcome(admission: Promise<unknown>): Promise<Admitted> {
  try {
    await admission;
    return "ok";
  } catch (err) {
    const e = err as { statusCode?: number; name?: string; scope?: unknown; limit?: unknown; resetsAt?: unknown };
    expect(e.statusCode).toBe(402);
    expect(e.name).toBe("SpendCapReachedError");
    return { scope: e.scope, limit: Number(e.limit), resetsAt: new Date(String(e.resetsAt)).toISOString() };
  }
}

/**
 * Hold an estimate for one person's run, as a generation does.
 * @param a - Where.
 * @param userId - Who runs it.
 * @param estimate - Its estimate.
 * @returns What the admission came to.
 */
function reserve(a: Account, userId: string, estimate: number): Promise<Admitted> {
  return outcome(reserveForRun(a.projectId, userId, crypto.randomUUID(), estimate));
}

/**
 * A signed-in collaborator invited only to the account's project.
 * @param a - Whose project.
 * @returns Who.
 */
async function collaborator(a: Account): Promise<Actor> {
  const userId = crypto.randomUUID();
  await sql`insert into users(id, email, email_verified) values (${userId}, ${`${userId}@example.test`}, true)`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${a.projectId}, ${userId}, 'editor', ${a.userId})`;
  return { userId, cookie: await signIn(userId) };
}

/**
 * The refusal body of an answer.
 * @param res - The answer.
 * @returns Its `error`.
 */
async function refusal(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

/** A canvas generation request. */
function generation(a: Account): Record<string, unknown> {
  return { project_id: a.projectId, space_id: a.spaceId, source: "task", mode: "append", task_type: "image", model: "flux-schnell", params: { prompt: "a cat" } };
}

/** The studio's slug, as the fixtures write it. */
function slugOf(a: Account): string {
  return `oc-${a.studioId}`;
}

describe("H judging the caps at admission", () => {
  it("H-01 a member at the default cap is refused a generation with the member scope, the limit and the reset, and nothing is written", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 10);
    const res = await request(app, y.cookie, "POST", "/canvas/tasks", generation(a));
    expect(res.status).toBe(402);
    const error = await refusal(res);
    expect(error).toMatchObject({ code: 402, reason: "spend_cap_reached", scope: "member" });
    expect(Number(error.limit)).toBe(10);
    expect(error.resetsAt).toBe((await month()).next.toISOString());
    expect(await sql`select 1 from tasks where user_id = ${y.userId}`).toEqual([]);
    expect(await sql`select 1 from credit_holds where actor_user_id = ${y.userId}`).toEqual([]);
    expect(await sql`select 1 from operation_ledger where actor_user_id = ${y.userId}`).toEqual([]);
  });

  it("H-01 H-02 with 9 spent of 10, an estimate of 2 is refused and an estimate of 1 passes", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9);
    expect(await reserve(a, y.userId, 2)).toEqual({ scope: "member", limit: 10, resetsAt: (await month()).next.toISOString() });
    expect(await reserve(a, y.userId, 1)).toBe("ok");
  });

  it("H-03 H-04 H-05 an override raises the cap, a null override lifts it, and removing it falls back to the default", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9);
    await override(a, y.userId, 20);
    expect(await reserve(a, y.userId, 2)).toBe("ok");
    await sql`update studio_member_spend_limits set monthly_credits = null where studio_id = ${a.studioId} and user_id = ${y.userId}`;
    expect(await reserve(a, y.userId, 50)).toBe("ok");
    const res = await request(app, a.cookie, "DELETE", `/studio/${slugOf(a)}/members/${y.userId}/spend-limit`, undefined);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await reserve(a, y.userId, 2)).toMatchObject({ scope: "member", limit: 10 });
  });

  it("H-06 the studio cap refuses a member with no cap of their own", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, null, 100);
    await spend(a, a.userId, 99.5);
    expect(await reserve(a, y.userId, 1)).toMatchObject({ scope: "studio", limit: 100 });
  });

  it("H-07 a cap of 0 refuses a generation and the overage hold of an operation", async () => {
    const a = await seedAccount(sql, { used: 4000 });
    const y = await seedMember(sql, a);
    await caps(a, 0);
    expect(await reserve(a, y.userId, 1)).toMatchObject({ scope: "member", limit: 0 });
    const { res } = await ticket(app, a, {}, crypto.randomUUID(), y);
    expect(res.status).toBe(402);
    expect(await refusal(res)).toMatchObject({ reason: "spend_cap_reached", scope: "member" });
  });

  it("H-08 a cap of 0 leaves what spends no credits alone: an upload within the allowance and the free grid", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 0);
    const { res } = await ticket(app, a, {}, crypto.randomUUID(), y);
    expect(res.status, await res.clone().text()).toBe(201);
    const grid = await request(app, y.cookie, "POST", "/mini-tools", {
      project_id: a.projectId,
      space_id: a.spaceId,
      tool: "image.grid",
      node_ids: Array.from({ length: 4 }, () => crypto.randomUUID()),
      source: { url: "https://assets.invalid/image/a.png" },
      params: { rows: 2, cols: 2, skip: [] },
      slots: {},
    });
    expect(grid.status).not.toBe(402);
  });

  it("H-09 no caps set is no cap, apart from a cap of 0", async () => {
    const a = await seedAccount(sql, { credits: 2000 });
    const y = await seedMember(sql, a);
    await caps(a, null, null);
    expect(await reserve(a, y.userId, 1000)).toBe("ok");
  });

  it("H-10 H-11 an admission on a balance above zero passes while spent is below the cap, and is refused at it", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9.99);
    expect(await outcome(precheckCredits(a.projectId, y.userId, SMALLEST_CREDIT))).toBe("ok");
    await spend(a, y.userId, 0.01);
    expect(await outcome(precheckCredits(a.projectId, y.userId, SMALLEST_CREDIT))).toMatchObject({ scope: "member", limit: 10 });
  });

  it("5.1 #9 a self-hosted admin's studio is judged on a deployment with payments on", async () => {
    const a = await seedAccount(sql);
    await sql`update users set membership_tier = 'self_hosted' where id = ${a.userId}`;
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 10);
    expect(await reserve(a, y.userId, 1)).toMatchObject({ scope: "member" });
  });
});

describe("H counting what was spent this month", () => {
  it("H-12 H-18 counts requests pending or settled and live holds no pending request took over, each once", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await spend(a, y.userId, 3);
    const h1 = await hold(a, y.userId, 2);
    await spend(a, y.userId, 2, undefined, h1);
    await hold(a, y.userId, 1);
    await hold(a, y.userId, 5, { status: "released" });
    await hold(a, y.userId, 4, { expiresAt: new Date(Date.now() - 1000) });
    // 3 + 2 + 1 = 6: an estimate of 1 fits under 7, one of 1.01 does not.
    await caps(a, 7);
    expect(await reserve(a, y.userId, 1.01)).toMatchObject({ scope: "member" });
    expect(await reserve(a, y.userId, 1)).toBe("ok");
  });

  it("H-13 counts a request from the first instant of the month and not one from the last instant of the month before", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const { start } = await month();
    await spend(a, y.userId, 5, new Date(start.getTime() - 1));
    await spend(a, y.userId, 1, start);
    await caps(a, 2);
    expect(await reserve(a, y.userId, 1.01)).toMatchObject({ scope: "member" });
    expect(await reserve(a, y.userId, 1)).toBe("ok");
  });

  it("H-14 what was spent last month does not count this month", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const { start } = await month();
    await spend(a, y.userId, 10, new Date(start.getTime() - 86_400_000));
    await caps(a, 10);
    expect(await reserve(a, y.userId, 1)).toBe("ok");
  });

  it("H-16 two admissions at once with room for one: exactly one passes", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9);
    const got = await Promise.all([reserve(a, y.userId, 1), reserve(a, y.userId, 1)]);
    expect(got.filter((g) => g === "ok")).toHaveLength(1);
  });

  it("H-17 a started run is charged what it cost though that passes the cap; the next one is refused", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9);
    const taskId = crypto.randomUUID();
    expect(await outcome(reserveForRun(a.projectId, y.userId, taskId, 1))).toBe("ok");
    const before = Number((await creditHoldService.getCreditPosition(a.studioId)).spendable);
    await chargeNow({ actorUserId: y.userId, projectId: a.projectId, amount: 3, referenceId: taskId, releaseHold: taskId });
    expect(Number((await creditHoldService.getCreditPosition(a.studioId)).spendable)).toBeCloseTo(before - 3, 6);
    expect(await reserve(a, y.userId, SMALLEST_CREDIT)).toMatchObject({ scope: "member" });
  });

  it("H-19 a charge request of a run whose project was deleted still names the studio", async () => {
    const a = await seedAccount(sql);
    await sql`update projects set deleted_at = now() where id = ${a.projectId}`;
    const referenceId = `task-${crypto.randomUUID()}`;
    await db.transaction((tx) => creditLotService.requestCharge({ kind: "task", referenceId, actorUserId: a.userId, projectId: a.projectId, amount: 1 }, tx));
    const [row] = await sql<{ studio_id: string | null }[]>`select studio_id from credit_charge_requests where reference_id = ${referenceId}`;
    expect(row!.studio_id).toBe(a.studioId);
  });

  it("H-20 pending requests are found by the hold they take over through a partial index", async () => {
    const rows = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'credit_charge_requests'`;
    const partial = rows.map((r) => r.indexdef).filter((d) => /\(release_hold\)/.test(d));
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatch(/status\)::text = 'pending'::text\) AND \(release_hold IS NOT NULL\)/);
  });
});

describe("H the settings routes", () => {
  it("H-21 the admin reads both caps, the month, the studio's spent and every member with their relation", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const z = await collaborator(a);
    const q = crypto.randomUUID();
    await sql`insert into users(id, email, email_verified) values (${q}, ${`${q}@example.test`}, true)`;
    await spend(a, q, 2);
    await spend(a, y.userId, 1);
    await caps(a, 10);
    const res = await request(app, a.cookie, "GET", `/studio/${slugOf(a)}/spend-limits`, undefined);
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { members: Array<Record<string, unknown>> } };
    const { start, next } = await month();
    expect(Number(data.memberDefault)).toBe(10);
    expect(data.studioMonthly).toBeNull();
    expect(data.monthStart).toBe(start.toISOString());
    expect(data.nextResetAt).toBe(next.toISOString());
    expect(typeof data.studioSpent).toBe("string");
    expect(Number(data.studioSpent)).toBe(3);
    const relation = Object.fromEntries(data.members.map((m) => [m.userId, m.relation]));
    expect(relation).toMatchObject({ [a.userId]: "studio_member", [y.userId]: "studio_member", [z.userId]: "project_collaborator", [q]: "former" });
    const yRow = data.members.find((m) => m.userId === y.userId)!;
    expect(yRow).toMatchObject({ override: null });
    expect(typeof yRow.spent).toBe("string");
    expect(Number(yRow.spent)).toBe(1);
    expect(Number(yRow.effective)).toBe(10);
  });

  it("5.1 #10 a member with no cap reads `effective: null`", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const res = await request(app, a.cookie, "GET", `/studio/${slugOf(a)}/spend-limits`, undefined);
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: { members: Array<Record<string, unknown>> } };
    expect(data.members.find((m) => m.userId === y.userId)).toMatchObject({ effective: null, override: null });
  });

  it("H-22 writing the caps rounds up to the cent and keeps null", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "PUT", `/studio/${slugOf(a)}/spend-limits`, { memberDefault: 10.001, studioMonthly: null });
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await sql<{ member_default_credits: string | null; studio_monthly_credits: string | null }[]>`
      select member_default_credits::text, studio_monthly_credits::text from studio_spend_limits where studio_id = ${a.studioId} and deleted_at is null`;
    expect(Number(row!.member_default_credits)).toBe(10.01);
    expect(row!.studio_monthly_credits).toBeNull();
  });

  it("H-23 a negative cap is refused with 422 and nothing is written", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "PUT", `/studio/${slugOf(a)}/spend-limits`, { memberDefault: -1, studioMonthly: null });
    expect(res.status).toBe(422);
    expect(await sql`select 1 from studio_spend_limits where studio_id = ${a.studioId}`).toEqual([]);
  });

  it("H-24 an override for someone who is in neither the studio nor any of its projects is 404", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    expect((await request(app, a.cookie, "PUT", `/studio/${slugOf(a)}/members/${y.userId}/spend-limit`, { monthlyCredits: 5 })).status).toBe(200);
    const stranger = crypto.randomUUID();
    await sql`insert into users(id, email, email_verified) values (${stranger}, ${`${stranger}@example.test`}, true)`;
    const res = await request(app, a.cookie, "PUT", `/studio/${slugOf(a)}/members/${stranger}/spend-limit`, { monthlyCredits: 5 });
    expect(res.status).toBe(404);
    expect(await sql`select 1 from studio_member_spend_limits where user_id = ${stranger}`).toEqual([]);
  });

  it("H-15 a project collaborator is capped by the default, and an override the admin writes lets them through", async () => {
    const a = await seedAccount(sql);
    const z = await collaborator(a);
    await caps(a, 10);
    await spend(a, z.userId, 10);
    const refused = await request(app, z.cookie, "POST", "/canvas/tasks", generation(a));
    expect(refused.status).toBe(402);
    expect(await refusal(refused)).toMatchObject({ reason: "spend_cap_reached", scope: "member" });
    const set = await request(app, a.cookie, "PUT", `/studio/${slugOf(a)}/members/${z.userId}/spend-limit`, { monthlyCredits: 20 });
    expect(set.status, await set.clone().text()).toBe(200);
    expect((await request(app, z.cookie, "POST", "/canvas/tasks", generation(a))).status).toBe(201);
  });

  it("H-25 a member who is not admin is refused all four with 403", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const slug = slugOf(a);
    const answers = [
      await request(app, y.cookie, "GET", `/studio/${slug}/spend-limits`, undefined),
      await request(app, y.cookie, "PUT", `/studio/${slug}/spend-limits`, { memberDefault: 1, studioMonthly: null }),
      await request(app, y.cookie, "PUT", `/studio/${slug}/members/${y.userId}/spend-limit`, { monthlyCredits: 100 }),
      await request(app, y.cookie, "DELETE", `/studio/${slug}/members/${y.userId}/spend-limit`, undefined),
    ];
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  });

  it("5.1 #9 the four routes answer 404 on a personal studio", async () => {
    const a = await seedAccount(sql);
    expect((await request(app, a.cookie, "GET", `/studio/${slugOf(a)}/spend-limits`, undefined)).status).toBe(200);
    await sql`update studios set type = 'personal' where id = ${a.studioId}`;
    const slug = slugOf(a);
    const answers = [
      await request(app, a.cookie, "GET", `/studio/${slug}/spend-limits`, undefined),
      await request(app, a.cookie, "PUT", `/studio/${slug}/spend-limits`, { memberDefault: 1, studioMonthly: null }),
      await request(app, a.cookie, "PUT", `/studio/${slug}/members/${a.userId}/spend-limit`, { monthlyCredits: 100 }),
      await request(app, a.cookie, "DELETE", `/studio/${slug}/members/${a.userId}/spend-limit`, undefined),
    ];
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404]);
  });

  it("H-26 leaving the studio, removed or by oneself, soft-deletes the override", async () => {
    const a = await seedAccount(sql);
    const removed = await seedMember(sql, a);
    const leaver = await seedMember(sql, a);
    await override(a, removed.userId, 20);
    await override(a, leaver.userId, 20);
    expect((await request(app, a.cookie, "DELETE", `/studio/${slugOf(a)}/members/${removed.userId}`, undefined)).status).toBeLessThan(300);
    expect((await request(app, leaver.cookie, "DELETE", `/studio/${slugOf(a)}/membership`, undefined)).status).toBeLessThan(300);
    const rows = await sql<{ user_id: string; deleted_at: Date | null }[]>`select user_id, deleted_at from studio_member_spend_limits where studio_id = ${a.studioId}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.deleted_at).not.toBeNull();
  });

  it("H-28 one live override per person and studio; a soft-deleted one makes room for another", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await override(a, y.userId, 5);
    await expect(override(a, y.userId, 6)).rejects.toThrow();
    await sql`update studio_member_spend_limits set deleted_at = now() where studio_id = ${a.studioId} and user_id = ${y.userId}`;
    await override(a, y.userId, 7);
  });
});

describe("H refusals on the entries", () => {
  it("H-29 a server mini-tool at the cap is refused with no task and no node task written", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 10);
    const nodeId = crypto.randomUUID();
    const res = await request(app, y.cookie, "POST", "/mini-tools", {
      project_id: a.projectId, space_id: a.spaceId, tool: "image.upscale", node_ids: [nodeId],
      source: { url: "https://assets.invalid/image/a.png" }, params: { target_megapixels: 16, creativity: 2 }, slots: {},
    });
    expect(res.status).toBe(402);
    expect(await refusal(res)).toMatchObject({ reason: "spend_cap_reached", scope: "member" });
    expect(await sql`select 1 from node_tasks where node_id = ${nodeId}`).toEqual([]);
    expect(await sql`select 1 from tasks where user_id = ${y.userId}`).toEqual([]);
  });

  it("H-30 a queued message at the cap opens no run; sync says the cap blocks it, with its scope and reset", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    const opened = await request(app, y.cookie, "POST", "/chat/open", { project_id: a.projectId });
    const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
    await getRedis().set(keysOf(conversationId).active, "R-running");
    const id = crypto.randomUUID();
    const sent = await request(app, y.cookie, "POST", "/chat/message", { id, message: "hello", project_id: a.projectId, conversation_id: conversationId }, { "Idempotency-Key": id });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await spend(a, y.userId, 10);
    await getRedis().del(keysOf(conversationId).active);
    const res = await request(app, y.cookie, "POST", `/chat/conversations/${conversationId}/sync`, { project_id: a.projectId });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ running: false, blocked: "spend_cap", scope: "member", resetsAt: (await month()).next.toISOString() });
    expect((data.pending as unknown[]).length).toBe(1);
  });
});

describe("H-11 the three admissions on a balance above zero share the cap", () => {
  it("refuses a send, opens no new round for a queued message, and sync says the cap blocks it", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    await caps(a, 10);
    await spend(a, y.userId, 9.99);
    const opened = await request(app, y.cookie, "POST", "/chat/open", { project_id: a.projectId });
    const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
    await getRedis().set(keysOf(conversationId).active, "R-running");
    const queuedId = crypto.randomUUID();
    const queued = await request(app, y.cookie, "POST", "/chat/message", { id: queuedId, message: "hello", project_id: a.projectId, conversation_id: conversationId }, { "Idempotency-Key": queuedId });
    expect(queued.status, await queued.clone().text()).toBeLessThan(300);
    await spend(a, y.userId, 0.01);

    // The send: refused at the cap while the run still holds the conversation.
    const sendId = crypto.randomUUID();
    const sent = await request(app, y.cookie, "POST", "/chat/message", { id: sendId, message: "again", project_id: a.projectId, conversation_id: conversationId }, { "Idempotency-Key": sendId });
    expect(sent.status).toBe(402);
    expect(await refusal(sent)).toMatchObject({ reason: "spend_cap_reached", scope: "member" });

    // The new round: the run ends and the next one is claimed for what waits.
    await getRedis().del(keysOf(conversationId).active);
    const claimed = await chatQueue().claim(conversationId);
    if (claimed.status !== "start") throw new Error("no run claimed");
    const { opened: round } = startRun({ conversationId, projectId: a.projectId, userId: y.userId, runId: claimed.runId, entrance: { kind: "head" } });
    expect(await round).toEqual({ running: false });
    expect((await chatQueue().pending(conversationId)).map((item) => item.id)).toEqual([queuedId]);

    // The sync.
    const synced = await request(app, y.cookie, "POST", `/chat/conversations/${conversationId}/sync`, { project_id: a.projectId });
    expect(((await synced.json()) as { data: Record<string, unknown> }).data).toMatchObject({ running: false, blocked: "spend_cap", scope: "member" });
  });
});

describe("H-27 a transfer leaves the caps alone", () => {
  // Written against the design: the caps belong to the studio, so a transfer
  // writes neither table. Nothing in the transfer touches them today, so this
  // passes once the two tables exist.
  it("keeps both tables as they were after the admin hands the studio over", async () => {
    // No credits designated: a transfer is refused while a pack is assigned.
    const a = await seedAccount(sql, { credits: 0 });
    const y = await seedMember(sql, a);
    await sql`update users set membership_tier = 'pro' where id = ${y.userId}`;
    await caps(a, 10, 100);
    await override(a, y.userId, 20);
    const before = {
      studio: await sql`select * from studio_spend_limits where studio_id = ${a.studioId}`,
      members: await sql`select * from studio_member_spend_limits where studio_id = ${a.studioId} order by id`,
    };
    await studioTransferService.requestTransfer(slugOf(a), a.userId, y.userId);
    const [transfer] = await sql<{ id: string }[]>`select id from studio_transfers where studio_id = ${a.studioId} order by created_at desc limit 1`;
    await studioTransferService.confirmTransfer(transfer!.id, y.userId);
    const [role] = await sql<{ role: string }[]>`select role from studio_members where studio_id = ${a.studioId} and user_id = ${y.userId}`;
    expect(role!.role).toBe("admin");
    expect(await sql`select * from studio_spend_limits where studio_id = ${a.studioId}`).toEqual(before.studio);
    expect(await sql`select * from studio_member_spend_limits where studio_id = ${a.studioId} order by id`).toEqual(before.members);
  });
});

describe("PT-5 caps under concurrent admissions (L1, L3)", () => {
  it("whatever passes keeps each person and the studio within their caps", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.constantFrom(0, 1, 5, 10), { nil: null }),
        fc.option(fc.constantFrom(0, 1, 5, 10), { nil: null }),
        fc.array(fc.record({ override: fc.option(fc.option(fc.constantFrom(0, 1, 5, 10), { nil: null }), { nil: undefined }), spent: fc.integer({ min: 0, max: 12 }) }), { minLength: 2, maxLength: 4 }),
        fc.array(fc.record({ who: fc.nat(), estimate: fc.constantFrom(0.5, 1, 2, 3) }), { minLength: 1, maxLength: 8 }),
        async (memberDefault, studioMonthly, people, admissions) => {
          const a = await seedAccount(sql, { credits: 1000 });
          const members: string[] = [];
          for (const person of people) {
            const m = await seedMember(sql, a);
            members.push(m.userId);
            if (person.spent > 0) await spend(a, m.userId, person.spent);
            if (person.override !== undefined) await override(a, m.userId, person.override);
          }
          await caps(a, memberDefault, studioMonthly);
          const got = await Promise.all(admissions.map((x) => reserve(a, members[x.who % members.length]!, x.estimate).then((o) => ({ ...x, o }))));
          const admitted = new Map<string, number>();
          for (const g of got) {
            if (g.o === "ok") admitted.set(members[g.who % members.length]!, (admitted.get(members[g.who % members.length]!) ?? 0) + g.estimate);
            else expect(["member", "studio"]).toContain(g.o.scope);
          }
          const studioBefore = people.reduce((sum, p) => sum + p.spent, 0);
          const studioAdmitted = [...admitted.values()].reduce((sum, v) => sum + v, 0);
          if (studioMonthly !== null && studioAdmitted > 0) expect(studioBefore + studioAdmitted).toBeLessThanOrEqual(studioMonthly);
          people.forEach((person, i) => {
            const taken = admitted.get(members[i]!) ?? 0;
            const cap = person.override !== undefined ? person.override : memberDefault;
            if (cap !== null && taken > 0) expect(person.spent + taken).toBeLessThanOrEqual(cap);
          });
          const [live] = await sql<{ n: number }[]>`select count(*)::int as n from studio_spend_limits where studio_id = ${a.studioId} and deleted_at is null`;
          expect(live!.n).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

