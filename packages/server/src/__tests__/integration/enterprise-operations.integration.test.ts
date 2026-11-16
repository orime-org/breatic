// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Enterprise operations terms (inner#1968, test spec area F: F-01 to F-13,
 * F-15 to F-19, F-21, F-22), through the signed internal app and the services
 * behind the account panel, against real Postgres.
 *
 * The agreement carries two optional limits, `monthly_operations` and
 * `running_tasks_per_user` (1 to 30); a save that leaves them out keeps the
 * values already agreed, or the column defaults 16,000 and 10. The internal
 * read answers a top-level `operations` of `{ monthly, used, remaining,
 * periodStart, nextResetAt }`. An active agreement's `storage_bytes` caps
 * storage; an enterprise without an agreement stays unlimited.
 *
 * Periods are built from anchors relative to the database clock: the anchor is
 * one calendar month before a boundary a minute in the past, on a day no later
 * than the 28th, so the current period starts at the boundary and resets one
 * month later with no clamping. Nothing sleeps.
 *
 * Placement: the spec puts F-15 and F-22 at domain integration and F-21 at
 * core integration; neither package has an integration harness.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, runningTaskLimitForStudio } from "@breatic/core";
import { creditLotService, operationService } from "@breatic/domain";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";
import * as enterpriseMembershipService from "@server/modules/enterprise-membership/enterprise-membership.service.js";
import { call, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";

const suite = useInternalApp("enterprise-operations");
const MONTH_FREE_DAY = 28;
const TIB = 1024 ** 4;
const SIX = { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 };
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const ROUTE = "/internal/v1/accounts/:userId/enterprise-membership";

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
  const [row] = await suite.sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  return row!.now;
}

/**
 * A period boundary a minute in the past on a day no later than the 28th, and
 * an anchor one calendar month before it.
 * @returns The anchor, the current period's start and its end.
 */
async function period(): Promise<{ anchor: Date; start: Date; end: Date }> {
  const start = new Date((await dbNow()).getTime() - 60_000);
  while (start.getUTCDate() > MONTH_FREE_DAY) start.setUTCDate(start.getUTCDate() - 1);
  const anchor = new Date(start);
  anchor.setUTCMonth(anchor.getUTCMonth() - 1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { anchor, start, end };
}

/**
 * An account registered at a chosen time, administering a team studio with a project.
 * @param tier - Its stored tier.
 * @param registeredAt - Its `users.created_at`.
 * @returns The three ids.
 */
async function account(tier = "pro", registeredAt: Date = new Date()): Promise<Account> {
  const userId = randomUUID();
  const studioId = randomUUID();
  const projectId = randomUUID();
  await suite.sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, ${tier}, ${registeredAt})`;
  await suite.sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`eo-${studioId}`}, 'team', 'Enterprise')`;
  await suite.sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await suite.sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`eo-${projectId}`}, 'Enterprise')`;
  return { userId, studioId, projectId };
}

/**
 * The agreement endpoint for one account.
 * @param userId - The account.
 * @returns Its path.
 */
function path(userId: string): string {
  return `/internal/v1/accounts/${userId}/enterprise-membership`;
}

/**
 * One signed agreement write.
 * @param userId - The account.
 * @param limits - The limits object sent as is.
 * @param over - Other body fields.
 * @param key - The idempotency key; a fresh one by default.
 * @returns The response.
 */
function post(userId: string, limits: Record<string, number>, over: Record<string, unknown> = {}, key = `bo-${randomUUID()}`): ReturnType<typeof call> {
  return call(suite.baseUrl, path(userId), {
    idempotencyKey: key,
    body: { targetTier: "enterprise", expiresAt: FUTURE, entryTimezone: "UTC", contractNumber: "ENT-F", limits, expectedRevision: null, expectedStoredTier: "pro", ...over },
  });
}

/**
 * Save an agreement and require it applied.
 * @param userId - The account.
 * @param limits - The limits sent.
 * @param over - Other body fields.
 */
async function agree(userId: string, limits: Record<string, number>, over: Record<string, unknown> = {}): Promise<void> {
  const saved = await post(userId, limits, over);
  expect(saved.status).toBe(200);
  expect(saved.json.status).toBe("applied");
}

/**
 * Move an agreement's first-save time, which anchors its periods.
 * @param userId - The account.
 * @param at - The new first-save time.
 */
async function anchorAgreement(userId: string, at: Date): Promise<void> {
  await suite.sql`update enterprise_memberships set created_at = ${at}, updated_at = ${at} where user_id = ${userId}`;
}

/**
 * Counted rows on the books for one account.
 * @param a - The account and its studio.
 * @param n - How many.
 * @param periodStart - The period they were counted in.
 */
async function counted(a: Account, n: number, periodStart: Date): Promise<void> {
  await suite.sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'counted', 'covered', 'allowance', ${periodStart}, ${periodStart}, ${periodStart}::timestamptz + interval '2 hours', ${periodStart}
    from generate_series(1, ${n})`;
}

