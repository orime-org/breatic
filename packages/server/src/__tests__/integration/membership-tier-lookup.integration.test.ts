// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which tier governs a given account and a given studio (task #16) — real-PG.
 *
 * Two lookups, because the ratified rule has two halves. How many team
 * studios an account may administer is decided by that account's own tier.
 * Everything else a studio caps — projects, members, concurrent writable
 * connections, storage — is decided by the tier of that studio's CURRENT
 * admin. A studio has exactly one admin, so there is nothing to choose
 * between; and adminship transfers, which is what makes "current" the whole
 * point of this suite.
 *
 * The pins:
 *
 *   1. An account's tier is its own column.
 *   2. A personal studio resolves to its owner's tier — no special case, the
 *      owner simply is the admin.
 *   3. A team studio resolves to its admin's tier, and NOT to the tier of a
 *      non-admin member who happens to be richer or poorer.
 *   4. After a transfer the studio resolves to the NEW admin's tier. This is
 *      the one that makes ownership follow the role rather than the immutable
 *      `created_by_user_id` — a creator who hands a studio over stops paying
 *      for its ceilings, and the recipient starts.
 *   5. A studio with no live admin throws rather than falling back to a tier.
 *      That state is data corruption, and a silent fallback would let every
 *      quota on that studio be enforced against a number nobody chose.
 *
 * The last case in each of the two `…LimitsFor…` blocks below is about the
 * guard on the way OUT of the column, and #105 changed how they reach it. A
 * bad tier can no longer be written through the database, so they lift the
 * CHECK constraint for the length of one insert — which is not a trick to get
 * around the guard, it is the situation the guard exists for: a database that
 * was gone around (a direct connection, a restored backup, a deployment whose
 * migration did not run).
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
import { initCore, loadLocales } from "@breatic/core";
import {
  getUserMembershipTier,
  getStudioMembershipTier,
  getLimitsForUser,
  getLimitsForStudio,
  getProjectConcurrentEditorLimit,
  getMembershipLimits,
} from "@breatic/core";

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
    connection: { application_name: "membership-tier-lookup-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user on a given tier, plus their personal studio.
 * @param tier - The membership tier to stamp on the account.
 * @returns The user id and their personal studio id.
 */
async function insertUser(
  tier: string,
): Promise<{ userId: string; personalStudioId: string }> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`tier-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`tier-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  // A personal studio's owner is its admin, same as any other studio — the
  // resolution below has no personal-studio branch and must not need one.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${userId}, 'admin')
  `;
  return { userId, personalStudioId: st!.id };
}

/**
 * A team studio whose current admin is `adminUserId`.
 * @param adminUserId - Who administers it.
 * @returns The studio id.
 */
async function insertTeamStudio(adminUserId: string): Promise<string> {
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`tier-t-${seq++}`}, 'team', 'Team')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${adminUserId}, 'admin')
  `;
  return st!.id;
}

/**
 * A project inside a studio.
 * @param studioId - The studio that owns it.
 * @param createdBy - Whoever created it; not what decides the ceilings.
 * @returns The project id.
 */
async function insertProject(
  studioId: string,
  createdBy: string,
): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${createdBy}, 'Project', ${`tier-pr-${seq++}`})
    RETURNING id
  `;
  return p!.id;
}

/**
 * Run something with the tier CHECK constraint lifted, then put it back.
 *
 * The constraint is read back from the catalogue rather than retyped, so this
 * cannot drift from the migration and so the read itself proves the constraint
 * is there. It goes back as NOT VALID: the row the caller just wrote is still
 * in the table and a validated re-add would refuse it. New writes are checked
 * either way, which is what the sibling suite's rejection cases depend on.
 * @param fn - What to do while a bad value can be stored
 * @returns Whatever `fn` returned
 * @throws {Error} if the constraint is not on the table to begin with
 */
async function withTierCheckLifted<T>(fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = 'users_membership_tier_check'
  `;
  if (row === undefined) {
    throw new Error("users_membership_tier_check is not on the table");
  }
  await sql`ALTER TABLE users DROP CONSTRAINT users_membership_tier_check`;
  try {
    return await fn();
  } finally {
    await sql.unsafe(
      `ALTER TABLE users ADD CONSTRAINT users_membership_tier_check ${row.def} NOT VALID`,
    );
  }
}

/**
 * An account holding a tier this build does not know.
 * @param tier - The value to store, which the constraint would refuse
 * @returns The account id
 */
