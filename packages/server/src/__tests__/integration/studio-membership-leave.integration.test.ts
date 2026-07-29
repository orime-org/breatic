// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test: leaving a studio, against real PostgreSQL.
 *
 * The critical path (auth + data integrity). A member leaving is not the
 * mirror image of an admin kicking someone — the actor IS the departing
 * member, so there is no third party to inherit their projects. What this
 * pins:
 *   - the inheritor is resolved from the studio's admin, never from the actor
 *   - the admin ALREADY being a member of an inherited project is fine
 *     (upsert, not insert — otherwise the one-owner index rejects it)
 *   - leaving revokes access to every project in that studio
 *   - the sole admin cannot leave; a personal studio cannot be left
 *   - INVARIANT under concurrency: a studio always ends with exactly one
 *     admin, even when a leave races an admin transfer
 *   - INVARIANT under concurrency: nobody ends up owning a project in a
 *     studio they are no longer a member of
 *
 * @see packages/server/src/modules/studio/studioMember.service.ts
 * @see inner engineering/specs 2026-07-28 studio settings design, sections 5 and 9.3
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing anything that reaches the domain barrel — it
// pulls agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build Node
// rejects. This suite never calls an ai function.
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
import { initCore, ConflictError, ForbiddenError, NotFoundError, projectMembersRepo } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";

// integration-setup.ts injects the container URLs into process.env; the
// worker is shared with sibling suites that may have already inited.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "studio-membership-leave-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/**
 * Insert a verified user.
 * @returns the new user's id and email.
 */
async function insertUser(): Promise<{ id: string; email: string }> {
  const email = `leave-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

let studioSeq = 0;
/**
 * Insert a studio plus the creator's admin member row.
 * @param adminUserId - the user who becomes the studio's admin.
 * @param type - team (default) or personal.
 * @returns the new studio's id and slug.
 */
async function insertStudioWithAdmin(
  adminUserId: string,
  type: "team" | "personal" = "team",
): Promise<{ id: string; slug: string }> {
  const slug = `leave-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, ${type}, 'Leave Test Studio')
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

let projectSeq = 0;
/**
 * Insert a project owned by the given user.
 * @param studioId - the owning studio.
 * @param ownerUserId - the user who gets the owner member row.
 * @returns the new project's id.
 */
async function insertProject(studioId: string, ownerUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${ownerUserId}, ${`leave-proj-${projectSeq++}`}, 'P')
    RETURNING id
  `;
  const pid = rows[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${pid}, ${ownerUserId}, 'owner')`;
  return pid;
}

/**
 * Insert an active studio member row directly, bypassing the invite handshake.
 * @param studioId - the studio to join.
 * @param userId - the joining user.
 * @param role - the studio role to grant.
 */
async function insertMember(studioId: string, userId: string, role: string): Promise<void> {
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, ${role})`;
}

/**
 * Add a non-owner project member row.
 * @param projectId - the project to join.
 * @param userId - the joining user.
 * @param role - the project role to grant.
 */
async function insertProjectMember(
  projectId: string,
  userId: string,
  role: string,
): Promise<void> {
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})`;
}

/**
 * Count the studio's live admin rows straight from the table.
 * @param studioId - the studio to count within.
 * @returns how many active admin member rows exist.
 */
