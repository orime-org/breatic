// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Operations periods across tier and anchor changes, against real Postgres
 * (inner#1968, test spec area C: C-16, C-19 to C-23, C-25 to C-28).
 *
 * One period is identified by its start: a counted row stores `period_start`,
 * and "used this period" is the count of rows with the current start. Every
 * case below builds its history by writing rows with chosen `period_start`
 * values, and anchors with chosen instants, relative to the database clock;
 * nothing sleeps.
 *
 * Placement: the spec puts C-16 at core integration and C-26 at worker
 * integration. Neither package has an integration harness; the cross-package
 * database suites live here, and C-26 calls the domain sweep the worker job
 * runs.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { db, getMembershipReadingForUser, initCore, loadLocales } from "@breatic/core";
import { operationService } from "@breatic/domain";
import * as enterpriseMembershipService from "@server/modules/enterprise-membership/enterprise-membership.service.js";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";

let sql: ReturnType<typeof postgres>;
const DAY = 86_400_000;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-periods-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Account {
  userId: string;
  studioId: string;
  projectId: string;
}

/**
 * The database clock, to millisecond precision.
 * @returns The current statement time.
 */
async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  return row!.now;
}

/**
 * An account registered at a chosen time, administering a team studio with a project.
 * @param tier - Its stored membership tier.
 * @param registeredAt - Its `users.created_at`.
 * @returns The three ids.
 */
async function account(tier: string, registeredAt: Date): Promise<Account> {
  const userId = randomUUID();
  const studioId = randomUUID();
  const projectId = randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, ${tier}, ${registeredAt})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`op-${studioId}`}, 'team', 'Operations')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`op-${projectId}`}, 'Operations')`;
  return { userId, studioId, projectId };
}

/**
 * A subscription row carrying Stripe's billing cycle anchor.
 * @param userId - Its account.
 * @param tier - Its paid tier.
 * @param anchor - Its `billing_cycle_anchor`.
 * @param state - Its status and period end; live and renewing by default.
 * @param state.status - Stripe's status.
 * @param state.currentPeriodEnd - The paid period's end.
 * @param state.cancelAtPeriodEnd - Whether it ends at that period end.
 * @returns Its Stripe id.
 */
async function subscription(
  userId: string,
  tier: "pro" | "team",
  anchor: Date,
  state: { status?: string; currentPeriodEnd?: Date; cancelAtPeriodEnd?: boolean } = {},
): Promise<string> {
  const id = `sub_${randomUUID()}`;
  await sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end, billing_cycle_anchor)
    values (${userId}, ${id}, ${tier}, 'month', ${state.status ?? "active"}, ${state.currentPeriodEnd ?? new Date(anchor.getTime() + 31 * DAY)}, ${state.cancelAtPeriodEnd ?? false}, ${anchor})`;
  return id;
}

/**
 * Counted rows already on the books for one account.
 * @param a - The account and its studio.
 * @param n - How many rows.
 * @param periodStart - The period they were counted in.
 * @param slot - Which slot they took.
 */