/**
 * The two agreement columns.
 * @param userId - The account.
 * @returns Both values.
 */
async function columns(userId: string): Promise<{ monthly_operations: number; running_tasks_per_user: number } | undefined> {
  const [row] = await suite.sql<{ monthly_operations: number; running_tasks_per_user: number }[]>`
    select monthly_operations, running_tasks_per_user from enterprise_memberships where user_id = ${userId}`;
  return row;
}

/**
 * Registered bytes in a studio.
 * @param a - Whose studio.
 * @param size - How many bytes.
 */
async function bytes(a: Account, size: number): Promise<void> {
  const key = randomUUID();
  await suite.sql`insert into studio_assets(studio_id, produced_by_user_id, content_hash, storage_key, file_url, mime_type, kind, source, size_bytes)
    values (${a.studioId}, ${a.userId}, ${key}, ${key}, ${`https://example.test/${key}.png`}, 'image/png', 'image', 'upload', ${size})`;
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
 * One ledger row by key.
 * @param key - The operation key.
 * @returns Its admission, status, slot and charge request.
 */
async function ledger(key: string): Promise<{ admitted_as: string; status: string; slot: string | null; charge_request_id: string | null } | undefined> {
  const [row] = await suite.sql<{ admitted_as: string; status: string; slot: string | null; charge_request_id: string | null }[]>`
    select admitted_as, status, slot, charge_request_id from operation_ledger where operation_key = ${key}`;
  return row;
}

describe("enterprise agreement operation terms", () => {
  it("F-01 an agreement saved with monthly_operations 20000 and running_tasks_per_user 20 stores and reads both", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000, running_tasks_per_user: 20 });
    expect(await columns(e.userId)).toEqual({ monthly_operations: 20000, running_tasks_per_user: 20 });
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.status).toBe(200);
    expect(read.json.snapshot.enterprise.limits).toMatchObject({ monthly_operations: 20000, running_tasks_per_user: 20 });
  });

  it("F-02 a later save with only the six limits keeps 20000 and 20", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000, running_tasks_per_user: 20 });
    await agree(e.userId, SIX, { expectedRevision: 1, expectedStoredTier: "enterprise" });
    expect(await columns(e.userId)).toEqual({ monthly_operations: 20000, running_tasks_per_user: 20 });
  });

  it("F-03 a first save with only the six limits stores 16000 and 10", async () => {
    const e = await account();
    await agree(e.userId, SIX);
    expect(await columns(e.userId)).toEqual({ monthly_operations: 16000, running_tasks_per_user: 10 });
  });

  it.each([
    { running_tasks_per_user: 0 },
    { running_tasks_per_user: 31 },
    { monthly_operations: -1 },
    { monthly_operations: 2147483648 },
  ] as Record<string, number>[])("F-04 refuses %o with 422, no reason and no write", async (extra) => {
    const e = await account();
    const requestKey = `bo-${randomUUID()}`;
    const refused = await post(e.userId, { ...SIX, ...extra }, {}, requestKey);
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("invalid_body");
    expect(refused.json.reason).toBeUndefined();
    expect(await columns(e.userId)).toBeUndefined();
    expect(await suite.sql`select key from enterprise_membership_operations where key = ${requestKey}`).toEqual([]);
  });

  it.each([
    { running_tasks_per_user: 1 },
    { running_tasks_per_user: 15 },
    { running_tasks_per_user: 30 },
    { monthly_operations: 0 },
    { monthly_operations: 2147483647 },
  ] as Record<string, number>[])("F-04 accepts %o", async (extra) => {
    const e = await account();
    await agree(e.userId, { ...SIX, ...extra });
    expect(await columns(e.userId)).toMatchObject(extra);
  });

  it("F-05 an operation result stored before the two fields existed is replayed as stored", async () => {
    const e = await account();
    const requestKey = `bo-${randomUUID()}`;
    expect((await post(e.userId, SIX, {}, requestKey)).status).toBe(200);
    // What a result written before the migration holds: limits without the two fields.
    await suite.sql`update enterprise_membership_operations
      set result = result #- '{after,enterprise,limits,monthly_operations}' #- '{after,enterprise,limits,running_tasks_per_user}'
      where key = ${requestKey}`;
    const [stored] = await suite.sql<{ result: { after: { enterprise: { limits: Record<string, number> } } } }[]>`
      select result from enterprise_membership_operations where key = ${requestKey}`;
    const replay = await call(suite.baseUrl, `/internal/v1/enterprise-membership-operations/${requestKey}`);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(stored!.result);
    expect(replay.json.after.enterprise.limits).toEqual(SIX);
  });

  it("F-06 the same key with and without the two fields is a different request", async () => {
    const e = await account();
    const withTwo = { targetTier: "enterprise", expiresAt: FUTURE, entryTimezone: "UTC", contractNumber: "ENT-F", limits: { ...SIX, monthly_operations: 20000, running_tasks_per_user: 20 }, expectedRevision: null, expectedStoredTier: "pro" };
    const withoutTwo = { ...withTwo, limits: SIX };
    expect(fingerprint("POST", ROUTE, e.userId, withTwo)).not.toBe(fingerprint("POST", ROUTE, e.userId, withoutTwo));
    const requestKey = `bo-${randomUUID()}`;
    const first = await call(suite.baseUrl, path(e.userId), { body: withTwo, idempotencyKey: requestKey });
    expect(first.status).toBe(200);
    expect(first.json.status).toBe("applied");
    const second = await call(suite.baseUrl, path(e.userId), { body: withoutTwo, idempotencyKey: requestKey });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("idempotency_conflict");
  });
});

