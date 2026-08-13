// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How many members a studio may hold, and how many collaborators a project may
 * hold (task #87, membership block three) — real Postgres.
 *
 * Both ceilings come from `config/membership.yaml`, keyed by the tier of the
 * governing studio's CURRENT admin — for a project, that is the admin of the
 * studio the project lives in, not the project's own owner.
 *
 * Each cap has TWO check points and they are not the same kind of thing:
 *
 *   - **invite time** is an early hint, outside any transaction. It exists so
 *     an admin learns there is no room before an email goes out.
 *   - **accept time** is the real gate. The studio may fill up between sending
 *     and accepting, so this one runs inside the confirm transaction, behind a
 *     row lock on the entity being counted.
 *
 * Three things this suite pins that a unit test cannot:
 *
 *   1. **The ceiling survives concurrency.** Counting rows and then inserting
 *      is not a decision when two confirms do it at once — both count, both see
 *      room, both insert. Block one measured this shape on a `pro` account:
 *      three simultaneous requests left two rows behind.
 *   2. **The two readers get different sentences.** The invitee cannot raise
 *      anyone's tier, so the accept-side refusal must not tell them to upgrade.
 *   3. **A confirm cannot land a live member row on a dead entity.** The
 *      entity may be soft-deleted between sending and accepting.
 *
 * The concurrency cases hold a row lock from a separate connection so the
 * interleaving is observed rather than hoped for. Written with `Promise.all`
 * they would pass with the lock deleted, because two short transactions reuse
 * one pooled connection and simply run one after the other.
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
import type { MembershipTier } from "@breatic/shared";
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
// Without this every refusal below reads `server.studio.…` instead of a
// sentence, and the copy cases would be asserting the key, not the copy.
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "member-quota-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** That tier's studio-member ceiling, straight from the shipped config. */
function studioCeiling(tier: MembershipTier): number {
  return getMembershipLimits(tier).studio_members;
}

/** That tier's project-collaborator ceiling, straight from the shipped config. */
function projectCeiling(tier: MembershipTier): number {
  return getMembershipLimits(tier).project_members;
}

/**
 * An account on a given tier.
 * @param tier - Membership tier stamped on the account.
 * @returns The new user's id and email.
 */
async function insertUser(
  tier: MembershipTier,
): Promise<{ id: string; email: string }> {
  const email = `mq-${seq++}@example.test`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${email}, true, ${tier}) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

/**
 * A team studio whose current admin is `adminUserId`.
 * @param adminUserId - Who administers it, and therefore whose tier decides
 *   this studio's ceilings.
 * @returns The studio's id and slug.
 */
async function insertStudio(
  adminUserId: string,
): Promise<{ id: string; slug: string }> {
  const slug = `mq-s-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, 'team', 'Studio') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${id}, ${adminUserId}, 'admin')
  `;
  return { id, slug };
}

/**
 * Fill a studio with `n` extra members without going through the service.
 *
 * Seeding by SQL is deliberate: these cases are about the gate, and a seeder
 * that itself passed through the gate could not set up the at-the-ceiling state
 * the gate is supposed to refuse.
 * @param studioId - Studio to fill.
 * @param n - How many members to add on top of the admin.
 */
async function seedStudioMembers(studioId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const u = await insertUser("base");
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studioId}, ${u.id}, 'guest')
    `;
  }
}

/**
 * A project in a studio, owned by `ownerUserId`.
 * @param studioId - Studio it lives in.
 * @param ownerUserId - Becomes the owner row (`added_by` null, as the service
 *   writes it).
 * @returns The project id.
 */
async function insertProject(
  studioId: string,
  ownerUserId: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${ownerUserId}, 'Project', ${`mq-p-${seq++}`})
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${id}, ${ownerUserId}, 'owner')
  `;
  return id;
}

/**
 * Fill a project with `n` explicitly-invited members.
 * @param projectId - Project to fill.
 * @param addedBy - Stamped as `added_by`; what makes these count.
 * @param n - How many to add.
 */