async function counted(a: Account, n: number, periodStart: Date, slot: "allowance" | "overage" = "allowance"): Promise<void> {
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'counted', 'covered', ${slot}, ${periodStart}, ${periodStart}, ${periodStart}::timestamptz + interval '2 hours', ${periodStart}
    from generate_series(1, ${n})`;
}

/**
 * Admit one generation in the account's project.
 * @param a - The account.
 * @returns The operation key.
 */
async function admitGeneration(a: Account): Promise<string> {
  const key = `task:${randomUUID()}`;
  await operationService.admitOperation({ kind: "generation", key, projectId: a.projectId, actorUserId: a.userId, inputs: [] });
  return key;
}

/**
 * Count one admitted operation in its own success transaction.
 * @param key - The operation key.
 */
async function count(key: string): Promise<void> {
  await db.transaction((tx) => operationService.countOperation(key, tx));
}

/**
 * One ledger row by key.
 * @param key - The operation key.
 * @returns Its status, admission, slot and period start, or undefined.
 */
async function row(key: string): Promise<{ status: string; admitted_as: string; slot: string | null; period_start: Date | null } | undefined> {
  const [found] = await sql<{ status: string; admitted_as: string; slot: string | null; period_start: Date | null }[]>`
    select status, admitted_as, slot, period_start from operation_ledger where operation_key = ${key}`;
  return found;
}

/**
 * A period boundary one minute (or a few days) in the past, with an anchor one
 * calendar month before it, both on a day no later than the 28th so that no
 * clamping is involved.
 * @param now - The database clock.
 * @returns The anchor and the boundary where the current period began.
 */
function boundaryBehind(now: Date): { anchor: Date; boundary: Date } {
  const boundary = new Date(now.getTime() - 60_000);
  while (boundary.getUTCDate() > 28) boundary.setUTCDate(boundary.getUTCDate() - 1);
  const anchor = new Date(boundary);
  anchor.setUTCMonth(anchor.getUTCMonth() - 1);
  return { anchor, boundary };
}

describe("operations periods across anchor and tier changes", () => {
  it("C-16 an enterprise agreement saved again keeps its first-save time as the anchor", async () => {
    const a = await account("base", new Date((await dbNow()).getTime() - 300 * DAY));
    const body = (expectedRevision: number | null, expectedStoredTier: "base" | "enterprise") => ({
      targetTier: "enterprise" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      entryTimezone: "UTC",
      contractNumber: "ENT-C16",
      limits: { team_studios: 8, projects_per_studio: 20, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776, monthly_operations: 20000, running_tasks_per_user: 10 },
      expectedRevision,
      expectedStoredTier,
    });
    const save = (b: ReturnType<typeof body>) =>
      enterpriseMembershipService.save({ userId: a.userId, key: `bo-${randomUUID()}`, hash: randomBytes(32).toString("hex"), adminId: "operator-c16", body: b });
    expect((await save(body(null, "base"))).status).toBe(200);
    // The first save happened a day ago.
    const firstSave = new Date((await dbNow()).getTime() - DAY);
    await sql`update enterprise_memberships set created_at = ${firstSave}, updated_at = ${firstSave} where user_id = ${a.userId}`;
    expect((await save(body(1, "enterprise"))).status).toBe(200);
    expect((await save(body(2, "enterprise"))).status).toBe(200);
    const [stored] = await sql<{ revision: number; created_at: Date; updated_at: Date }[]>`select revision, created_at, updated_at from enterprise_memberships where user_id = ${a.userId}`;
    expect(stored!.revision).toBe(3);
    expect(stored!.updated_at.getTime()).toBeGreaterThan(firstSave.getTime());
    expect(stored!.created_at.toISOString()).toBe(firstSave.toISOString());
    const reading = await getMembershipReadingForUser(a.userId);
    expect(reading.operations.anchor.toISOString()).toBe(firstSave.toISOString());
    expect(reading.operations.monthly).toBe(20000);
  });

  it("C-19 base with 120 counted upgrades to pro: a new period starts at the subscription anchor, used 0, allowance 4000", async () => {
    const now = await dbNow();
    const registeredAt = new Date(now.getTime() - 20 * DAY);
    const a = await account("base", registeredAt);
    await counted(a, 120, registeredAt);
    const subscriptionAnchor = new Date(now.getTime() - 60_000);
    await sql`update users set membership_tier = 'pro' where id = ${a.userId}`;
    await subscription(a.userId, "pro", subscriptionAnchor);
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("covered");
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: subscriptionAnchor.toISOString(), allowanceUsed: 0, monthlyAllowance: 4000, allowanceRemaining: 4000 });
  });

  it("C-20 pro with 3000 counted upgrades to team in the same period: used stays 3000, allowance 16000, remaining 13000", async () => {
    const now = await dbNow();
    const a = await account("pro", new Date(now.getTime() - 200 * DAY));
    const subscriptionAnchor = new Date(now.getTime() - 5 * DAY);
    const subscriptionId = await subscription(a.userId, "pro", subscriptionAnchor);
    await counted(a, 3000, subscriptionAnchor);
    await sql`update subscriptions set tier = 'team' where stripe_subscription_id = ${subscriptionId}`;
    await sql`update users set membership_tier = 'team' where id = ${a.userId}`;
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("covered");
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: subscriptionAnchor.toISOString(), allowanceUsed: 3000, monthlyAllowance: 16000, allowanceRemaining: 13000 });
  });

  it("C-21 team with 5000 counted downgrades to pro in the same period: the next operation is admitted as overage and counted as overage", async () => {
    const now = await dbNow();
    const a = await account("team", new Date(now.getTime() - 200 * DAY));
    await seedDesignatedLot(sql, a, 10);
    const subscriptionAnchor = new Date(now.getTime() - 5 * DAY);
    const subscriptionId = await subscription(a.userId, "team", subscriptionAnchor);
    await counted(a, 5000, subscriptionAnchor);
    await sql`update subscriptions set tier = 'pro' where stripe_subscription_id = ${subscriptionId}`;
    await sql`update users set membership_tier = 'pro' where id = ${a.userId}`;
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("held");
    await count(key);
    expect(await row(key)).toMatchObject({ status: "counted", slot: "overage" });
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ monthlyAllowance: 4000, allowanceUsed: 5000, allowanceRemaining: 0, overageThisPeriod: 1 });
  });

  it.each([
    { how: "the subscription ended and the tier was lowered to base", lapse: "ended" as const },
    { how: "the subscription is read as lapsed past its period end", lapse: "stale" as const },
  ])("C-22 pro with 100 counted falls back to base when $how: the anchor returns to registration and the paid period's rows do not count", async ({ lapse }) => {
    const now = await dbNow();
    const registeredAt = new Date(now.getTime() - 20 * DAY);
    const a = await account("pro", registeredAt);
    const subscriptionAnchor = new Date(now.getTime() - 10 * DAY);
    const subscriptionId = await subscription(a.userId, "pro", subscriptionAnchor);
    await counted(a, 100, subscriptionAnchor);
    if (lapse === "ended") {
      await sql`update subscriptions set status = 'canceled' where stripe_subscription_id = ${subscriptionId}`;
      await sql`update users set membership_tier = 'base' where id = ${a.userId}`;
    } else {
      // A cancelling row ends at its period end; nothing from Stripe has arrived since.
      await sql`update subscriptions set cancel_at_period_end = true, current_period_end = ${new Date(now.getTime() - 3_600_000)} where stripe_subscription_id = ${subscriptionId}`;
    }
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("covered");
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: registeredAt.toISOString(), allowanceUsed: 0, monthlyAllowance: 500 });
  });

  it("C-23 base (200 counted) to pro and back to base within one registration period: used is 200 again", async () => {
    const now = await dbNow();
    const registeredAt = new Date(now.getTime() - 20 * DAY);
    const a = await account("base", registeredAt);
    await counted(a, 200, registeredAt);
    await sql`update users set membership_tier = 'pro' where id = ${a.userId}`;
    const subscriptionId = await subscription(a.userId, "pro", new Date(now.getTime() - 5 * DAY));
    await sql`update subscriptions set status = 'canceled' where stripe_subscription_id = ${subscriptionId}`;
    await sql`update users set membership_tier = 'base' where id = ${a.userId}`;
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("covered");
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: registeredAt.toISOString(), allowanceUsed: 200, monthlyAllowance: 500, allowanceRemaining: 300 });
  });

  it("C-25 an operation admitted before a period boundary and succeeding after it is counted in the period of its completion", async () => {
    const { anchor, boundary } = boundaryBehind(await dbNow());
    const a = await account("base", anchor);
    const key = await admitGeneration(a);
    // Admitted one minute before the boundary.
    await sql`update operation_ledger set created_at = ${new Date(boundary.getTime() - 60_000)} where operation_key = ${key}`;
    await count(key);
    const counted = await row(key);
    expect(counted?.status).toBe("counted");
    expect(counted?.period_start?.toISOString()).toBe(boundary.toISOString());
  });

  it("C-26 a derived upload made before a period boundary and swept after it is counted in the sweep's period", async () => {
    const now = await dbNow();
    const { anchor, boundary } = boundaryBehind(now);
    const a = await account("base", anchor);
    const hash = randomBytes(32).toString("hex");
    const [asset] = await sql<{ id: string }[]>`insert into studio_assets(studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
      values (${a.studioId}, ${hash}, ${`image/${hash}.png`}, ${`https://assets.example.test/${hash}.png`}, 100, 'image/png', 'image', 'upload', ${a.userId}) returning id`;
    const key = `upload:${a.userId}:${randomUUID()}`;
    await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, asset_id, expires_at, created_at)
      values (${key}, 'upload', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'deferred', 'covered', ${asset!.id}, ${new Date(now.getTime() - 1000)}, ${new Date(boundary.getTime() - 60_000)})`;
    await operationService.sweepDeferredOperations();
    const swept = await row(key);
    expect(swept?.status).toBe("counted");
    expect(swept?.period_start?.toISOString()).toBe(boundary.toISOString());
  });

  it("C-27 the previous period's unused allowance does not carry over: used 0, remaining 500", async () => {
    const { anchor, boundary } = boundaryBehind(await dbNow());
    const a = await account("base", anchor);
    await counted(a, 100, anchor);
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: boundary.toISOString(), allowanceUsed: 0, allowanceRemaining: 500, monthlyAllowance: 500 });
  });

  it("C-28 base with its 500 used becomes an active enterprise in the same period: covered, a new period from the agreement's first save", async () => {
    const now = await dbNow();
    const registeredAt = new Date(now.getTime() - 20 * DAY);
    const a = await account("base", registeredAt);
    await counted(a, 500, registeredAt);
    const agreedAt = new Date(now.getTime() - 60_000);
    await sql`insert into enterprise_memberships(user_id, expires_at, entry_timezone, contract_number, team_studios, projects_per_studio, concurrent_editors, studio_members, project_members, storage_bytes, monthly_operations, running_tasks_per_user, fallback_tier, revision, created_at, updated_at)
      values (${a.userId}, '2099-01-01T00:00:00Z', 'UTC', 'ENT-C28', 8, 20, 30, 200, 80, 1099511627776, 16000, 10, 'base', 1, ${agreedAt}, ${agreedAt})`;
    await sql`update users set membership_tier = 'enterprise' where id = ${a.userId}`;
    // No credits: anything but covered would be refused.
    const key = await admitGeneration(a);
    expect((await row(key))?.admitted_as).toBe("covered");
    const usage = await operationService.readOperationUsage(a.userId);
    expect(usage).toMatchObject({ periodStart: agreedAt.toISOString(), allowanceUsed: 0, monthlyAllowance: 16000 });
  });
});