async function insertUserWithBadTier(tier: string): Promise<string> {
  return withTierCheckLifted(async () => {
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified, membership_tier)
      VALUES (${`tier-bad-${seq++}@example.test`}, true, ${tier})
      RETURNING id
    `;
    return u!.id;
  });
}

describe("getUserMembershipTier", () => {
  it("reads the account's own tier", async () => {
    const { userId } = await insertUser("pro");
    await expect(getUserMembershipTier(userId)).resolves.toBe("pro");
  });

  it("throws for an account that does not exist", async () => {
    await expect(
      getUserMembershipTier("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow();
  });
});

describe("getStudioMembershipTier", () => {
  it("resolves a personal studio to its owner's tier", async () => {
    const { personalStudioId } = await insertUser("team");
    await expect(getStudioMembershipTier(personalStudioId)).resolves.toBe("team");
  });

  it("resolves a team studio to its admin's tier", async () => {
    const { userId } = await insertUser("pro");
    const studioId = await insertTeamStudio(userId);
    await expect(getStudioMembershipTier(studioId)).resolves.toBe("pro");
  });

  it("ignores a non-admin member's tier", async () => {
    // The ceilings of a studio are paid for by whoever administers it. A
    // maintainer on a richer tier must not raise them, and one on a poorer
    // tier must not lower them.
    //
    // ON ITS OWN THIS CASE DOES NOT PIN THE `role = 'admin'` FILTER, and that
    // was measured, not assumed: deleting the filter from the query leaves
    // this green. The lookup takes one row with no ORDER BY, so without the
    // filter it returns whichever member the planner reaches first — here the
    // admin, who was inserted first. What this case really covers is the
    // ordinary shape (a studio with a mixed roster resolves to its admin).
    // The filter itself is pinned by the next case.
    const admin = await insertUser("base");
    const member = await insertUser("self_hosted");
    const studioId = await insertTeamStudio(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${member.userId}, 'maintainer')
    `;
    await expect(getStudioMembershipTier(studioId)).resolves.toBe("base");
  });

  it("refuses a studio whose only live member is not an admin", async () => {
    // This is the case that actually holds the `role = 'admin'` filter in
    // place, and it holds it without depending on row order: the admin
    // membership is gone, so the only row the query could possibly reach is
    // the maintainer's. With the filter, nothing matches and the corruption
    // surfaces; without it, the maintainer's tier would quietly become the
    // studio's ceilings.
    const admin = await insertUser("base");
    const member = await insertUser("self_hosted");
    const studioId = await insertTeamStudio(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${member.userId}, 'maintainer')
    `;
    await sql`
      UPDATE studio_members SET deleted_at = now()
      WHERE studio_id = ${studioId} AND user_id = ${admin.userId}
    `;
    await expect(getStudioMembershipTier(studioId)).rejects.toThrow();
  });

  it("follows a transfer to the new admin", async () => {
    // The load-bearing case. Ownership is the current `admin` row, never the
    // immutable `created_by_user_id` — so the studio's ceilings move with it.
    const from = await insertUser("team");
    const to = await insertUser("base");
    const studioId = await insertTeamStudio(from.userId);
    expect(await getStudioMembershipTier(studioId)).toBe("team");

    // Same two writes the transfer service makes: demote, then promote.
    await sql`
      UPDATE studio_members SET role = 'maintainer'
      WHERE studio_id = ${studioId} AND user_id = ${from.userId}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${to.userId}, 'admin')
    `;

    expect(await getStudioMembershipTier(studioId)).toBe("base");
  });

  it("ignores a soft-deleted admin membership", async () => {
    const admin = await insertUser("pro");
    const studioId = await insertTeamStudio(admin.userId);
    await sql`
      UPDATE studio_members SET deleted_at = now()
      WHERE studio_id = ${studioId} AND user_id = ${admin.userId}
    `;
    // No live admin left: corrupt, and a fallback tier would silently decide
    // every ceiling on this studio.
    await expect(getStudioMembershipTier(studioId)).rejects.toThrow();
  });

  it("throws for a studio that does not exist", async () => {
    await expect(
      getStudioMembershipTier("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow();
  });
});

/**
 * The two functions callers actually use. Everything above resolves a tier;
 * these turn a tier into the six numbers, and they are the only place that
 * conversion happens.
 *
 * Why it matters that there is exactly one such place: five ceilings already
 * go through these functions — team studios, projects per studio, the two
 * kinds of member cap, and since #88 the concurrent-connection one tested
 * below. Storage is the one still to come. Written as "look up
 * the tier, then index the config" at every one of them, the pair would end up
 * copied six to eight times — and the enterprise tier, whose ceilings are
 * negotiated per customer and will be read from the database, would then have
 * to be threaded through every copy. Miss one and that customer is quietly held to the
 * standard tier on that one path, with no error.
 */
describe("getLimitsForUser", () => {
  it("returns that account's own tier's six ceilings", async () => {
    const { userId } = await insertUser("pro");
    await expect(getLimitsForUser(userId)).resolves.toEqual(
      getMembershipLimits("pro"),
    );
  });

  it("names the account and the value when the column holds a tier we do not have", async () => {
    // What this pins is that the narrowing is still WIRED INTO this path.
    // `asKnownTier` has a unit test for the sentence it composes; taking the
    // call out of here would leave that test green while `getMembershipLimits`
    // returned undefined and the next property access threw a TypeError naming
    // neither the account nor the value — which is what used to happen.
    const userId = await insertUserWithBadTier("Pro");
    await expect(getLimitsForUser(userId)).rejects.toThrow(
      new RegExp(`${userId}[\\s\\S]*Pro|Pro[\\s\\S]*${userId}`),
    );
  });
});

describe("getLimitsForStudio", () => {
  it("returns the ceilings of the studio's current admin", async () => {
    const { userId } = await insertUser("team");
    const studioId = await insertTeamStudio(userId);
    await expect(getLimitsForStudio(studioId)).resolves.toEqual(
      getMembershipLimits("team"),
    );
  });

  it("follows a transfer, like the tier lookup it builds on", async () => {
    const from = await insertUser("team");
    const to = await insertUser("base");
    const studioId = await insertTeamStudio(from.userId);
    await sql`
      UPDATE studio_members SET role = 'maintainer'
      WHERE studio_id = ${studioId} AND user_id = ${from.userId}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${to.userId}, 'admin')
    `;
    await expect(getLimitsForStudio(studioId)).resolves.toEqual(
      getMembershipLimits("base"),
    );
  });

  it("names the studio, the ACCOUNT, and the value when the tier is not one we have", async () => {
    // The row an operator has to go fix is a `users` row, so the studio id on
    // its own does not finish the job — it is the thing they have in hand, not
    // the thing they must edit. This is the only case that holds the studio id
    // in that message: the narrowing composes the sentence, but WHICH ids
    // reach it is decided in `readStudioAdmin`, and collab's on-call notes
    // quote this exact sentence.
    const adminUserId = await insertUserWithBadTier("TEAM");
    const studioId = await insertTeamStudio(adminUserId);
    const err = await getLimitsForStudio(studioId).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "expected a throw").not.toBeNull();
    expect(err!.message).toContain(studioId);
    expect(err!.message).toContain(adminUserId);
    expect(err!.message).toContain("TEAM");
  });
});

/**
 * The collab handshake's entry point (#88).
 *
 * The per-document ceiling on writable connections belongs to the studio that
 * owns the project, so collab has one more hop than the other quota call
 * points: document name → project → studio → that studio's admin → tier.
 *
 * It goes through `getLimitsForStudio` rather than joining its own way to the
 * tier. That is not tidiness: those two functions are where the negotiated
 * enterprise tier will be read from the database, and a call point that walks
 * its own path would keep quietly answering from the config file after that
 * lands — with a number that looks perfectly valid.
 */
describe("getProjectConcurrentEditorLimit", () => {
  it("answers with the tier of the studio that owns the project", async () => {
    const { userId } = await insertUser("pro");
    const studioId = await insertTeamStudio(userId);
    const projectId = await insertProject(studioId, userId);
    await expect(getProjectConcurrentEditorLimit(projectId)).resolves.toBe(
      getMembershipLimits("pro").concurrent_editors,
    );
  });

  it("is not decided by whoever created the project", async () => {
    // A `base` member creating a project inside a `team` studio must not drag
    // the whole document down to their own ceiling — the studio pays for it.
    // `projects.created_by_user_id` is immutable and says nothing about who
    // pays today, which is exactly the trap the studio-level lookup avoids.
    const admin = await insertUser("team");
    const creator = await insertUser("base");
    const studioId = await insertTeamStudio(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${creator.userId}, 'maintainer')
    `;
    const projectId = await insertProject(studioId, creator.userId);
    await expect(getProjectConcurrentEditorLimit(projectId)).resolves.toBe(
      getMembershipLimits("team").concurrent_editors,
    );
  });

  it("follows a transfer of the studio to the new admin", async () => {
    // Same property the studio lookup has, restated at this entry point
    // because collab reaches the tier by its own route and could have picked
    // up the immutable creator instead somewhere along it.
    const from = await insertUser("team");
    const to = await insertUser("base");
    const studioId = await insertTeamStudio(from.userId);
    const projectId = await insertProject(studioId, from.userId);
    expect(await getProjectConcurrentEditorLimit(projectId)).toBe(
      getMembershipLimits("team").concurrent_editors,
    );

    await sql`
      UPDATE studio_members SET role = 'maintainer'
      WHERE studio_id = ${studioId} AND user_id = ${from.userId}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${to.userId}, 'admin')
    `;

    expect(await getProjectConcurrentEditorLimit(projectId)).toBe(
      getMembershipLimits("base").concurrent_editors,
    );
  });

  it("throws for a project that does not exist", async () => {
    await expect(
      getProjectConcurrentEditorLimit("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow();
  });

  it("throws for a soft-deleted project", async () => {
    // A deleted project has no live studio to bill, and answering with a
    // number would let a document that should be gone keep enforcing one.
    // The collab side turns any throw here into a read-only connection, so
    // this does not lock anybody out — it declines to invent a ceiling.
    const { userId } = await insertUser("pro");
    const studioId = await insertTeamStudio(userId);
    const projectId = await insertProject(studioId, userId);
    await sql`UPDATE projects SET deleted_at = now() WHERE id = ${projectId}`;
    await expect(
      getProjectConcurrentEditorLimit(projectId),
    ).rejects.toThrow();
  });

  it("names the project when it cannot be resolved", async () => {
    // The collab log carries this message verbatim; without the id in it, an
    // operator gets "some project somewhere has no studio".
    const missing = "00000000-0000-0000-0000-000000000000";
    const err = await getProjectConcurrentEditorLimit(missing).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "expected a throw").not.toBeNull();
    expect(err!.message).toContain(missing);
  });
});