async function seedProjectMembers(
  projectId: string,
  addedBy: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const u = await insertUser("base");
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${u.id}, 'viewer', ${addedBy})
    `;
  }
}

/**
 * Send a studio invite and hand back the invitation id.
 * @param slug - The studio's slug.
 * @param inviterUserId - Who is inviting.
 * @param email - The invitee's registered email.
 * @returns The invitation id.
 */
async function inviteToStudio(
  slug: string,
  inviterUserId: string,
  email: string,
): Promise<string> {
  const r = await studioInviteService.createInvite(
    slug,
    inviterUserId,
    email,
    "guest",
  );
  return r.invitationId;
}

/**
 * Send a project invite and hand back the invitation id.
 * @param projectId - The project.
 * @param inviterUserId - Who is inviting.
 * @param email - The invitee's registered email.
 * @returns The invitation id.
 */
async function inviteToProject(
  projectId: string,
  inviterUserId: string,
  email: string,
): Promise<string> {
  const r = await projectInviteService.createInvite(
    projectId,
    inviterUserId,
    email,
    "viewer",
  );
  return r.invitationId;
}

describe("studio member cap — invite time (the early hint)", () => {
  it("refuses once the studio is at its admin's ceiling", async () => {
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    // The admin's own row counts, so one short of the ceiling fills it.
    await seedStudioMembers(studio.id, studioCeiling("pro") - 1);
    const invitee = await insertUser("base");

    await expect(
      inviteToStudio(studio.slug, admin.id, invitee.email),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows the last seat under the ceiling (the test is >=, not >)", async () => {
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    await seedStudioMembers(studio.id, studioCeiling("pro") - 2);
    const invitee = await insertUser("base");

    await expect(
      inviteToStudio(studio.slug, admin.id, invitee.email),
    ).resolves.toBeTruthy();
  });

  it("reads the ceiling from the studio's admin, not from the inviter", async () => {
    // The load-bearing case for "capacity belongs to whoever administers the
    // studio". A maintainer on the narrowest tier inviting into a studio run by
    // a wider account must get the WIDE ceiling.
    const admin = await insertUser("pro");
    const maintainer = await insertUser("base");
    const studio = await insertStudio(admin.id);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studio.id}, ${maintainer.id}, 'maintainer')
    `;
    // Past base's ceiling, well under pro's.
    await seedStudioMembers(studio.id, studioCeiling("base"));
    expect(studioCeiling("pro")).toBeGreaterThan(studioCeiling("base"));
    const invitee = await insertUser("base");

    await expect(
      inviteToStudio(studio.slug, maintainer.id, invitee.email),
    ).resolves.toBeTruthy();
  });

  it("names this tier's number and points at the upgrade path", async () => {
    // A different tier's number in the sentence would show a hard-coded one.
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    await seedStudioMembers(studio.id, studioCeiling("pro") - 1);
    const invitee = await insertUser("base");
    expect(studioCeiling("pro")).not.toBe(studioCeiling("base"));

    await expect(
      inviteToStudio(studio.slug, admin.id, invitee.email),
    ).rejects.toMatchObject({
      message: "This studio's plan allows up to 10 members. Upgrade to add more.",
    });
  });

  it("says a DIFFERENT tier's number, so a hard-coded one shows", async () => {
    // The case above alone cannot tell `{ limit: memberLimit }` from
    // `{ limit: 10 }`. This one is the other half of that pair: on `base` the
    // ceiling is a single seat — the admin's own — which also exercises the
    // ICU `one` branch rather than `other`.
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const invitee = await insertUser("base");
    expect(studioCeiling("base")).toBe(1);

    await expect(
      inviteToStudio(studio.slug, admin.id, invitee.email),
    ).rejects.toMatchObject({
      message: "This studio's plan allows 1 member. Upgrade to add more.",
    });
  });
});

