// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Archiving and restoring a project.
 *
 * Only the studio's admin may do either. Archiving stamps the project, sweeps
 * every pending request filed against it (they could no longer be decided:
 * the project takes no writes) and takes their bell entries down, then tells
 * collab to drop live connections so they come back read-only. Restoring
 * clears the stamp, but only while the studio still has room for one more
 * live project, and tells collab again so members come back writable.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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
import { ConflictError, ForbiddenError, getLimitsForStudio, initCore, loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";

initCore(process.env);
loadLocales();

import * as projectService from "@server/modules/project/project.service.js";
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as joinService from "@server/modules/project-join-request/projectJoinRequest.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "project-archive-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  adminId: string;
  memberId: string;
  guestId: string;
  outsiderId: string;
  outsiderEmail: string;
  studioId: string;
  projectId: string;
}

/**
 * Insert a user; returns its id and email.
 * @param tag - Unique fragment for the email.
 * @returns The new user.
 */
async function insertUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}@example.com`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: row!.id, email };
}

/**
 * A team studio whose admin owns one project. The member is a maintainer and a
 * viewer on the project; the guest is in the studio but not on the project;
 * the outsider is a maintainer who can be invited.
 * @returns The seeded ids.
 */
async function seedScene(): Promise<Scene> {
  const tag = `archive-${seq++}`;
  const [admin, member, guest, outsider] = await Promise.all([
    insertUser(`${tag}-admin`),
    insertUser(`${tag}-member`),
    insertUser(`${tag}-guest`),
    insertUser(`${tag}-outsider`),
  ]);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role, added_by)
    VALUES (${studio!.id}, ${admin.id}, 'admin', ${admin.id}),
           (${studio!.id}, ${member.id}, 'maintainer', ${admin.id}),
           (${studio!.id}, ${guest.id}, 'guest', ${admin.id}),
           (${studio!.id}, ${outsider.id}, 'maintainer', ${admin.id})
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${admin.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${admin.id}, 'owner', ${admin.id}),
           (${project!.id}, ${member.id}, 'viewer', ${admin.id})
  `;
  return {
    adminId: admin.id,
    memberId: member.id,
    guestId: guest.id,
    outsiderId: outsider.id,
    outsiderEmail: outsider.email,
    studioId: studio!.id,
    projectId: project!.id,
  };
}

/** Read a project's archive columns. */
async function archiveState(projectId: string): Promise<{ archived_at: Date | null; archived_by_user_id: string | null }> {
  const rows = await sql<{ archived_at: Date | null; archived_by_user_id: string | null }[]>`
    SELECT archived_at, archived_by_user_id FROM projects WHERE id = ${projectId}
  `;
  return rows[0]!;
}

/** The lifecycle commands queued for a project, oldest first. */
async function outboxTypes(projectId: string): Promise<string[]> {
  const rows = await sql<{ type: string }[]>`
    SELECT payload->>'type' AS type FROM project_lifecycle_outbox
    WHERE payload->>'projectId' = ${projectId}
    ORDER BY created_at, id
  `;
  return rows.map((r) => r.type);
}

/**
 * Read a request row's status and whether its bell entry is still unread.
 * @param table - Request table name.
 * @param id - Request id.
 * @returns The status and the bell entry's read state.
 */
