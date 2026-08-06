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
 * @see studio settings design (2026-07-28) § 5, § 9.3
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
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

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

/**
 * Read back the id of the newest actionable notification of a given type.
 *
 * Both transfer handshakes return void — the request travels as a notification,
 * and the confirm step takes THAT notification's id.
 * @param userId - the recipient whose inbox to read.
 * @param type - the notification type to look for.
 * @returns the newest matching notification's id.
 */
/**
 * The id of the transfer row a bell entry announces.
 *
 * NOT the entry's own id. The decision endpoints act on the row, and passing
 * the entry id instead answers 404 — which several of the assertions below
 * would still satisfy, since "nothing happened" also leaves exactly one admin
 * standing. A test that green-lights by doing nothing pins nothing.
 * @param userId - Whose inbox to look in.
 * @param type - The bell entry type.
 * @returns The announced transfer's id.
 */
async function latestTransferId(userId: string, type: string): Promise<string> {
  const rows = await sql<{ transfer_id: string | null }[]>`
    SELECT payload->>'transferId' AS transfer_id FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  const id = rows[0]?.transfer_id;
  if (!id) throw new Error(`no transferId on the latest ${type} for ${userId}`);
  return id;
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

    await studioTransferService.requestTransfer(studio.slug, admin.id, receiver.id);
    const transferId = await latestTransferId(
      receiver.id,
      "studio.transfer_request",
    );

    await Promise.allSettled([
      studioTransferService.confirmTransfer(transferId, receiver.id),
      studioMemberService.leaveStudio(studio.slug, receiver.id),
    ]);

    expect(await countAdmins(studio.id)).toBe(1);
  });

  it("a studio always ends with exactly one admin when a role change races an admin transfer", async () => {
    // The third path with the same shape as the two above, and the one that
    // kept its unlocked read the longest: the admin demotes a maintainer to
    // guest from the Members tab while that maintainer is confirming a
    // transfer of the admin role to themselves. Reading the target's role
    // outside the transaction answers "maintainer" about someone who is the
    // admin by the time the write lands, and the write does not re-check —
    // `updateRole` matches on studio + user only. The studio ends with none.
    const admin = await insertUser();
    const receiver = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, receiver.id, "maintainer");

    await studioTransferService.requestTransfer(studio.slug, admin.id, receiver.id);
    const transferId = await latestTransferId(
      receiver.id,
      "studio.transfer_request",
    );

    await Promise.allSettled([
      studioTransferService.confirmTransfer(transferId, receiver.id),
      studioMemberService.updateMemberRole(studio.slug, receiver.id, "guest"),
    ]);

    expect(await countAdmins(studio.id)).toBe(1);
  });

  it("an unrelated member can still leave while the admin role is mid-handover", async () => {
    // The failure mode this pins is NOT corruption, it is a false refusal.
    // Under READ COMMITTED, a `SELECT ... WHERE role = 'admin' FOR UPDATE`
    // that blocks on a concurrent update re-checks its condition against the
    // UPDATED row once the lock frees. The row it was waiting for has just
    // been demoted, so it no longer matches — and Postgres does not restart
    // the scan to notice that somebody else became admin. The read can
    // therefore come back EMPTY while the studio demonstrably has an admin,
    // and `detachMember` reads "no admin" as "this studio is already corrupt"
    // and aborts.
    //
    // This does not corrupt anything, but a member who happened to hit Leave
    // during a handover would be told the operation conflicted, with nothing
    // in the UI explaining why.
    const admin = await insertUser();
    const successor = await insertUser();
    const leaver = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, successor.id, "maintainer");
    await insertMember(studio.id, leaver.id, "maintainer");
    const owned = await insertProject(studio.id, leaver.id);

    // Hand the admin role over in a transaction that stays open, so the leave
    // below blocks on exactly the row the handover is rewriting.
    let openGate!: () => void;
    const gateHeld = new Promise<void>((r) => {
      openGate = r;
    });
    const handover = sql.begin(async (t) => {
      await t`UPDATE studio_members SET role = 'maintainer'
              WHERE studio_id = ${studio.id} AND user_id = ${admin.id}`;
      await t`UPDATE studio_members SET role = 'admin'
              WHERE studio_id = ${studio.id} AND user_id = ${successor.id}`;
      await gateHeld;
    });
    // Let both UPDATEs land before the leave starts, so the leave is
    // guaranteed to meet the half-applied state rather than racing it.
    await new Promise((r) => setTimeout(r, 150));

    const leave = studioMemberService.leaveStudio(studio.slug, leaver.id);
    await waitUntilBlockedOn(sql, "studio_members");

    openGate();
    await handover;
    await leave;

    // The leave went through, and the project it owned landed on whoever holds
    // the admin role now — not on the one who was admin when it started.
    expect(await studioMembersRepo.getRole(studio.id, leaver.id)).toBeNull();
    expect(await countAdmins(studio.id)).toBe(1);
    expect(await projectMembersRepo.getRole(owned, successor.id)).toBe("owner");
  });

  it("nobody owns a project in a studio they have left, even when a project transfer confirms across the leave", async () => {
    // The cross-module window (design section 5.4.1): confirming a project
    // transfer checks the recipient's eligibility and THEN hands the project
    // over. Without a lock on those reads, a leave can commit in between —
    // and `materializeOwner` upserts with `deleted_at = null`, so it REVIVES
    // the very membership row the leave just soft-deleted. The result is a
    // permanent inconsistency: someone who is not a studio member owns one of
    // that studio's projects, and can still open it.
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await insertMember(studio.id, member.id, "maintainer");
    const project = await insertProject(studio.id, admin.id);
    await insertProjectMember(project, member.id, "editor");

    await projectTransferService.requestProjectTransfer(project, admin.id, member.id);
    const transferId = await latestTransferId(
      member.id,
      "project.transfer_request",
    );

    // The gate: hold a row lock on the ADMIN's project_members row — the first
    // row the confirm writes (it demotes the outgoing owner before promoting
    // the recipient). The transfer therefore parks with every eligibility read
    // already done and no write applied yet, which is exactly the window the
    // fix has to close. The leaving member owns no project, so the leave path
    // never touches this row: only the transfer is gated.
    let openGate!: () => void;
    const gateHeld = new Promise<void>((r) => {
      openGate = r;
    });
    const gate = sql.begin(async (t) => {
      await t`
        SELECT 1 FROM project_members
        WHERE project_id = ${project} AND user_id = ${admin.id}
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      await gateHeld;
    });

    const transfer = projectTransferService.confirmProjectTransfer(
      transferId,
      member.id,
    );
    await waitUntilBlockedOn(sql, "project_members");

    const leave = studioMemberService.leaveStudio(studio.slug, member.id);
    // Give the leave time to either block (locked — the fix) or run start to
    // finish (unlocked — the bug). Both are fine here; the assertions below
    // are what separates them.
    await new Promise((r) => setTimeout(r, 300));

    openGate();
    await gate;
    await Promise.allSettled([transfer, leave]);

    // Unconditional, deliberately: an `if (studioRole === null)` guard would
    // let the whole assertion be skipped whenever the race lands the other
    // way, which is how the previous version of this test passed while
    // guarding nothing. The leave is queued behind the transfer, so it always
    // gets to run — the member always ends up out.
    expect(await studioMembersRepo.getRole(studio.id, member.id)).toBeNull();
    expect(await projectMembersRepo.getRole(project, member.id)).toBeNull();
    // And the project it passed through is not left ownerless.
    expect(await projectMembersRepo.getOwner(project)).toBe(admin.id);
  });
});
