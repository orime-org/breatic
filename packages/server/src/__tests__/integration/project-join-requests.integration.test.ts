// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Joining a project by request, against a real Postgres.
 *
 * A studio member who is not on a project sees it in the studio list, cannot
 * open it, and asks the project's owner to let them in. The guarantees are
 * SQL-level — the one-pending partial index, the composite member key that a
 * removed member still occupies, the CAS on `status = 'pending'` — so they are
 * asserted against the real schema. Every cell of the design's transition
 * table has a case here, including the two paths that change a project's
 * owner (transfer, and the owner leaving the studio) and the paths that make
 * a requester a member by some other route.
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
import {
  ConflictError,
  ForbiddenError,
  initCore,
  NotFoundError,
} from "@breatic/core";
import * as projectService from "@server/modules/project/project.service.js";
import * as joinService from "@server/modules/project-join-request/projectJoinRequest.service.js";
import * as decisionService from "@server/modules/decision/decision.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as projectMembersService from "@server/modules/project/projectMembers.service.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";

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
    connection: { application_name: "project-join-requests-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a user with a personal studio, so display names resolve.
 * @returns The user's id and email.
 */
async function insertUser(): Promise<{ id: string; email: string }> {
  const n = seq++;
  const email = `pjr-${n}@example.com`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const [personal] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`pjr-user-${n}`}, 'personal', ${`User ${n}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${personal!.id}, ${user!.id}, 'admin')
  `;
  return { id: user!.id, email };
}

/** A team studio with an admin, plus the ids a test needs. */
interface Fixture {
  studioId: string;
  studioSlug: string;
  admin: { id: string; email: string };
}

/**
 * Insert a team studio administered by a fresh user.
 * @returns The studio and its admin.
 */
async function insertStudio(): Promise<Fixture> {
  const admin = await insertUser();
  const slug = `pjr-studio-${seq++}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin.id}, ${slug}, 'team', ${`Studio ${slug}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${row!.id}, ${admin.id}, 'admin')
  `;
  return { studioId: row!.id, studioSlug: slug, admin };
}

/**
 * Add a user to a studio.
 * @param studioId - The studio.
 * @param role - Their studio role.
 * @returns The new member.
 */
async function addStudioMember(
  studioId: string,
  role: "maintainer" | "guest" = "maintainer",
): Promise<{ id: string; email: string }> {
  const user = await insertUser();
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${user.id}, ${role})
  `;
  return user;
}

/**
 * Insert a project and its owner row.
 * @param studioId - The studio it lives in.
 * @param ownerId - Its owner.
 * @returns The project id and name.
 */
async function insertProject(
  studioId: string,
  ownerId: string,
): Promise<{ id: string; name: string }> {
  const slug = `pjr-project-${seq++}`;
  const name = `Project ${slug}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${ownerId}, ${name}, ${slug})
    RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${row!.id}, ${ownerId}, 'owner', null)
  `;
  return { id: row!.id, name };
}

/**
 * Seed a non-owner member row directly.
 * @param projectId - The project.
 * @param userId - The member.
 * @param role - Their role.
 * @param addedBy - Who added them; null for a legacy auto-joined viewer.
 */
async function insertMember(
  projectId: string,
  userId: string,
  role: "editor" | "viewer",
  addedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, ${addedBy})
  `;
}

/**
 * Active member role of a user on a project.
 * @param projectId - The project.
 * @param userId - The user.
 * @returns Their role, or null when they have no active row.
 */
async function activeRole(projectId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]?.role ?? null;
}

/**
 * The single request row for a (project, requester) pair, newest first.
 * @param projectId - The project.
 * @param userId - The requester.
 * @returns The row's status, token, bell id and granted role.
 */
async function latestRequest(
  projectId: string,
  userId: string,
): Promise<{ id: string; status: string; share_token: string; notification_id: string | null; granted_role: string | null }> {
  const rows = await sql<
    { id: string; status: string; share_token: string; notification_id: string | null; granted_role: string | null }[]
  >`
    SELECT id, status, share_token, notification_id, granted_role
    FROM project_join_requests
    WHERE project_id = ${projectId} AND requester_user_id = ${userId}
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!rows[0]) throw new Error("no join request row");
  return rows[0];
}

/**
 * A bell entry by id.
 * @param id - Notification id.
 * @returns Its recipient and whether it has been retired.
 */