async function stateOf(table: string, id: string): Promise<{ status: string; bellUnread: boolean }> {
  const rows = await sql<{ status: string; notification_id: string | null }[]>`
    SELECT status, notification_id FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0]!;
  if (row.notification_id === null) return { status: row.status, bellUnread: false };
  const notices = await sql<{ read_at: Date | null }[]>`
    SELECT read_at FROM notifications WHERE id = ${row.notification_id}
  `;
  return { status: row.status, bellUnread: notices[0]?.read_at == null };
}

/** The single pending request on a project in a table. */
async function pendingId(table: string, projectId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM ${sql(table)} WHERE project_id = ${projectId} AND status = 'pending'
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** The studio's live-project ceiling, read the way the service reads it. */
async function projectLimit(studioId: string): Promise<number> {
  return (await getLimitsForStudio(studioId)).projects_per_studio;
}

/** Fill a studio with `count` more live projects. */
async function fillLiveProjects(studioId: string, creatorId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sql`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug)
      VALUES (${studioId}, ${creatorId}, ${`fill-${i}`}, ${`fill-${seq++}`})
    `;
  }
}

describe("archive", () => {
  it("stamps the project with the time and the admin who archived it", async () => {
    const { adminId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    const state = await archiveState(projectId);
    expect(state.archived_at).toBeInstanceOf(Date);
    expect(state.archived_by_user_id).toBe(adminId);
  });

  it("queues a project:archived command for collab", async () => {
    const { adminId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    expect(await outboxTypes(projectId)).toEqual(["project:archived"]);
  });

  it("is refused to anyone but the studio's admin, the project owner included", async () => {
    const { adminId, memberId, projectId } = await seedScene();
    // Hand the project to the member so the owner is not the admin.
    await sql`UPDATE project_members SET role = 'viewer' WHERE project_id = ${projectId} AND user_id = ${adminId}`;
    await sql`UPDATE project_members SET role = 'owner' WHERE project_id = ${projectId} AND user_id = ${memberId}`;
    await expect(projectService.archive(projectId, memberId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await archiveState(projectId)).archived_at).toBeNull();
  });

  it("is refused on a project that is already archived", async () => {
    const { adminId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await expect(projectService.archive(projectId, adminId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("expires every pending request against the project and takes their bells down", async () => {
    const s = await seedScene();
    await roleUpgradeService.request({ requesterUserId: s.memberId, projectId: s.projectId, projectName: "Demo" });
    await projectTransferService.requestProjectTransfer(s.projectId, s.adminId, s.memberId);
    await joinService.request({ projectId: s.projectId, requesterUserId: s.guestId });
    await projectInviteService.createInvite(s.projectId, s.adminId, s.outsiderEmail, "editor");
    const upgrade = await pendingId("role_upgrade_requests", s.projectId);
    const transfer = await pendingId("project_transfers", s.projectId);
    const join = await pendingId("project_join_requests", s.projectId);
    const invite = await pendingId("project_invitations", s.projectId);

    await projectService.archive(s.projectId, s.adminId);

    for (const [table, id] of [
      ["role_upgrade_requests", upgrade],
      ["project_transfers", transfer],
      ["project_join_requests", join],
      ["project_invitations", invite],
    ] as const) {
      expect(await stateOf(table, id)).toEqual({ status: "expired", bellUnread: false });
    }
  });

  it("leaves the project's other unread notifications alone", async () => {
    const s = await seedScene();
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, project_id, payload)
      VALUES (${s.memberId}, 'project.join_approved', ${s.projectId}, '{}'::jsonb)
      RETURNING id
    `;
    await projectService.archive(s.projectId, s.adminId);
    const rows = await sql<{ read_at: Date | null }[]>`SELECT read_at FROM notifications WHERE id = ${other!.id}`;
    expect(rows[0]!.read_at).toBeNull();
  });
});

describe("restore", () => {
  it("clears the stamp and queues a project:restored command", async () => {
    const { adminId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await projectService.restore(projectId, adminId);
    expect(await archiveState(projectId)).toEqual({ archived_at: null, archived_by_user_id: null });
    expect(await outboxTypes(projectId)).toEqual(["project:archived", "project:restored"]);
  });

  it("leaves every member's role as it was before the archive", async () => {
    const { adminId, projectId } = await seedScene();
    const roles = async (): Promise<unknown> =>
      sql`SELECT user_id, role FROM project_members WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY user_id`;
    const before = await roles();
    await projectService.archive(projectId, adminId);
    await projectService.restore(projectId, adminId);
    expect(await roles()).toEqual(before);
  });

  it("is refused to anyone but the studio's admin", async () => {
    const { adminId, memberId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await expect(projectService.restore(projectId, memberId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await archiveState(projectId)).archived_at).toBeInstanceOf(Date);
  });

  it("is refused on a project that is not archived", async () => {
    const { adminId, projectId } = await seedScene();
    await expect(projectService.restore(projectId, adminId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("is refused while the studio is at its project limit", async () => {
    const { adminId, studioId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await fillLiveProjects(studioId, adminId, await projectLimit(studioId));
    await expect(projectService.restore(projectId, adminId)).rejects.toBeInstanceOf(ConflictError);
    expect((await archiveState(projectId)).archived_at).toBeInstanceOf(Date);
  });

  it("says a project already restored is not archived, even when that restore filled the studio", async () => {
    const { adminId, studioId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await fillLiveProjects(studioId, adminId, (await projectLimit(studioId)) - 1);
    await projectService.restore(projectId, adminId);
    await expect(projectService.restore(projectId, adminId)).rejects.toThrow(
      t("server.project.not_archived"),
    );
  });

  it("succeeds one below the limit: the archived project itself does not take a slot", async () => {
    const { adminId, studioId, projectId } = await seedScene();
    await projectService.archive(projectId, adminId);
    await fillLiveProjects(studioId, adminId, (await projectLimit(studioId)) - 1);
    await projectService.restore(projectId, adminId);
    expect((await archiveState(projectId)).archived_at).toBeNull();
  });
});
