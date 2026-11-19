// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enterprise agreement terms (inner#1968, test spec area F: F-01 to F-06,
 * F-16 to F-19, F-21), through the signed internal app and the services
 * behind the account panel, against real Postgres.
 *
 * The agreement carries one optional limit, `running_tasks_per_user` (1 to
 * 30); a save that leaves it out keeps the value already agreed, or the column
 * default 10. An active agreement's `storage_bytes` caps storage; an
 * enterprise without an agreement stays unlimited.
 *
 * Placement: the spec puts F-21 at core integration; core has no integration
 * harness.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprint, runningTaskLimitForStudio } from "@breatic/core";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";
import { call, useInternalApp } from "./internal-api-harness.js";

const suite = useInternalApp("enterprise-agreement-terms");
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
  await suite.sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`et-${studioId}`}, 'team', 'Enterprise')`;
  await suite.sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await suite.sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`et-${projectId}`}, 'Enterprise')`;
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
 * The agreement's running-task column.
 * @param userId - The account.
 * @returns Its value.
 */
async function columns(userId: string): Promise<{ running_tasks_per_user: number } | undefined> {
  const [row] = await suite.sql<{ running_tasks_per_user: number }[]>`
    select running_tasks_per_user from enterprise_memberships where user_id = ${userId}`;
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

describe("enterprise agreement running-task term", () => {
  it("F-01 an agreement saved with running_tasks_per_user 20 stores and reads it", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, running_tasks_per_user: 20 });
    expect(await columns(e.userId)).toEqual({ running_tasks_per_user: 20 });
    const read = await call(suite.baseUrl, path(e.userId));
    expect(read.status).toBe(200);
    expect(read.json.snapshot.enterprise.limits).toMatchObject({ running_tasks_per_user: 20 });
  });

  it("F-02 a later save with only the six limits keeps 20", async () => {
    const e = await account();
    await agree(e.userId, { ...SIX, running_tasks_per_user: 20 });
    await agree(e.userId, SIX, { expectedRevision: 1, expectedStoredTier: "enterprise" });
    expect(await columns(e.userId)).toEqual({ running_tasks_per_user: 20 });
  });

  it("F-03 a first save with only the six limits stores 10", async () => {
    const e = await account();
    await agree(e.userId, SIX);
    expect(await columns(e.userId)).toEqual({ running_tasks_per_user: 10 });
  });

  it.each([
    { running_tasks_per_user: 0 },
    { running_tasks_per_user: 31 },
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
  ] as Record<string, number>[])("F-04 accepts %o", async (extra) => {
    const e = await account();
    await agree(e.userId, { ...SIX, ...extra });
    expect(await columns(e.userId)).toMatchObject(extra);
  });

  it("F-05 an operation result stored before running_tasks_per_user existed is replayed as stored", async () => {
    const e = await account();
    const requestKey = `bo-${randomUUID()}`;
    expect((await post(e.userId, SIX, {}, requestKey)).status).toBe(200);
    // What a result written before the migration holds: limits without the field.
    await suite.sql`update enterprise_membership_operations
      set result = result #- '{after,enterprise,limits,running_tasks_per_user}'
      where key = ${requestKey}`;
    const [stored] = await suite.sql<{ result: { after: { enterprise: { limits: Record<string, number> } } } }[]>`
      select result from enterprise_membership_operations where key = ${requestKey}`;
    const replay = await call(suite.baseUrl, `/internal/v1/enterprise-membership-operations/${requestKey}`);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(stored!.result);
    expect(replay.json.after.enterprise.limits).toEqual(SIX);
  });

  it("F-06 the same key with and without running_tasks_per_user is a different request", async () => {
    const e = await account();
    const withTerm = { targetTier: "enterprise", expiresAt: FUTURE, entryTimezone: "UTC", contractNumber: "ENT-F", limits: { ...SIX, running_tasks_per_user: 20 }, expectedRevision: null, expectedStoredTier: "pro" };
    const withoutTerm = { ...withTerm, limits: SIX };
    expect(fingerprint("POST", ROUTE, e.userId, withTerm)).not.toBe(fingerprint("POST", ROUTE, e.userId, withoutTerm));
    const requestKey = `bo-${randomUUID()}`;
    const first = await call(suite.baseUrl, path(e.userId), { body: withTerm, idempotencyKey: requestKey });
    expect(first.status).toBe(200);
    expect(first.json.status).toBe("applied");
    const second = await call(suite.baseUrl, path(e.userId), { body: withoutTerm, idempotencyKey: requestKey });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("idempotency_conflict");
  });
});

describe("enterprise storage cap and running-task limit", () => {
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
