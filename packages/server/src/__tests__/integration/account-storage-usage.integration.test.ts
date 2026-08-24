// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Account-level storage roll-up (#1826 §5.3) — real-PG integration.
 *
 * An account's storage usage is the RAW SUM over every studio it owns —
 * its personal studio ∪ every team studio it CURRENTLY administers. The
 * studio set mirrors `countTeamStudiosAdministeredBy` exactly (current
 * `admin` role, never the immutable `created_by`), so this is the auth /
 * data-integrity critical path (#6). Pins:
 *
 *   - `listTeamStudioIdsAdministeredBy` enumerates the SAME studios the
 *     count counts (its length === the count — one predicate, one truth);
 *   - it is scoped to current admin role: excludes personal studios,
 *     non-admin memberships, and soft-deleted studios/memberships;
 *   - `accountStorageUsage` = personal + every administered team studio,
 *     summed raw (cross-studio duplicates double-counted);
 *   - a transfer moves a studio's contribution from the old admin's
 *     account total to the new admin's (ownership follows the role).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import { initCore, loadLocales } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { accountStorageUsage } from "@server/modules/asset/assetUsage.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "account-usage-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user + their personal studio; returns both ids. */
async function insertUserWithPersonalStudio(): Promise<{
  userId: string;
  personalStudioId: string;
}> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`acct-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = rows[0]!.id;
  const st = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`acct-p-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  return { userId, personalStudioId: st[0]!.id };
}

/** A team studio whose current admin is `adminUserId`; returns its id. */
async function insertTeamStudioAdministeredBy(
  adminUserId: string,
  createdByUserId = adminUserId,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`acct-t-${seq++}`}, 'team', 'Team') RETURNING id
  `;
  const studioId = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${adminUserId}, 'admin')
  `;
  return studioId;
}

/** A 64-char hex string standing in for a sha256 content hash. */
function fakeHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * The studio's creator — used as the fixture asset's producer so the FK has
 * a real user without these tests (whose subject is storage roll-up, not
 * attribution-of-action) having to thread one through.
 * @param studioId - Studio whose creator to look up.
 * @returns The creator's user id.
 */