describe("studio member cap — accept time (the real gate)", () => {
  it("refuses a confirm when the studio filled up after the invite went out", async () => {
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    await seedStudioMembers(studio.id, studioCeiling("pro") - 2);
    const invitee = await insertUser("base");
    const invitation = await inviteToStudio(studio.slug, admin.id, invitee.email);

    // Somebody else took the last seat while this invite sat in the bell.
    await seedStudioMembers(studio.id, 1);

    await expect(
      studioInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The refusal is thrown inside the transaction, so the accept CAS rolls
    // back with it: the invite is still there to accept once somebody leaves.
    // Burning it would leave the invitee with a dead bell entry and no way
    // back in even after room opens up.
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM studio_invitations WHERE id = ${invitation}
    `;
    expect(rows[0]!.status).toBe("pending");
  });

  it("tells the invitee to ask an admin, and never tells them to upgrade", async () => {
    // The invitee holds neither the tier nor any way to raise it, so the
    // invite-time sentence would be an instruction they cannot act on.
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    await seedStudioMembers(studio.id, studioCeiling("pro") - 2);
    const invitee = await insertUser("base");
    const invitation = await inviteToStudio(studio.slug, admin.id, invitee.email);
    await seedStudioMembers(studio.id, 1);

    await expect(
      studioInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({
      message: "This studio is full. Ask its Admin to make room.",
    });
  });

  it("refuses a confirm once the studio itself has been soft-deleted", async () => {
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    const invitee = await insertUser("base");
    const invitation = await inviteToStudio(studio.slug, admin.id, invitee.email);

    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${studio.id}`;

    await expect(
      studioInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM studio_members
      WHERE studio_id = ${studio.id} AND user_id = ${invitee.id}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("project collaborator cap — invite time (the early hint)", () => {
  it("refuses once the project is at the ceiling", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("base"));
    const invitee = await insertUser("base");

    await expect(
      inviteToProject(project, admin.id, invitee.email),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reads the ceiling from the studio's admin, not the project's owner", async () => {
    // The project's owner may be on any tier; what is paid for is the studio.
    const admin = await insertUser("pro");
    const owner = await insertUser("base");
    const studio = await insertStudio(admin.id);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studio.id}, ${owner.id}, 'maintainer')
    `;
    const project = await insertProject(studio.id, owner.id);
    await seedProjectMembers(project, owner.id, projectCeiling("base"));
    expect(projectCeiling("pro")).toBeGreaterThan(projectCeiling("base"));
    const invitee = await insertUser("base");

    await expect(
      inviteToProject(project, owner.id, invitee.email),
    ).resolves.toBeTruthy();
  });

  it("counts neither the owner nor auto-materialised baseline viewers", async () => {
    // Both carry `added_by IS NULL`. Counting them would fill any project in a
    // large studio the moment people opened it.
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    for (let i = 0; i < 3; i++) {
      const lurker = await insertUser("base");
      await sql`
        INSERT INTO project_members (project_id, user_id, role)
        VALUES (${project}, ${lurker.id}, 'viewer')
      `;
    }
    await seedProjectMembers(project, admin.id, projectCeiling("base") - 1);
    const invitee = await insertUser("base");

    await expect(
      inviteToProject(project, admin.id, invitee.email),
    ).resolves.toBeTruthy();
  });

  it("names this tier's number without claiming it is the reader's plan", async () => {
    // The inviter can be the project's owner or a maintainer rather than the
    // studio's admin, so the sentence talks about the project, not "your plan".
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("base"));
    const invitee = await insertUser("base");
    expect(projectCeiling("base")).not.toBe(projectCeiling("pro"));

    await expect(
      inviteToProject(project, admin.id, invitee.email),
    ).rejects.toMatchObject({
      message: "This project allows up to 4 collaborators. Upgrade to add more.",
    });
  });

  it("says a DIFFERENT tier's number, so a hard-coded one shows", async () => {
    // The other half of the pair, for the same reason as the studio side: one
    // tier alone cannot tell the configured number from a literal.
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("pro"));
    const invitee = await insertUser("base");
    expect(projectCeiling("pro")).not.toBe(projectCeiling("base"));

    await expect(
      inviteToProject(project, admin.id, invitee.email),
    ).rejects.toMatchObject({
      message: "This project allows up to 12 collaborators. Upgrade to add more.",
    });
  });
});

describe("project collaborator cap — accept time (the real gate)", () => {
  it("refuses a confirm when the project filled up after the invite went out", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("base") - 1);
    const invitee = await insertUser("base");
    const invitation = await inviteToProject(project, admin.id, invitee.email);

    await seedProjectMembers(project, admin.id, 1);

    await expect(
      projectInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Same as the studio side: the accept CAS rolls back with the refusal, so
    // the invite survives to be accepted once a seat frees up.
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM project_invitations WHERE id = ${invitation}
    `;
    expect(rows[0]!.status).toBe("pending");
  });

  it("tells the invitee to ask the owner, and never tells them to upgrade", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("base") - 1);
    const invitee = await insertUser("base");
    const invitation = await inviteToProject(project, admin.id, invitee.email);
    await seedProjectMembers(project, admin.id, 1);

    await expect(
      projectInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({
      message: "This project is full. Ask its Owner to make room.",
    });
  });

  it("refuses a confirm once the project itself has been soft-deleted", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    const invitee = await insertUser("base");
    const invitation = await inviteToProject(project, admin.id, invitee.email);

    await sql`UPDATE projects SET deleted_at = now() WHERE id = ${project}`;

    await expect(
      projectInviteService.confirmInvite(invitation, invitee.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_members
      WHERE project_id = ${project} AND user_id = ${invitee.id}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("member caps under concurrency", () => {
  /**
   * Park both confirms behind a lock on one row, then release and settle.
   * @param table - `studios` or `projects`; the row both calls must queue on.
   * @param rowId - Which row.
   * @param first - The first confirm, started while the gate is held.
   * @param second - The second confirm, started once the first is known parked.
   * @returns How many of the two succeeded.
   */
  async function raceOnRow(
    table: "studios" | "projects",
    rowId: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<number> {
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let a: Promise<unknown>;
    let b: Promise<unknown>;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM ${g(table)} WHERE id = ${rowId} FOR UPDATE`;
        a = first();
        await waitUntilBlockedOn(sql, [table, "for update"], 1);
        b = second();
        await waitUntilBlockedOn(sql, [table, "for update"], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const results = await Promise.allSettled([a!, b!]);
    return results.filter((r) => r.status === "fulfilled").length;
  }

  it("lets only one of two simultaneous studio confirms take the last seat", async () => {
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin.id);
    await seedStudioMembers(studio.id, studioCeiling("pro") - 2);
    const one = await insertUser("base");
    const two = await insertUser("base");
    const inviteOne = await inviteToStudio(studio.slug, admin.id, one.email);
    const inviteTwo = await inviteToStudio(studio.slug, admin.id, two.email);

    const accepted = await raceOnRow(
      "studios",
      studio.id,
      () => studioInviteService.confirmInvite(inviteOne, one.id),
      () => studioInviteService.confirmInvite(inviteTwo, two.id),
    );

    expect(accepted).toBe(1);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM studio_members
      WHERE studio_id = ${studio.id} AND deleted_at IS NULL
    `;
    expect(Number(rows[0]!.n)).toBe(studioCeiling("pro"));
  });

  it("lets only one of two simultaneous project confirms take the last seat", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin.id);
    const project = await insertProject(studio.id, admin.id);
    await seedProjectMembers(project, admin.id, projectCeiling("base") - 1);
    const one = await insertUser("base");
    const two = await insertUser("base");
    const inviteOne = await inviteToProject(project, admin.id, one.email);
    const inviteTwo = await inviteToProject(project, admin.id, two.email);

    const accepted = await raceOnRow(
      "projects",
      project,
      () => projectInviteService.confirmInvite(inviteOne, one.id),
      () => projectInviteService.confirmInvite(inviteTwo, two.id),
    );

    expect(accepted).toBe(1);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_members
      WHERE project_id = ${project} AND added_by IS NOT NULL
        AND deleted_at IS NULL
    `;
    expect(Number(rows[0]!.n)).toBe(projectCeiling("base"));
  });
});
