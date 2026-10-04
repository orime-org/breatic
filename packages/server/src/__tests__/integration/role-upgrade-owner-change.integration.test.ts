// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A pending role-upgrade request follows the project to its new owner —
 * real Postgres.
 *
 * Both requests addressed to a project's owner (joining, and a viewer asking
 * for editor rights) move to whoever owns the project now. The join half is
 * covered in `project-join-requests.integration.test.ts`; this file covers the
 * role-upgrade half on both owner-change paths, the new owner's own request,
 * and the two operations that race an owner change: filing and withdrawing.
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
import { db, ForbiddenError, initCore, projectMembersRepo } from "@breatic/core";
import * as upgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as decisionService from "@server/modules/decision/decision.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import { onProjectOwnerChanged } from "@server/modules/project/projectOwnerChange.service.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

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
    connection: { application_name: "role-upgrade-owner-change-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a user with a personal studio, so display names resolve.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`ruoc-${n}@example.com`}, true) RETURNING id
  `;
  const [personal] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`ruoc-user-${n}`}, 'personal', ${`User ${n}`})
    RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${personal!.id}, ${user!.id}, 'admin')`;
  return user!.id;
}

/** A team studio, a project owned by a maintainer, an heir and a viewer. */
interface Scene {
  studioId: string;
  studioSlug: string;
  admin: string;
  owner: string;
  heir: string;
  viewer: string;
  project: { id: string; name: string };
}

/**
 * Build the scene: the heir is an editor and the viewer a viewer on the project.
 * @returns The ids a case needs.
 */
async function scene(): Promise<Scene> {
  const admin = await insertUser();
  const studioSlug = `ruoc-studio-${seq++}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin}, ${studioSlug}, 'team', 'Studio') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${admin}, 'admin')`;
  const [owner, heir, viewer] = [await insertUser(), await insertUser(), await insertUser()];
  for (const id of [owner, heir, viewer]) {
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${id}, 'maintainer')`;
  }
  const slug = `ruoc-project-${seq++}`;
  const name = `Project ${slug}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${owner}, ${name}, ${slug}) RETURNING id
  `;
  const projectId = row!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner}, 'owner', null)`;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${heir}, 'editor', ${owner})`;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer}, 'viewer', ${owner})`;
  return { studioId, studioSlug, admin, owner, heir, viewer, project: { id: projectId, name } };
}

/**
 * File a role-upgrade request for a viewer.
 * @param s - The scene.
 * @param requester - The viewer asking.
 */
async function file(s: Scene, requester: string): Promise<void> {
  await upgradeService.request({
    requesterUserId: requester,
    projectId: s.project.id,
    projectName: s.project.name,
  });
}

/**
 * The newest role-upgrade request of a requester on a project.
 * @param projectId - The project.
 * @param userId - The requester.
 * @returns Its id, status, token and bell id.
 */
async function latest(
  projectId: string,
  userId: string,
): Promise<{ id: string; status: string; share_token: string; notification_id: string | null }> {
  const [row] = await sql<{ id: string; status: string; share_token: string; notification_id: string | null }[]>`
    SELECT id, status, share_token, notification_id FROM role_upgrade_requests
    WHERE project_id = ${projectId} AND requester_user_id = ${userId}
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!row) throw new Error("no role upgrade request row");
  return row;
}

/**
 * A bell entry by id.
 * @param id - Notification id.
 * @returns Its recipient and whether it has been retired.
 */
async function bell(id: string): Promise<{ user_id: string; retired: boolean }> {
  const [row] = await sql<{ user_id: string; retired: boolean }[]>`
    SELECT user_id, read_at IS NOT NULL AS retired FROM notifications WHERE id = ${id}
  `;
  if (!row) throw new Error(`no notification ${id}`);
  return row;
}

/**
 * Unread role-upgrade bell entries for a user on a project.
 * @param userId - Recipient.
 * @param projectId - The project.
 * @returns How many there are.
 */
async function unreadUpgradeBells(userId: string, projectId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications
    WHERE user_id = ${userId} AND project_id = ${projectId} AND type = 'access.role_upgrade_request'
      AND read_at IS NULL AND deleted_at IS NULL
  `;
  return row!.n;
}

/**
 * Transfer the project from its owner to the heir through the real flow.
 * @param s - The scene.
 */
async function transfer(s: Scene): Promise<void> {
  await projectTransferService.requestProjectTransfer(s.project.id, s.owner, s.heir);
  const [offer] = await sql<{ id: string }[]>`
    SELECT id FROM project_transfers WHERE project_id = ${s.project.id} AND status = 'pending'
  `;
  await projectTransferService.confirmProjectTransfer(offer!.id, s.heir);
}