async function bell(id: string): Promise<{ user_id: string; type: string; retired: boolean }> {
  const [row] = await sql<{ user_id: string; type: string; retired: boolean }[]>`
    SELECT user_id, type, read_at IS NOT NULL AS retired FROM notifications WHERE id = ${id}
  `;
  if (!row) throw new Error(`no notification ${id}`);
  return row;
}

/**
 * Unread bell entries of one type for a user on a project.
 * @param userId - Recipient.
 * @param type - Notification type.
 * @param projectId - The project.
 * @returns How many there are.
 */
async function unreadCount(userId: string, type: string, projectId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND project_id = ${projectId}
      AND read_at IS NULL AND deleted_at IS NULL
  `;
  return row!.n;
}

/** A studio with an owner-maintainer's project and one outsider-to-it member. */
async function scene(): Promise<{
  fx: Fixture;
  owner: { id: string; email: string };
  requester: { id: string; email: string };
  project: { id: string; name: string };
}> {
  const fx = await insertStudio();
  const owner = await addStudioMember(fx.studioId);
  const requester = await addStudioMember(fx.studioId);
  const project = await insertProject(fx.studioId, owner.id);
  return { fx, owner, requester, project };
}

describe("seeing and opening (A1 A4 A11)", () => {
  it("a studio member sees every project in the studio, including ones they are not on", async () => {
    const { fx, requester, project } = await scene();
    const listed = await projectService.listByStudioForViewer(fx.studioId, requester.id, { archived: false });
    expect(listed.map((p) => p.id)).toContain(project.id);
  });

  it("a studio member who is not on the project gets 403 and no member row is written", async () => {
    const { requester, project } = await scene();
    await expect(projectService.loadForViewer(project.id, requester.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await activeRole(project.id, requester.id)).toBeNull();
  });

  it("a studio admin who is not on the project also gets 403", async () => {
    const { fx, project } = await scene();
    await expect(projectService.loadForViewer(project.id, fx.admin.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("someone outside the studio gets 404, and so does the join-request read", async () => {
    const { project } = await scene();
    const outsider = await insertUser();
    await expect(projectService.loadForViewer(project.id, outsider.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(joinService.getMine(project.id, outsider.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("the join-request read names the project and its studio, with no pending request yet", async () => {
    const { fx, requester, project } = await scene();
    const mine = await joinService.getMine(project.id, requester.id);
    expect(mine.project).toEqual({ id: project.id, name: project.name, studioSlug: fx.studioSlug });
    expect(mine.pendingRequest).toBeNull();
  });
});

describe("filing a request (A5 A6)", () => {
  it("files one pending request and rings the owner's bell with a decision token", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id, message: "let me in" });

    const row = await latestRequest(project.id, requester.id);
    expect(row.status).toBe("pending");
    expect(row.notification_id).not.toBeNull();
    const entry = await bell(row.notification_id!);
    expect(entry).toMatchObject({ user_id: owner.id, type: "project.join_request", retired: false });

    const mine = await joinService.getMine(project.id, requester.id);
    expect(mine.pendingRequest?.id).toBe(row.id);
  });

  it("a second request while one is pending is refused with 409", async () => {
    const { requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const refused = joinService.request({ projectId: project.id, requesterUserId: requester.id });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow("server.project.join_already_pending");
  });

  it("two simultaneous requests leave exactly one pending row", async () => {
    const { requester, project } = await scene();
    const results = await Promise.allSettled([
      joinService.request({ projectId: project.id, requesterUserId: requester.id }),
      joinService.request({ projectId: project.id, requesterUserId: requester.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_join_requests
      WHERE project_id = ${project.id} AND requester_user_id = ${requester.id} AND status = 'pending'
    `;
    expect(row!.n).toBe(1);
  });

  it("a member of the project cannot file one", async () => {
    const { owner, project } = await scene();
    await expect(
      joinService.request({ projectId: project.id, requesterUserId: owner.id }),
    ).rejects.toThrow(new ConflictError("server.project.join_already_member"));
  });

  it("someone outside the studio cannot file one", async () => {
    const { project } = await scene();
    const outsider = await insertUser();
    await expect(
      joinService.request({ projectId: project.id, requesterUserId: outsider.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("answering through the decision page (A6 A7 A8)", () => {
  it("approve as editor makes the requester an editor, rings their bell, retires the owner's", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);

    await decisionService.respond(row.share_token, owner.id, "confirm", "editor");

    expect(await activeRole(project.id, requester.id)).toBe("editor");
    const settled = await latestRequest(project.id, requester.id);
    expect(settled).toMatchObject({ status: "approved", granted_role: "editor" });
    expect((await bell(row.notification_id!)).retired).toBe(true);
    expect(await unreadCount(requester.id, "project.join_approved", project.id)).toBe(1);
  });

  it("approve without a role grants viewer", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);
    await decisionService.respond(row.share_token, owner.id, "confirm");
    expect(await activeRole(project.id, requester.id)).toBe("viewer");
  });

  it("a role on any other kind of decision is refused", async () => {
    const { owner, requester, project } = await scene();
    await projectInviteService.createInvite(project.id, owner.id, requester.email, "viewer");
    const [inv] = await sql<{ share_token: string }[]>`
      SELECT share_token FROM project_invitations
      WHERE project_id = ${project.id} AND invited_user_id = ${requester.id}
    `;
    await expect(
      decisionService.respond(inv!.share_token, requester.id, "confirm", "editor"),
    ).rejects.toThrow();
    expect(await activeRole(project.id, requester.id)).toBeNull();
  });

  it("reject leaves no member row, tells the requester, and lets them ask again", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);

    await decisionService.respond(row.share_token, owner.id, "decline");

    expect(await activeRole(project.id, requester.id)).toBeNull();
    expect((await latestRequest(project.id, requester.id)).status).toBe("rejected");
    expect((await bell(row.notification_id!)).retired).toBe(true);
    expect(await unreadCount(requester.id, "project.join_rejected", project.id)).toBe(1);

    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    expect((await latestRequest(project.id, requester.id)).status).toBe("pending");
  });

  it("only the current owner may answer", async () => {
    const { fx, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);
    await expect(
      decisionService.respond(row.share_token, fx.admin.id, "confirm"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await latestRequest(project.id, requester.id)).status).toBe("pending");
  });

  it("a requester who left the studio meanwhile makes the request expire with 409", async () => {
    const { fx, owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);
    await studioMemberService.removeMember(fx.studioSlug, requester.id);

    await expect(
      decisionService.respond(row.share_token, owner.id, "confirm"),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await latestRequest(project.id, requester.id)).status).toBe("expired");
    expect(await activeRole(project.id, requester.id)).toBeNull();
  });
});