describe("internal read: operations of the current period", () => {
  it("F-07 an active agreement of 20000 with 9830 counted reads used 9830 and remaining 10170 in the agreement's period", async () => {
    const { anchor, start, end } = await period();
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000 });
    await anchorAgreement(e.userId, anchor);
    await counted(e, 9830, start);
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.status).toBe(200);
    expect(read.json.operations).toEqual({ monthly: 20000, used: 9830, remaining: 10170, periodStart: start.toISOString(), nextResetAt: end.toISOString() });
  });

  it("F-08 with 20000 counted it reads used 20000 and remaining 0", async () => {
    const { anchor, start } = await period();
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000 });
    await anchorAgreement(e.userId, anchor);
    await counted(e, 20000, start);
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.json.operations).toMatchObject({ monthly: 20000, used: 20000, remaining: 0 });
  });

  it("F-09 with 9830 counted and the agreement lowered to 5000 it reads remaining 0", async () => {
    const { anchor, start } = await period();
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000 });
    await anchorAgreement(e.userId, anchor);
    await counted(e, 9830, start);
    await agree(e.userId, { ...SIX, monthly_operations: 5000 }, { expectedRevision: 1, expectedStoredTier: "enterprise" });
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.json.operations).toMatchObject({ monthly: 5000, used: 9830, remaining: 0 });
  });

  it("F-10 an enterprise without an agreement reads 16000 in the registration period", async () => {
    const { anchor, start, end } = await period();
    const e = await account("enterprise", anchor);
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.status).toBe(200);
    expect(read.json.operations).toEqual({ monthly: 16000, used: 0, remaining: 16000, periodStart: start.toISOString(), nextResetAt: end.toISOString() });
  });

  it("F-11 an expired agreement falling back to base reads 500", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000 }, { expiresAt: PAST });
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.json.reading.effectiveTier).toBe("base");
    expect(read.json.operations.monthly).toBe(500);
  });

  it("F-12 an ordinary team account reads the team tier's 16000", async () => {
    const e = await account("team");
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.status).toBe(200);
    expect(read.json.operations).toMatchObject({ monthly: 16000, used: 0, remaining: 16000 });
  });

  it("F-13 an unknown account answers 404", async () => {
    const read = await call(suite.baseUrl, path(randomUUID()));
    expect(read.status).toBe(404);
  });
});

