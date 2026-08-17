// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the membership panel reads (task #90) — real-PG.
 *
 * One service function answers the whole panel: which tier this account is
 * on, what that tier grants, how much of the two account-level allowances it
 * has spent, and the three tiers it could compare itself against. The panel
 * has no second request to fall back on, so every branch it can render has to
 * come out of this one call.
 *
 * The pins:
 *
 *   1. A configured tier yields its six ceilings and both usage numbers.
 *   2. `enterprise` yields `limits: null` rather than throwing. Its ceilings
 *      are negotiated per customer and have no source to read (#105 made
 *      `limitsFor` throw for exactly that reason) — but the account is a
 *      legal one the database accepts, so the panel must still render it.
 *      Letting the throw escape would turn that account's panel into a 500.
 *   3. The comparison table is base / pro / team, never four. `self_hosted`
 *      is a deployment shape and `enterprise` is negotiated; neither belongs
 *      on a price list, and returning them would leave the caller to filter
 *      by a rule written nowhere.
 *   4. Usage comes from the functions that already own those numbers, so the
 *      figure the panel shows and the figure a future upload gate enforces
 *      cannot drift apart.
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

import postgres from "postgres";
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";

import { readAccountMembership } from "@server/modules/account/membership.service";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "account-membership-test" },
  });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Creates an account on a given tier, with its personal studio.
 * @param tier - The tier to store on the account row.
 * @returns The account's id and its personal studio's id.
 * @throws {Error} if either insert fails.
 */
async function insertUser(
  tier: string,
): Promise<{ userId: string; personalStudioId: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`acct-mem-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = rows[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`acct-mem-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studios[0]!.id}, ${userId}, 'admin')
  `;
  return { userId, personalStudioId: studios[0]!.id };
}

/**
 * Creates a team studio administered by the given account.
 * @param adminUserId - The account that will administer it.
 * @returns The new studio's id.
 * @throws {Error} if either insert fails.
 */
async function insertTeamStudio(adminUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`acct-mem-t-${seq++}`}, 'team', 'Team')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${rows[0]!.id}, ${adminUserId}, 'admin')
  `;
  return rows[0]!.id;
}

/**
 * Stores one asset of a given size against a studio.
 * @param studioId - The studio the bytes are charged to.
 * @param sizeBytes - How many bytes to record.
 * @throws {Error} if the insert fails.
 */
async function insertAsset(studioId: string, sizeBytes: number): Promise<void> {
  await sql`
    INSERT INTO studio_assets
      (studio_id, produced_by_user_id, content_hash, storage_key,
       file_url, mime_type, kind, source, size_bytes)
    VALUES (
      ${studioId},
      (SELECT created_by_user_id FROM studios WHERE id = ${studioId}),
      ${`hash-${seq++}`},
      ${`key-${seq++}`},
      ${`https://example.test/${seq++}.png`},
      'image/png',
      'image',
      'upload',
      ${sizeBytes}
    )
  `;
}

describe("readAccountMembership", () => {
  it("returns the tier, its six ceilings, and both usage numbers", async () => {
    const { userId, personalStudioId } = await insertUser("pro");
    await insertAsset(personalStudioId, 1024);
    const team = await insertTeamStudio(userId);
    await insertAsset(team, 2048);

    const result = await readAccountMembership(userId);

    expect(result.tier).toBe("pro");
    expect(result.limits).toEqual(getMembershipLimits("pro"));
    expect(result.usage.teamStudios).toBe(1);
    expect(result.usage.storageBytes).toBe(3072);
  });

  it("gives enterprise accounts a null `limits` instead of throwing", async () => {
    // `limitsFor` throws for this tier on purpose (#105): its ceilings are
    // negotiated per customer, and inventing a set would hand the account a
    // number nobody agreed to. The panel still has to render, so the service
    // must reach that state without going through the throw.
    const { userId } = await insertUser("enterprise");

    const result = await readAccountMembership(userId);

    expect(result.tier).toBe("enterprise");
    expect(result.limits).toBeNull();
  });

  it("still reports usage for an enterprise account", async () => {
    // The ceilings are unknown; what the account has spent is not.
    const { userId, personalStudioId } = await insertUser("enterprise");
    await insertAsset(personalStudioId, 512);

    const result = await readAccountMembership(userId);

    expect(result.usage.storageBytes).toBe(512);
    expect(result.usage.teamStudios).toBe(0);
  });

  it("offers base, pro and team for comparison — never self_hosted", async () => {
    const { userId } = await insertUser("base");

    const result = await readAccountMembership(userId);

    expect(result.catalog.map((entry) => entry.tier)).toEqual([
      "base",
      "pro",
      "team",
    ]);
    for (const entry of result.catalog) {
      expect(entry.limits).toEqual(getMembershipLimits(entry.tier));
    }
  });

  it("offers the same three tiers to a self-hosted account", async () => {
    // The panel does not render the table for this tier (it is not on the
    // price list), but that is the panel's decision to make. The contract
    // stays one shape for every caller.
    const { userId } = await insertUser("self_hosted");

    const result = await readAccountMembership(userId);

    expect(result.tier).toBe("self_hosted");
    expect(result.limits).toEqual(getMembershipLimits("self_hosted"));
    expect(result.catalog.map((entry) => entry.tier)).toEqual([
      "base",
      "pro",
      "team",
    ]);
  });

  it("reports usage above the ceiling as it is, without complaint", async () => {
    // Ratified: ceilings are judged when an action happens, never applied
    // backwards to what already exists. An account can therefore sit above
    // its own limit, and the panel says so rather than hiding it.
    const { userId, personalStudioId } = await insertUser("base");
    const baseCeiling = getMembershipLimits("base").storage_bytes;
    await insertAsset(personalStudioId, baseCeiling + 1);

    const result = await readAccountMembership(userId);

    expect(result.usage.storageBytes).toBe(baseCeiling + 1);
    expect(result.limits?.storage_bytes).toBe(baseCeiling);
  });

  it("counts only team studios this account administers", async () => {
    // Membership of somebody else's team studio is not adminship, and the
    // ceiling this number is checked against belongs to the administrator.
    const owner = await insertUser("team");
    const other = await insertUser("base");
    const theirStudio = await insertTeamStudio(owner.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${theirStudio}, ${other.userId}, 'maintainer')
    `;

    const result = await readAccountMembership(other.userId);

    expect(result.usage.teamStudios).toBe(0);
  });
});