describe("withdrawing and timing out (A9)", () => {
  it("withdrawing retires the owner's bell and frees the slot", async () => {
    const { requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);

    await joinService.cancelMine(project.id, requester.id);

    expect((await latestRequest(project.id, requester.id)).status).toBe("cancelled");
    expect((await bell(row.notification_id!)).retired).toBe(true);
    expect((await joinService.getMine(project.id, requester.id)).pendingRequest).toBeNull();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
  });

  it("withdrawing with nothing pending is a 404", async () => {
    const { requester, project } = await scene();
    await expect(joinService.cancelMine(project.id, requester.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("a timed-out request no longer shows as pending and a new one can be filed", async () => {
    const { requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);
    await sql`UPDATE project_join_requests SET expires_at = now() - interval '1 second' WHERE id = ${row.id}`;

    expect((await joinService.getMine(project.id, requester.id)).pendingRequest).toBeNull();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    expect((await sql`SELECT status FROM project_join_requests WHERE id = ${row.id}`)[0]!.status).toBe("expired");
    expect((await bell(row.notification_id!)).retired).toBe(true);
  });
});

describe("the collaborator ceiling (A10)", () => {
  it("counts every non-owner member, including legacy auto-joined viewers", async () => {
    const { owner, requester, project } = await scene();
    // Base tier: 4 collaborators. Two invited, two legacy auto-joined.
    for (const addedBy of [owner.id, owner.id, null, null]) {
      const u = await insertUser();
      await insertMember(project.id, u.id, "viewer", addedBy);
    }
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);

    await expect(
      decisionService.respond(row.share_token, owner.id, "confirm"),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await latestRequest(project.id, requester.id)).status).toBe("pending");
    expect(await activeRole(project.id, requester.id)).toBeNull();
  });

  it("a full project still lets an existing member accept an invite that changes their role", async () => {
    const { owner, requester, project } = await scene();
    await projectInviteService.createInvite(project.id, owner.id, requester.email, "editor");
    const [inv] = await sql<{ id: string }[]>`
      SELECT id FROM project_invitations
      WHERE project_id = ${project.id} AND invited_user_id = ${requester.id}
    `;
    // The requester became a viewer by another route after the invite was sent,
    // then the project filled up.
    await insertMember(project.id, requester.id, "viewer", null);
    for (let i = 0; i < 3; i++) {
      const u = await insertUser();
      await insertMember(project.id, u.id, "viewer", owner.id);
    }

    await projectInviteService.confirmInvite(inv!.id, requester.id);
    expect(await activeRole(project.id, requester.id)).toBe("editor");
  });
});

describe("becoming a member by another route settles the request", () => {
  it("accepting an invite expires the pending request and retires the owner's bell", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const row = await latestRequest(project.id, requester.id);
    await projectInviteService.createInvite(project.id, owner.id, requester.email, "editor");
    const [inv] = await sql<{ id: string }[]>`
      SELECT id FROM project_invitations
      WHERE project_id = ${project.id} AND invited_user_id = ${requester.id}
    `;

    await projectInviteService.confirmInvite(inv!.id, requester.id);

    expect((await latestRequest(project.id, requester.id)).status).toBe("expired");
    expect((await bell(row.notification_id!)).retired).toBe(true);
  });

  it("an admin whose request is pending and who inherits the project does not get their own request re-addressed to them", async () => {
    const { fx, owner, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: fx.admin.id });
    const row = await latestRequest(project.id, fx.admin.id);

    await studioMemberService.leaveStudio(fx.studioSlug, owner.id);

    expect(await activeRole(project.id, fx.admin.id)).toBe("owner");
    expect((await latestRequest(project.id, fx.admin.id)).status).toBe("expired");
    expect((await bell(row.notification_id!)).retired).toBe(true);
    expect(await unreadCount(fx.admin.id, "project.join_request", project.id)).toBe(0);
  });
});

