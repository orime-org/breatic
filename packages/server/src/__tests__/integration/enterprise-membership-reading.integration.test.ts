// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db, initCore, getHonouredTierForUser, getEnterpriseMembershipProfile, getMembershipReadingForUser, getMembershipForUser, getLimitsForStudio, getStudioStorageQuota, getMembershipLimits, getMembershipConfig, lockLimitsForUser } from "@breatic/core";
import { tierLimitsSchema } from "@breatic/shared";
import { waitUntilBlockedOn } from "./lock-probe.js";

let sql: ReturnType<typeof postgres>;
const limits = { team_studios: 8, projects_per_studio: 20, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 };

/** Insert a live account and the studio it currently administers.
 * @param tier - Its raw membership tier.
 * @returns Both identifiers.
 */
async function account(tier: string): Promise<{ userId: string; studioId: string }> {
  const userId = randomUUID();
  const studioId = randomUUID();
  await sql`insert into users(id,email,membership_tier) values(${userId},${`${userId}@example.test`},${tier})`;
  await sql`insert into studios(id,created_by_user_id,slug,name,type) values(${studioId},${userId},${studioId},'Enterprise test','team')`;
  await sql`insert into studio_members(studio_id,user_id,role) values(${studioId},${userId},'admin')`;
  return { userId, studioId };
}

/** Insert the negotiated record read by every quota path.
 * @param userId - The account.
 * @param expiresAt - Its exclusive deadline.
 * @param fallback - Its origin.
 */
