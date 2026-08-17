// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Team studio creation (studio-team-create slice) — `createTeamStudio` against
 * a real Postgres. Creating a studio is the 数据完整性 critical path, so the
 * service-level invariants are pinned end-to-end:
 *
 *   - creates a `type='team'` studio + the creator's sole `admin`
 *     `studio_members` row, atomically (mirrors createPersonalStudio).
 *   - one user may create many team studios (not blocked by the
 *     one-personal-per-user partial index).
 *   - a duplicate slug loses the unique-index race → ConflictError (409).
 *   - the per-user team-studio limit is enforced and comes from the creator's
 *     MEMBERSHIP TIER (config/membership.yaml), not from a constant; the count
 *     is scoped to the creator's OWN active team studios.
 *
 * Every user here is created with an explicit tier, because the database
 * default is `base` and Base cannot create a team studio at all — a case
 * pinned below rather than worked around.
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
import type { ConfiguredMembershipTier } from "@breatic/shared";
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { studioService } from "@server/modules";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
// Without this, `t()` echoes the key back and every refusal message in this
// suite reads `server.studio.…` instead of a sentence. It went unnoticed while
// the cases only asserted status codes.
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "team-studio-create-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let userSeq = 0;
/**
 * Insert a user on a given tier; returns { id, email }.
 *
 * The tier is always explicit. The column defaults to `base`, whose
 * team-studio ceiling is 0, so a test that just wants "a user who can create
 * team studios" has to say which tier that is.
 * @param tier - Membership tier to stamp on the account (default `team`, the
 *   most generous of the priced three).
 * @returns The new user's id and email.
 */
async function insertUser(
  tier: ConfiguredMembershipTier = "team",
): Promise<{ id: string; email: string }> {
  const email = `tsc-${userSeq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${email}, true, ${tier}) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

/** That tier's team-studio ceiling, straight from the shipped config. */
function ceilingFor(tier: ConfiguredMembershipTier): number {
  return getMembershipLimits(tier).team_studios;
}

let slugSeq = 0;
/** A unique, well-formed studio slug (lowercase, 6–39 chars, SLUG_REGEX). */
function uniqueSlug(): string {
  return `tcs-${(slugSeq++).toString().padStart(6, "0")}`;
}

/** Seed N team studios administered by `userId` (studio + its admin member). */
async function seedTeamStudios(userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${uniqueSlug()}, 'team', 'Seed') RETURNING id
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${rows[0]!.id}, ${userId}, 'admin')
    `;
  }
}