describe("an owner change re-addresses pending requests", () => {
  it("a transfer moves the bell to the new owner, who can answer; the old owner cannot", async () => {
    const { fx, owner, requester, project } = await scene();
    const heir = await addStudioMember(fx.studioId);
    await insertMember(project.id, heir.id, "editor", owner.id);
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const before = await latestRequest(project.id, requester.id);

    await projectTransferService.requestProjectTransfer(project.id, owner.id, heir.id);
    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM project_transfers WHERE project_id = ${project.id} AND status = 'pending'
    `;
    await projectTransferService.confirmProjectTransfer(offer!.id, heir.id);

    const after = await latestRequest(project.id, requester.id);
    expect(after.status).toBe("pending");
    expect(after.share_token).toBe(before.share_token);
    expect((await bell(before.notification_id!)).retired).toBe(true);
    expect(after.notification_id).not.toBe(before.notification_id);
    expect(await bell(after.notification_id!)).toMatchObject({
      user_id: heir.id,
      type: "project.join_request",
      retired: false,
    });

    await expect(
      decisionService.respond(after.share_token, owner.id, "confirm"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await decisionService.respond(after.share_token, heir.id, "confirm");
    expect(await activeRole(project.id, requester.id)).toBe("viewer");
  });

  it("the owner leaving the studio moves the bell to the studio admin", async () => {
    const { fx, owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const before = await latestRequest(project.id, requester.id);

    await studioMemberService.removeMember(fx.studioSlug, owner.id);

    const after = await latestRequest(project.id, requester.id);
    expect(after.status).toBe("pending");
    expect((await bell(before.notification_id!)).retired).toBe(true);
    expect(await bell(after.notification_id!)).toMatchObject({
      user_id: fx.admin.id,
      type: "project.join_request",
      retired: false,
    });
  });
});

describe("a removed member can come back", () => {
  it("removed → asks again → approved revives their member row with the chosen role", async () => {
    const { owner, requester, project } = await scene();
    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const first = await latestRequest(project.id, requester.id);
    await decisionService.respond(first.share_token, owner.id, "confirm", "editor");
    await projectMembersService.remove(project.id, requester.id, owner.id);
    expect(await activeRole(project.id, requester.id)).toBeNull();

    await joinService.request({ projectId: project.id, requesterUserId: requester.id });
    const second = await latestRequest(project.id, requester.id);
    expect(second.id).not.toBe(first.id);
    await decisionService.respond(second.share_token, owner.id, "confirm", "viewer");

    expect(await activeRole(project.id, requester.id)).toBe("viewer");
    expect((await latestRequest(project.id, requester.id)).status).toBe("approved");
  });
});