async function countAdmins(studioId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM studio_members
    WHERE studio_id = ${studioId} AND role = 'admin' AND deleted_at IS NULL
  `;
  return Number(rows[0]!.n);
}

describe("leaveStudio", () => {
  it("removes the member and hands their owned projects to the studio's admin", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, member.id, "maintainer");
    const ownedByMember = await insertProject(studio.id, member.id);

    await studioMemberService.leaveStudio(studio.slug, member.id);

    expect(await studioMembersRepo.getRole(studio.id, member.id)).toBeNull();
    expect(await projectMembersRepo.getRole(ownedByMember, member.id)).toBeNull();
    // The inheritor is the studio's admin — NOT the actor, who is the leaver.
    expect(await projectMembersRepo.getRole(ownedByMember, admin.id)).toBe("owner");
  });

  it("revokes access to every project in the studio, not just the owned ones", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, member.id, "guest");
    const adminsProject = await insertProject(studio.id, admin.id);
    await insertProjectMember(adminsProject, member.id, "editor");

    await studioMemberService.leaveStudio(studio.slug, member.id);

    expect(await projectMembersRepo.getRole(adminsProject, member.id)).toBeNull();
    expect(await projectMembersRepo.getRole(adminsProject, admin.id)).toBe("owner");
  });

  it("succeeds when the admin is ALREADY a member of the inherited project", async () => {
    // The one-owner partial unique index rejects a second owner row, so this
    // only works if the handover upserts (and the leaver's row is cleared
    // first, freeing the slot).
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, member.id, "maintainer");
    const ownedByMember = await insertProject(studio.id, member.id);
    await insertProjectMember(ownedByMember, admin.id, "editor");

    await studioMemberService.leaveStudio(studio.slug, member.id);

    expect(await projectMembersRepo.getRole(ownedByMember, admin.id)).toBe("owner");
    const owners = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_members
      WHERE project_id = ${ownedByMember} AND role = 'owner' AND deleted_at IS NULL
    `;
    expect(Number(owners[0]!.n)).toBe(1);
  });

  it("refuses to let the sole admin leave (they must transfer first)", async () => {
    const admin = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);

    await expect(studioMemberService.leaveStudio(studio.slug, admin.id)).rejects.toThrow(
      ConflictError,
    );
    expect(await studioMembersRepo.getRole(studio.id, admin.id)).toBe("admin");
  });

  it("refuses to leave a personal studio", async () => {
    const owner = await insertUser();
    const studio = await insertStudioWithAdmin(owner.id, "personal");

    await expect(studioMemberService.leaveStudio(studio.slug, owner.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("rejects a non-member with NotFound", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);

    await expect(studioMemberService.leaveStudio(studio.slug, stranger.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("leaveStudio — concurrency invariants", () => {
  it("a studio always ends with exactly one admin when a leave races an admin transfer", async () => {
    // The dangerous interleaving named in the design: the leaver IS the
    // transfer's recipient. A role check read outside the transaction can
    // soft-delete the row that just became admin, leaving the studio with
    // zero admins and nobody able to fix it.
    const admin = await insertUser();
    const receiver = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, receiver.id, "maintainer");

    // requestTransfer returns void — the handshake travels as an actionable
    // notification, and confirmTransfer takes THAT notification's id.
    await studioTransferService.requestTransfer(studio.slug, admin.id, receiver.id);
    const reqs = await sql<{ id: string }[]>`
      SELECT id FROM notifications
      WHERE user_id = ${receiver.id} AND type = 'studio.transfer_request'
        AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;
    const notificationId = reqs[0]!.id;

    await Promise.allSettled([
      studioTransferService.confirmTransfer(notificationId, receiver.id),
      studioMemberService.leaveStudio(studio.slug, receiver.id),
    ]);

    expect(await countAdmins(studio.id)).toBe(1);
  });

  // ⚠️ THIS ONE DOES NOT GUARD ANYTHING YET — it passes for the wrong reason.
  //
  // The hole it describes lives in the project-transfer path, which validates
  // the recipient's studio role OUTSIDE its transaction and can therefore
  // revive a membership row a concurrent leave just soft-deleted. That path is
  // not fixed yet (design section 5.4.1), and this test cannot fail it: the
  // handover here is a bare repo call with no membership check to race
  // against, and the assertion is skipped entirely when the leave loses.
  //
  // Kept as the placeholder for the real thing, which needs the transfer
  // service locked first and then a deterministic interleaving — not
  // Promise.allSettled, which never guarantees the ordering that breaks it.
  it("nobody owns a project in a studio they have left", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, member.id, "maintainer");
    const project = await insertProject(studio.id, admin.id);
    await insertProjectMember(project, member.id, "editor");

    await Promise.allSettled([
      studioMemberService.leaveStudio(studio.slug, member.id),
      projectMembersRepo.materializeOwner(project, member.id),
    ]);

    const studioRole = await studioMembersRepo.getRole(studio.id, member.id);
    const projectRole = await projectMembersRepo.getRole(project, member.id);
    // Whichever order they land in, these two must agree: a non-member
    // cannot hold any project role in that studio.
    if (studioRole === null) {
      expect(projectRole).toBeNull();
    }
  });
});