describe("createTeamStudio", () => {
  it("creates a team studio with the creator as its sole admin, atomically", async () => {
    const user = await insertUser();
    const studio = await studioService.createTeamStudio(user.id, "My Team", uniqueSlug());

    expect(studio.type).toBe("team");
    expect(studio.name).toBe("My Team");
    expect(studio.createdByUserId).toBe(user.id);
    // creator is the studio admin
    expect(await studioMembersRepo.getRole(studio.id, user.id)).toBe("admin");
    // exactly one admin row exists for the studio
    const admins = await sql<{ user_id: string }[]>`
      SELECT user_id FROM studio_members
      WHERE studio_id = ${studio.id} AND role = 'admin' AND deleted_at IS NULL
    `;
    expect(admins).toHaveLength(1);
    expect(admins[0]!.user_id).toBe(user.id);
  });

  it("keeps name and slug independent (C 方案 — both hand-typed)", async () => {
    const user = await insertUser();
    const slug = uniqueSlug();
    const studio = await studioService.createTeamStudio(user.id, "Totally Different Name", slug);
    expect(studio.slug).toBe(slug);
    expect(studio.name).toBe("Totally Different Name");
  });

  it("lets one user create multiple team studios", async () => {
    const user = await insertUser();
    const a = await studioService.createTeamStudio(user.id, "A", uniqueSlug());
    const b = await studioService.createTeamStudio(user.id, "B", uniqueSlug());
    expect(a.id).not.toBe(b.id);
    expect(await studioMembersRepo.getRole(a.id, user.id)).toBe("admin");
    expect(await studioMembersRepo.getRole(b.id, user.id)).toBe("admin");
  });

  it("rejects a duplicate slug with Conflict (409)", async () => {
    const u1 = await insertUser();
    const u2 = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(u1.id, "First", slug);
    await expect(
      studioService.createTeamStudio(u2.id, "Second", slug),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("leaves no orphan studio row when the slug collides (atomic rollback)", async () => {
    const u1 = await insertUser();
    const u2 = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(u1.id, "First", slug);
    await expect(
      studioService.createTeamStudio(u2.id, "Second", slug),
    ).rejects.toMatchObject({ statusCode: 409 });
    // exactly one studio carries that slug — the failed attempt left nothing
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM studios WHERE slug = ${slug} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
  });

  it("rejects creating beyond the tier's team-studio ceiling", async () => {
    const user = await insertUser("pro");
    await seedTeamStudios(user.id, ceilingFor("pro"));
    await expect(
      studioService.createTeamStudio(user.id, "Over Limit", uniqueSlug()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows the last one under the ceiling (the test is >=, not >)", async () => {
    const user = await insertUser("pro");
    await seedTeamStudios(user.id, ceilingFor("pro") - 1);
    const studio = await studioService.createTeamStudio(user.id, "Last", uniqueSlug());
    expect(studio.type).toBe("team");
  });

  it("tells the person what their own tier allows, not a number from the catalog", async () => {
    // The refusal sentence used to carry the cap as literal text in all five
    // languages ("the limit of 50 team studios"). That was true while the cap
    // was a constant; the moment it became per-tier the sentence was wrong for
    // every tier at once. This pins that the number reaching the user is the
    // one actually enforced on them.
    // The whole sentence, not a substring of it. "contains the number 1" was
    // the first thing written here and it was useless: with the argument
    // missing, `t()` hands back the ICU template itself, and that template
    // contains a literal 1 inside its `one {…}` branch — so the weak assertion
    // passed under exactly the mutation it was meant to catch. Measured, not
    // reasoned: dropping `{ limit }` left the suite green.
    const user = await insertUser("pro");
    await seedTeamStudios(user.id, ceilingFor("pro"));
    await expect(
      studioService.createTeamStudio(user.id, "Over Limit", uniqueSlug()),
    ).rejects.toMatchObject({
      message: "Your plan allows 1 team studio. Upgrade to create more.",
    });
  });

  it("refuses a Base account outright — that tier's ceiling is zero", async () => {
    // Not an edge case dressed up as one: zero is an ordinary ceiling here and
    // `count >= 0` is true for a user with none, which is exactly the refusal
    // the tier is meant to produce. It is also the database default, so this
    // is what an account gets unless something says otherwise.
    const user = await insertUser("base");
    expect(ceilingFor("base")).toBe(0);
    await expect(
      studioService.createTeamStudio(user.id, "Not Allowed", uniqueSlug()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets the self-hosted tier past the widest priced tier's ceiling", async () => {
    // Acceptance item 6 asks for the FOURTH team studio specifically, and four
    // is the first count that means anything: `team`, the widest priced tier,
    // stops at three. Creating one proves nothing — every tier above base
    // allows that. Measured before this case existed: setting
    // `self_hosted.team_studios` to 0 in the shipped config, which would leave
    // every self-hosted install unable to create a single team studio, left
    // all 52 tests in this suite and the config suite green.
    //
    // It reads the ceiling from the config rather than asserting 9999, since
    // the number is a deployment's to choose; what is pinned is that it clears
    // the priced tiers.
    expect(ceilingFor("self_hosted")).toBeGreaterThan(ceilingFor("team"));
    const user = await insertUser("self_hosted");
    await seedTeamStudios(user.id, 3);
    const fourth = await studioService.createTeamStudio(user.id, "Fourth", uniqueSlug());
    expect(fourth.type).toBe("team");
  });

  it("counts only the studios the user administers toward the limit", async () => {
    const user = await insertUser();
    const other = await insertUser();
    await seedTeamStudios(other.id, ceilingFor("team")); // another user's full quota must not block
    const studio = await studioService.createTeamStudio(user.id, "Mine", uniqueSlug());
    expect(studio.type).toBe("team");
  });

  it("holds the ceiling when two creates run at once", async () => {
    // Counting rows and then inserting is not a decision under concurrency:
    // both transactions count, both see room, both insert. Measured before
    // the fix on a `pro` account (ceiling 1): three simultaneous requests left
    // two rows. It did not matter while the number was an internal cap of 50;
    // it matters now that it is what somebody paid for.
    //
    // The interleaving is observed, not hoped for. A separate connection holds
    // the account's row so the first create parks on it, the second is then
    // known to be queued behind the first, and only then is the gate released.
    // Written with `Promise.all` instead, this test passes with the lock
    // deleted — the two short transactions reuse one pooled connection and run
    // one after the other, so nothing ever interleaves.
    const user = await insertUser("pro");
    expect(ceilingFor("pro")).toBe(1);

    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let first: Promise<unknown>;
    let second: Promise<unknown>;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;

        first = studioService.createTeamStudio(user.id, "A", uniqueSlug());
        await waitUntilBlockedOn(sql, ["users", "for update"], 1);
        second = studioService.createTeamStudio(user.id, "B", uniqueSlug());
        await waitUntilBlockedOn(sql, ["users", "for update"], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }

    const results = await Promise.allSettled([first!, second!]);
    const created = results.filter((r) => r.status === "fulfilled").length;
    expect(created).toBe(1);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM studios s
      JOIN studio_members m ON m.studio_id = s.id
      WHERE m.user_id = ${user.id} AND m.role = 'admin' AND m.deleted_at IS NULL
        AND s.type = 'team' AND s.deleted_at IS NULL
    `;
    expect(rows[0]!.n).toBe("1");
  });

  it("counts by current admin role, not the immutable created_by (transfer frees quota)", async () => {
    const creator = await insertUser();
    const recipient = await insertUser();
    // A team studio created by `creator` but now administered by `recipient`
    // (mirrors a post-transfer state: created_by unchanged, the admin row moved).
    const rows = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${creator.id}, ${uniqueSlug()}, 'team', 'Transferred') RETURNING id
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${rows[0]!.id}, ${recipient.id}, 'admin')
    `;
    // The transferred studio already counts toward the recipient, so seed one
    // fewer to put them exactly at their ceiling.
    await seedTeamStudios(recipient.id, ceilingFor("team") - 1);
    // The creator administers 0 (created_by no longer counts) → can still create.
    const fresh = await studioService.createTeamStudio(creator.id, "Fresh", uniqueSlug());
    expect(fresh.type).toBe("team");
    // The recipient is at their ceiling → blocked.
    await expect(
      studioService.createTeamStudio(recipient.id, "Over", uniqueSlug()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("checkStudioSlug", () => {
  it("returns available for a fresh, well-formed slug", async () => {
    expect(await studioService.checkStudioSlug(uniqueSlug())).toEqual({
      available: true,
    });
  });

  it("returns taken for an existing studio slug", async () => {
    const user = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(user.id, "X", slug);
    expect(await studioService.checkStudioSlug(slug)).toEqual({
      available: false,
      reason: "taken",
    });
  });

  it("returns format for a malformed slug", async () => {
    expect(await studioService.checkStudioSlug("Bad Slug!")).toEqual({
      available: false,
      reason: "format",
    });
  });

  it("returns length for a too-short (but well-formed) slug", async () => {
    expect(await studioService.checkStudioSlug("abc")).toEqual({
      available: false,
      reason: "length",
    });
  });
});