async function ownerOf(studioId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT created_by_user_id AS id FROM studios WHERE id = ${studioId}
  `;
  return rows[0]!.id;
}

/** Register one asset of `sizeBytes` into `studioId`. */
async function seedAsset(studioId: string, sizeBytes: number): Promise<void> {
  await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: await ownerOf(studioId),
    contentHash: fakeHash(),
    storageKey: `image/2026-07-25/${crypto.randomUUID()}.png`,
    fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
    sizeBytes,
    mimeType: "image/png",
    kind: "image",
    source: "upload",
  });
}

describe("studio repo — listTeamStudioIdsAdministeredBy", () => {
  it("returns the team studio ids the user currently administers", async () => {
    const { userId } = await insertUserWithPersonalStudio();
    const t1 = await insertTeamStudioAdministeredBy(userId);
    const t2 = await insertTeamStudioAdministeredBy(userId);
    const ids = await studioRepo.listTeamStudioIdsAdministeredBy(userId);
    expect(new Set(ids)).toEqual(new Set([t1, t2]));
  });

  it("excludes personal studios (only type='team')", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const ids = await studioRepo.listTeamStudioIdsAdministeredBy(userId);
    expect(ids).not.toContain(personalStudioId);
    expect(ids).toEqual([]);
  });

  it("excludes non-admin memberships", async () => {
    const admin = await insertUserWithPersonalStudio();
    const member = await insertUserWithPersonalStudio();
    const studioId = await insertTeamStudioAdministeredBy(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${member.userId}, 'member')
    `;
    expect(await studioRepo.listTeamStudioIdsAdministeredBy(member.userId)).toEqual([]);
  });

  it("excludes soft-deleted studios and soft-deleted memberships", async () => {
    const { userId } = await insertUserWithPersonalStudio();
    const deletedStudio = await insertTeamStudioAdministeredBy(userId);
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${deletedStudio}`;
    const revokedMembership = await insertTeamStudioAdministeredBy(userId);
    await sql`
      UPDATE studio_members SET deleted_at = now()
      WHERE studio_id = ${revokedMembership} AND user_id = ${userId}
    `;
    expect(await studioRepo.listTeamStudioIdsAdministeredBy(userId)).toEqual([]);
  });

  it("its length equals countTeamStudiosAdministeredBy (one predicate, one truth)", async () => {
    const { userId } = await insertUserWithPersonalStudio();
    await insertTeamStudioAdministeredBy(userId);
    await insertTeamStudioAdministeredBy(userId);
    await insertTeamStudioAdministeredBy(userId);
    const ids = await studioRepo.listTeamStudioIdsAdministeredBy(userId);
    const count = await studioRepo.countTeamStudiosAdministeredBy(userId);
    expect(ids.length).toBe(count);
    expect(count).toBe(3);
  });
});

describe("accountStorageUsage (#1826 §5.3 raw account roll-up)", () => {
  it("sums personal + every administered team studio", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const t1 = await insertTeamStudioAdministeredBy(userId);
    const t2 = await insertTeamStudioAdministeredBy(userId);
    await seedAsset(personalStudioId, 100);
    await seedAsset(t1, 30);
    await seedAsset(t2, 7);
    expect(await accountStorageUsage(userId)).toBe(137);
  });

  it("counts only administered team studios, not member-of ones", async () => {
    const admin = await insertUserWithPersonalStudio();
    const member = await insertUserWithPersonalStudio();
    const teamStudioId = await insertTeamStudioAdministeredBy(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${teamStudioId}, ${member.userId}, 'member')
    `;
    await seedAsset(teamStudioId, 500);
    await seedAsset(member.personalStudioId, 20);
    // The member's account sees only their own personal studio, not the team's.
    expect(await accountStorageUsage(member.userId)).toBe(20);
  });

  it("double-counts identical content held in two of the account's studios", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const teamStudioId = await insertTeamStudioAdministeredBy(userId);
    const sharedHash = fakeHash();
    const dup = async (studioId: string) =>
      assetRepo.registerWithDedup({
        studioId,
        producedByUserId: await ownerOf(studioId),
        contentHash: sharedHash,
        storageKey: `image/2026-07-25/${crypto.randomUUID()}.png`,
        fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
        sizeBytes: 64,
        mimeType: "image/png",
        kind: "image",
        source: "upload",
      });
    await dup(personalStudioId);
    await dup(teamStudioId);
    expect(await accountStorageUsage(userId)).toBe(128);
  });

  it("a transfer moves the studio's contribution to the NEW admin's account", async () => {
    const creator = await insertUserWithPersonalStudio();
    const recipient = await insertUserWithPersonalStudio();
    const teamStudioId = await insertTeamStudioAdministeredBy(creator.userId);
    await seedAsset(teamStudioId, 800);

    // Before transfer: creator's account includes the team studio.
    expect(await accountStorageUsage(creator.userId)).toBe(800);
    expect(await accountStorageUsage(recipient.userId)).toBe(0);

    // Transfer: revoke creator's admin row, grant recipient's (created_by unchanged).
    await sql`
      UPDATE studio_members SET deleted_at = now()
      WHERE studio_id = ${teamStudioId} AND user_id = ${creator.userId}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${teamStudioId}, ${recipient.userId}, 'admin')
    `;

    // After transfer: the 800 moves to the recipient; the creator drops to 0.
    expect(await accountStorageUsage(creator.userId)).toBe(0);
    expect(await accountStorageUsage(recipient.userId)).toBe(800);
  });

  it("an account with no personal studio and no team studios is 0", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`acct-bare-${seq++}@example.com`}, true) RETURNING id
    `;
    expect(await accountStorageUsage(rows[0]!.id)).toBe(0);
  });
});