async function enterprise(userId: string, expiresAt: string, fallback = "base"): Promise<void> {
  await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision)
    values(${userId},${expiresAt},'UTC','TEST-ENT-29',8,20,30,200,80,1099511627776,${fallback},1)`;
}

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 4 });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

describe("enterprise membership unified reads", () => {
  it.each(["0001", "0013", "0049", "0050", "0099", "0100", "0999", "1000", "2026"])("preserves year %s in enterprise timestamps and expired account and Studio entitlements", async (year) => {
    const { userId, studioId } = await account("enterprise");
    const timestamps = {
      expiresAt: `${year}-01-02T00:00:00.000Z`,
      createdAt: `${year}-01-01T01:02:03.004Z`,
      updatedAt: `${year}-01-01T05:06:07.008Z`,
    };
    // Bind ISO strings and project SQL text so neither seed nor oracle uses a Date parser.
    await enterprise(userId, timestamps.expiresAt);
    await sql`update enterprise_memberships set created_at=${timestamps.createdAt}::timestamptz,updated_at=${timestamps.updatedAt}::timestamptz where user_id=${userId}`;
    const [stored] = await sql<{ expiresAt: string; createdAt: string; updatedAt: string }[]>`
      select to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
        to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
      from enterprise_memberships where user_id=${userId}`;
    expect(stored).toEqual(timestamps);
    const configured = getMembershipLimits("base");
    expect(await getMembershipReadingForUser(userId)).toMatchObject({ storedTier: "enterprise", effectiveTier: "base", enterpriseState: "expired", expiresAt: timestamps.expiresAt, limits: configured, storageBytes: configured.storage_bytes, revision: 1, settlementProtected: false });
    expect(await getEnterpriseMembershipProfile(userId)).toMatchObject({ snapshot: { enterprise: { ...timestamps, entryTimezone: "UTC", revision: 1 } } });
    expect(await getHonouredTierForUser(userId)).toBe("base");
    expect(await getMembershipForUser(userId)).toEqual({ tier: "base", limits: configured });
    expect(await getLimitsForStudio(studioId)).toEqual(configured);
    expect(await db.transaction((tx) => lockLimitsForUser(userId, tx))).toEqual(configured);
    expect(await getStudioStorageQuota(studioId)).toEqual({ adminUserId: userId, storageBytes: configured.storage_bytes });
  });

  it("reads ordinary account and Studio entitlements with database-valid non-RFC identities", async () => {
    const userId = `00000000-0000-0000-0000-${randomUUID().slice(-12)}`;
    const studioId = `00000000-0000-0000-0000-${randomUUID().slice(-12)}`;
    await sql`insert into users(id,email,membership_tier) values(${userId},${`${userId}@example.test`},'pro')`;
    await sql`insert into studios(id,created_by_user_id,slug,name,type) values(${studioId},${userId},${studioId},'Legacy identity test','team')`;
    await sql`insert into studio_members(studio_id,user_id,role) values(${studioId},${userId},'admin')`;
    const configured = getMembershipLimits("pro");
    expect(await getMembershipReadingForUser(userId)).toMatchObject({ subject: { accountId: userId }, storedTier: "pro", effectiveTier: "pro", limits: configured, enterpriseState: "ordinary", revision: null, expiresAt: null, settlementProtected: false });
    expect(await getHonouredTierForUser(userId)).toBe("pro");
    expect(await getLimitsForStudio(studioId)).toEqual(configured);
    expect(await db.transaction((tx) => lockLimitsForUser(userId, tx))).toEqual(configured);
    expect(await getStudioStorageQuota(studioId)).toEqual({ adminUserId: userId, storageBytes: configured.storage_bytes });
  });

  it("does not impose management mailbox validation on ordinary entitlements", async () => {
    const { userId, studioId } = await account("pro");
    await sql`update users set email=${`legacy-mailbox-${userId}`} where id=${userId}`;
    expect(await getMembershipForUser(userId)).toEqual({ tier: "pro", limits: getMembershipLimits("pro") });
    expect(await getLimitsForStudio(studioId)).toEqual(getMembershipLimits("pro"));
  });

  it.each([
    ["self_hosted", "self_hosted", "ordinary"],
    ["enterprise", "self_hosted", "expired"],
    ["enterprise", "base", "expired"],
  ] as const)("reads configured safe-integer limits from %s through %s as %s", async (storedTier, effectiveTier, enterpriseState) => {
    const config = getMembershipConfig();
    const original = config.tiers[effectiveTier];
    const configured = tierLimitsSchema.parse({ team_studios: 2147483648, projects_per_studio: 2147483648, concurrent_editors: 2147483648, studio_members: 2147483648, project_members: 2147483648, storage_bytes: Number.MAX_SAFE_INTEGER });
    const { userId, studioId } = await account(storedTier);
    if (storedTier === "enterprise") await enterprise(userId, "2000-01-01T00:00:00Z", effectiveTier);
    config.tiers[effectiveTier] = configured;
    try {
      expect(await getMembershipReadingForUser(userId)).toMatchObject({ storedTier, effectiveTier, enterpriseState, limits: configured, storageBytes: configured.storage_bytes, settlementProtected: effectiveTier === "self_hosted" });
      expect(await getMembershipForUser(userId)).toEqual({ tier: effectiveTier, limits: configured });
      expect(await getLimitsForStudio(studioId)).toEqual(configured);
      expect(await db.transaction((tx) => lockLimitsForUser(userId, tx))).toEqual(configured);
      expect(await getStudioStorageQuota(studioId)).toEqual({ adminUserId: userId, storageBytes: configured.storage_bytes });
    } finally {
      config.tiers[effectiveTier] = original;
    }
  });

  it("rejects malformed stored enterprise facts in account and Studio reads", async () => {
    const { userId, studioId } = await account("enterprise");
    await enterprise(userId, "2070-01-01T00:00:00Z");
    // The database accepts a textual zone; membership reads must validate its meaning.
    await sql`update enterprise_memberships set entry_timezone='No/Such_Zone' where user_id=${userId}`;
    const invalidZone = { issues: expect.arrayContaining([expect.objectContaining({ path: ["entryTimezone"], code: "custom" })]) };
    await expect(getMembershipReadingForUser(userId)).rejects.toMatchObject(invalidZone);
    await expect(getLimitsForStudio(studioId)).rejects.toMatchObject(invalidZone);
    await expect(db.transaction((tx) => lockLimitsForUser(userId, tx))).rejects.toMatchObject(invalidZone);
  });

  it.each(["missing", "deleted"])("refuses a %s membership subject", async (state) => {
    const userId = state === "missing" ? randomUUID() : (await account("pro")).userId;
    if (state === "deleted") await sql`update users set deleted_at=now() where id=${userId}`;
    await expect(getMembershipReadingForUser(userId)).rejects.toThrow(`No live account ${userId}`);
  });
  it("reads all negotiated limits while retaining the enterprise display and storage rules", async () => {
    const { userId, studioId } = await account("enterprise");
    await enterprise(userId, "2070-01-01T00:00:00Z");
    expect(await getHonouredTierForUser(userId)).toBe("enterprise");
    expect(await getLimitsForStudio(studioId)).toEqual(limits);
    expect(await db.transaction((tx) => lockLimitsForUser(userId, tx))).toEqual(limits);
    expect(await getMembershipForUser(userId)).toEqual({ tier: "enterprise", limits: null });
    expect(await getStudioStorageQuota(studioId)).toEqual({ adminUserId: userId, storageBytes: null });
  });
  it.each(["base", "self_hosted"])("restores expired %s origin", async (fallback) => {
    const { userId, studioId } = await account("enterprise");
    await enterprise(userId, "2000-01-01T00:00:00Z", fallback);
    expect(await getHonouredTierForUser(userId)).toBe(fallback);
    expect(await getLimitsForStudio(studioId)).toEqual(getMembershipLimits(fallback as "base" | "self_hosted"));
  });
  it("keeps the ordinary raw tier after an enterprise record becomes historical", async () => {
    const { userId, studioId } = await account("pro");
    await enterprise(userId, "2070-01-01T00:00:00Z", "self_hosted");
    expect(await getHonouredTierForUser(userId)).toBe("pro");
    expect(await getLimitsForStudio(studioId)).toEqual(getMembershipLimits("pro"));
  });
  it("selects paid facts among multiple subscriptions and filters soft-deleted facts", async () => {
    const { userId, studioId } = await account("enterprise");
    await enterprise(userId, "2000-01-01T00:00:00Z");
    await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end,cancel_at_period_end,deleted_at) values
      (${userId},${`sub-pro-${randomUUID()}`},'pro','month','active','2070-01-01',true,null),
      (${userId},${`sub-unpaid-team-${randomUUID()}`},'team','year','incomplete',null,false,null),
      (${userId},${`sub-old-team-${randomUUID()}`},'team','year','active','2000-01-01',true,null),
      (${userId},${`sub-deleted-team-${randomUUID()}`},'team','year','active','2070-01-01',true,now())`;
    expect(await getHonouredTierForUser(userId)).toBe("pro");
    expect(await getLimitsForStudio(studioId)).toEqual(getMembershipLimits("pro"));
    expect(await db.transaction((tx) => lockLimitsForUser(userId, tx))).toEqual(getMembershipLimits("pro"));
  });
  it("uses the current Studio admin and retains legacy missing-record behavior", async () => {
    const from = await account("enterprise");
    const to = await account("pro");
    await enterprise(from.userId, "2070-01-01T00:00:00Z");
    await sql`update studio_members set role='maintainer' where studio_id=${from.studioId} and user_id=${from.userId}`;
    await sql`insert into studio_members(studio_id,user_id,role) values(${from.studioId},${to.userId},'admin')`;
    expect(await getLimitsForStudio(from.studioId)).toEqual(getMembershipLimits("pro"));
    const legacy = await account("enterprise");
    expect(await getHonouredTierForUser(legacy.userId)).toBe("enterprise");
    await expect(getLimitsForStudio(legacy.studioId)).rejects.toThrow(/enterprise tier/);
    expect((await getStudioStorageQuota(legacy.studioId)).storageBytes).toBeNull();
  });
  it("takes the account lock before reading a concurrently replaced enterprise record", async () => {
    const { userId } = await account("enterprise");
    await enterprise(userId, "2070-01-01T00:00:00Z");
    let result: Promise<unknown> | undefined;
    await sql.begin(async (gate) => {
      await gate`select id from users where id=${userId} for update`;
      result = db.transaction((tx) => lockLimitsForUser(userId, tx));
      await waitUntilBlockedOn(sql, ["users", "for update"]);
      await gate`update enterprise_memberships set expires_at='2000-01-01',projects_per_studio=999,revision=2 where user_id=${userId}`;
    });
    expect(await result).toEqual(getMembershipLimits("base"));
  });
  it("enforces negotiated integer and contract constraints in PostgreSQL", async () => {
    const { userId } = await account("enterprise");
    await enterprise(userId, "2070-01-01T00:00:00Z");
    await expect(sql`update enterprise_memberships set team_studios=-1 where user_id=${userId}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update enterprise_memberships set contract_number='' where user_id=${userId}`).rejects.toMatchObject({ code: "23514" });
  });
});