describe("an owner change re-addresses pending role-upgrade requests", () => {
  it("a transfer moves the bell to the new owner, who can answer; the old owner cannot", async () => {
    const s = await scene();
    await file(s, s.viewer);
    const before = await latest(s.project.id, s.viewer);

    await transfer(s);

    const after = await latest(s.project.id, s.viewer);
    expect(after.status).toBe("pending");
    expect(after.share_token).toBe(before.share_token);
    expect((await bell(before.notification_id!)).retired).toBe(true);
    expect(await bell(after.notification_id!)).toEqual({ user_id: s.heir, retired: false });

    await expect(decisionService.respond(after.share_token, s.owner, "confirm")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await decisionService.respond(after.share_token, s.heir, "confirm");
    const [member] = await sql<{ role: string }[]>`
      SELECT role FROM project_members WHERE project_id = ${s.project.id} AND user_id = ${s.viewer} AND deleted_at IS NULL
    `;
    expect(member!.role).toBe("editor");
  });

  it("the owner leaving the studio moves the bell to the studio admin", async () => {
    const s = await scene();
    await file(s, s.viewer);
    const before = await latest(s.project.id, s.viewer);

    await studioMemberService.removeMember(s.studioSlug, s.owner);

    const after = await latest(s.project.id, s.viewer);
    expect(after.status).toBe("pending");
    expect((await bell(before.notification_id!)).retired).toBe(true);
    expect(await bell(after.notification_id!)).toEqual({ user_id: s.admin, retired: false });
  });

  it("the new owner's own pending request is settled, not delivered to themselves", async () => {
    const s = await scene();
    // The heir is a viewer here, so they can have a pending request of their own.
    await sql`UPDATE project_members SET role = 'viewer' WHERE project_id = ${s.project.id} AND user_id = ${s.heir}`;
    await file(s, s.heir);
    const own = await latest(s.project.id, s.heir);

    await transfer(s);

    expect((await latest(s.project.id, s.heir)).status).toBe("expired");
    expect((await bell(own.notification_id!)).retired).toBe(true);
    expect(await unreadUpgradeBells(s.heir, s.project.id)).toBe(0);
  });
});

describe("filing and withdrawing serialise behind an owner change", () => {
  it("a request filed while the owner is changing rings the new owner", async () => {
    const s = await scene();
    const holder = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let filing: Promise<void> = Promise.resolve();
    try {
      await holder.begin(async (h) => {
        await h`SELECT 1 FROM projects WHERE id = ${s.project.id} FOR UPDATE`;
        await h`UPDATE project_members SET role = 'editor' WHERE project_id = ${s.project.id} AND user_id = ${s.owner}`;
        await h`UPDATE project_members SET role = 'owner' WHERE project_id = ${s.project.id} AND user_id = ${s.heir}`;
        filing = file(s, s.viewer);
        await waitUntilBlockedOn(sql, ["projects", "for update"], 1);
      });
    } finally {
      await filing;
      await holder.end({ timeout: 5 });
    }
    const row = await latest(s.project.id, s.viewer);
    expect(await bell(row.notification_id!)).toEqual({ user_id: s.heir, retired: false });
  });

  it("a withdrawal waits for an in-flight owner change and leaves the new owner no bell", async () => {
    const s = await scene();
    await file(s, s.viewer);
    const req = await latest(s.project.id, s.viewer);
    let withdrawing: Promise<void> = Promise.resolve();
    await db.transaction(async (tx) => {
      await projectRepo.lockLiveProject(s.project.id, tx);
      withdrawing = upgradeService.cancel(req.id, s.viewer);
      await waitUntilBlockedOn(sql, ["projects", "for update"], 1);
      await projectMembersRepo.updateRoleIfCurrent(s.project.id, s.owner, "owner", "editor", tx);
      await projectMembersRepo.materializeOwner(s.project.id, s.heir, tx);
      await onProjectOwnerChanged(s.project.id, s.heir, tx);
    });
    await withdrawing;
    expect((await latest(s.project.id, s.viewer)).status).toBe("cancelled");
    expect(await unreadUpgradeBells(s.heir, s.project.id)).toBe(0);
  });

  it("a withdrawal that lands before the owner change leaves the new owner no bell", async () => {
    const s = await scene();
    await file(s, s.viewer);
    await upgradeService.cancel((await latest(s.project.id, s.viewer)).id, s.viewer);

    await transfer(s);

    expect(await unreadUpgradeBells(s.heir, s.project.id)).toBe(0);
  });
});