describe("enterprise overage, storage cap and running-task limit", () => {
  it("F-15 an active agreement of 20000 used up, with 1 credit: two generations each hold and are charged 0.5, leaving 0", async () => {
    const { anchor, start } = await period();
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 20000 });
    await anchorAgreement(e.userId, anchor);
    await counted(e, 20000, start);
    const lot = await seedDesignatedLot(suite.sql, e, 1);
    for (let i = 0; i < 2; i++) {
      const key = await admitGeneration(e);
      expect((await ledger(key))?.admitted_as).toBe("held");
      await db.transaction((tx) => operationService.countOperation(key, tx));
      const row = await ledger(key);
      expect(row).toMatchObject({ status: "counted", slot: "overage" });
      expect(row?.charge_request_id).toEqual(expect.any(String));
      await creditLotService.settleCharge(row!.charge_request_id!);
      const [request] = await suite.sql<{ kind: string; amount: string; status: string }[]>`
        select kind, amount::text, status from credit_charge_requests where id = ${row!.charge_request_id}`;
      expect(request).toEqual({ kind: "operation_overage", amount: "0.500000", status: "settled" });
    }
    const [balance] = await suite.sql<{ remaining: string }[]>`select remaining_credits::text as remaining from credit_lots where id = ${lot}`;
    expect(Number(balance!.remaining)).toBe(0);
  });

  it("F-16 an active agreement of 5 TiB refuses upload and generation at exactly 5 TiB and lets an upload through one byte under", async () => {
    const full = await account();
    await agree(full.userId, { ...SIX, storage_bytes: 5 * TIB });
    await bytes(full, 5 * TIB);
    await expect(assertStorageAllowance(full.projectId, "upload")).rejects.toMatchObject({ statusCode: 507 });
    await expect(assertStorageAllowance(full.projectId, "generate")).rejects.toMatchObject({ statusCode: 507 });

    const room = await account();
    await agree(room.userId, { ...SIX, storage_bytes: 5 * TIB });
    await bytes(room, 5 * TIB - 1);
    await expect(assertStorageAllowance(room.projectId, "upload")).resolves.toBeUndefined();
  });

  it("F-17 an enterprise without an agreement at 10 TiB is let through", async () => {
    const e = await account("enterprise");
    await bytes(e, 10 * TIB);
    await expect(assertStorageAllowance(e.projectId, "upload")).resolves.toBeUndefined();
  });

  it("F-18 an expired agreement read as pro through a live subscription is refused at 100 GiB", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, storage_bytes: 5 * TIB }, { expiresAt: PAST });
    await suite.sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end)
      values (${e.userId}, ${`sub_${randomUUID()}`}, 'pro', 'month', 'active', ${FUTURE}, false)`;
    await bytes(e, 100 * 1024 ** 3);
    await expect(assertStorageAllowance(e.projectId, "upload")).rejects.toMatchObject({ statusCode: 507 });
  });

  it("F-19 the account membership answer carries storageLimitBytes for pro, an active agreement and a missing agreement", async () => {
    const pro = await account("pro");
    const active = await account();
    await agree(active.userId, { ...SIX, storage_bytes: 5 * TIB });
    const missing = await account("enterprise");
    expect((await readAccountMembership(pro.userId)).storageLimitBytes).toBe(107374182400);
    expect((await readAccountMembership(active.userId)).storageLimitBytes).toBe(5497558138880);
    expect((await readAccountMembership(missing.userId)).storageLimitBytes).toBeNull();
  });

  it("F-21 runningTaskLimitForStudio reads 30 from an active agreement and 10 for an enterprise without one", async () => {
    const active = await account();
    await agree(active.userId, { ...SIX, running_tasks_per_user: 30 });
    const missing = await account("enterprise");
    expect(await runningTaskLimitForStudio(active.studioId)).toBe(30);
    expect(await runningTaskLimitForStudio(missing.studioId)).toBe(10);
  });
});

describe("F-22 an admission and an agreement save on the same account row", () => {
  /**
   * An active agreement of 16000 with 150 counted this period, and credits to hold with.
   * @returns The account.
   */
  async function seeded(): Promise<Account> {
    const { anchor, start } = await period();
    const e = await account();
    await agree(e.userId, { ...SIX, monthly_operations: 16000 });
    await anchorAgreement(e.userId, anchor);
    await counted(e, 150, start);
    await seedDesignatedLot(suite.sql, e, 10);
    return e;
  }

  /**
   * Lower the agreement to 100 operations.
   * @param e - The account.
   * @returns The service result.
   */
  function lower(e: Account): ReturnType<typeof enterpriseMembershipService.save> {
    return enterpriseMembershipService.save({
      userId: e.userId,
      key: `bo-${randomUUID()}`,
      hash: randomBytes(32).toString("hex"),
      adminId: "operator-f22",
      body: { targetTier: "enterprise", expiresAt: FUTURE, entryTimezone: "UTC", contractNumber: "ENT-F22", limits: { ...SIX, monthly_operations: 100 }, expectedRevision: 1, expectedStoredTier: "enterprise" },
    });
  }

  it("the save takes the row first: the admission reads 100 and holds for overage", async () => {
    const e = await seeded();
    const blocker = await suite.sql.reserve();
    let saving: ReturnType<typeof lower> | undefined;
    let admitting: Promise<string> | undefined;
    try {
      await blocker`begin`;
      await blocker`select id from users where id = ${e.userId} for update`;
      saving = lower(e);
      await waitUntilBlockedOn(suite.sql, ["users", "for update"]);
      admitting = admitGeneration(e);
      await waitUntilBlockedOn(suite.sql, ["users", "for no key update"]);
    } finally {
      await blocker`commit`;
      blocker.release();
    }
    expect((await saving).status).toBe(200);
    const key = await admitting;
    expect((await ledger(key))?.admitted_as).toBe("held");
    expect(await columns(e.userId)).toMatchObject({ monthly_operations: 100 });
  });

  it("the admission takes the row first: it reads 16000 and is covered, and the save completes after it", async () => {
    const e = await seeded();
    const blocker = await suite.sql.reserve();
    let saving: ReturnType<typeof lower> | undefined;
    let admitting: Promise<string> | undefined;
    try {
      await blocker`begin`;
      await blocker`select id from users where id = ${e.userId} for update`;
      admitting = admitGeneration(e);
      await waitUntilBlockedOn(suite.sql, ["users", "for no key update"]);
      saving = lower(e);
      await waitUntilBlockedOn(suite.sql, ["users", "for update"]);
    } finally {
      await blocker`commit`;
      blocker.release();
    }
    const key = await admitting;
    expect((await ledger(key))?.admitted_as).toBe("covered");
    expect((await saving).status).toBe(200);
    expect(await columns(e.userId)).toMatchObject({ monthly_operations: 100 });
  });
});
