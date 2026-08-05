// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Answering a request through the one endpoint, for all five flows.
 *
 * The write itself still belongs to each flow's own service — accepting a
 * studio invite adds a member, accepting a transfer swaps ownership, approving
 * an upgrade rewrites a role, and none of that is this module's business. What
 * IS its business is the gate in front of them, which used to be written five
 * times: is this request still answerable, and is this the person being asked.
 *
 * Answering twice is the case worth pinning. Both entrances now lead to the
 * same write, so the second attempt has to be refused by the row's own status
 * rather than by whichever entrance happened to notice first.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core — the core barrel pulls agent/llm →
// the `ai` SDK → @opentelemetry/api, whose ESM build uses bare relative imports
// Node's native ESM rejects. This suite never calls any ai function.
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
  initCore,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@breatic/core";

initCore(process.env);

import * as decisionService from "@server/modules/decision/decision.service.js";
import * as studioInvitationsRepo from "@server/modules/studio/studioInvitations.repo.js";
import * as projectInvitationsRepo from "@server/modules/project-invite/projectInvitations.repo.js";
import * as roleUpgradeRequestsRepo from "@server/modules/role-upgrade-request/roleUpgradeRequests.repo.js";
import * as projectTransfersRepo from "@server/modules/project/projectTransfers.repo.js";
import * as studioTransfersRepo from "@server/modules/studio/studioTransfers.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "decision-respond-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  ownerId: string;
  memberId: string;
  studioId: string;
  studioSlug: string;
  projectId: string;
  projectSlug: string;
}

/**
 * A team studio whose member is already inside both the studio and the project
 * — the shape transfers and role upgrades require, and the shape invites are
 * tested against by inviting a THIRD person.
 * @returns The seeded scene.
 * @throws {Error} when any seed insert returns no row.
 */
async function seedScene(): Promise<Scene> {
  const tag = `dp-${seq++}-${Date.now()}`;
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-o@example.com`}, true) RETURNING id
  `;
  const [member] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-m@example.com`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${`${tag}-oh`}, 'personal', ${`${tag}-o-name`}),
           (${member!.id}, ${`${tag}-mh`}, 'personal', ${`${tag}-m-name`})
  `;
  const studioSlug = `${tag}-studio`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${studioSlug}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role, added_by)
    VALUES (${studio!.id}, ${owner!.id}, 'admin', ${owner!.id}),
           (${studio!.id}, ${member!.id}, 'maintainer', ${owner!.id})
  `;
  const projectSlug = `${tag}-p`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner!.id}, ${tag}, ${projectSlug}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner!.id}, 'owner', ${owner!.id}),
           (${project!.id}, ${member!.id}, 'viewer', ${owner!.id})
  `;
  if (!owner || !member || !studio || !project) throw new Error("seed failed");
  return {
    ownerId: owner.id,
    memberId: member.id,
    studioId: studio.id,
    studioSlug,
    projectId: project.id,
    projectSlug,
  };
}

/**
 * Adds one more user, for the invite flows — you cannot invite somebody who is
 * already inside.
 * @param tag - A unique-ish suffix for the email.
 * @returns The new user's id.
 * @throws {Error} when the insert returns no row.
 */
async function insertOutsider(tag: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`out-${tag}-${seq++}@example.com`}, true) RETURNING id
  `;
  if (!user) throw new Error("outsider seed failed");
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user.id}, ${`out-${tag}-${seq}-h`}, 'personal', ${`out-${tag}`})
  `;
  return user.id;
}

const IN_A_WEEK = (): Date => new Date(Date.now() + 7 * 24 * 3600 * 1000);

/**
 * Reads back a request's token.
 * @param table - Which request table.
 * @param id - The row id.
 * @returns The share token.
 * @throws {Error} when there is no such row.
 */
async function tokenOf(table: string, id: string): Promise<string> {
  const rows = await sql<{ share_token: string }[]>`
    SELECT share_token FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`${table}: no row ${id}`);
  return row.share_token;
}

/**
 * Reads a request's status straight from its table.
 * @param table - Which request table.
 * @param id - The row id.
 * @returns The status word.
 * @throws {Error} when there is no such row.
 */
async function statusOf(table: string, id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`${table}: no row ${id}`);
  return row.status;
}

describe("accepting lands the flow's own write, and says where to go", () => {
  it("a studio invite: the invitee joins, and is sent to the studio", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("si");
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: outsider,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });

    const result = await decisionService.respond(
      await tokenOf("studio_invitations", id),
      outsider,
      "confirm",
    );

    expect(result.state).toBe("accepted");
    expect(result.redirectTo).toBe(`/studio/${s.studioSlug}`);
    expect(await statusOf("studio_invitations", id)).toBe("accepted");
    const members = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM studio_members
      WHERE studio_id = ${s.studioId} AND user_id = ${outsider} AND deleted_at IS NULL
    `;
    expect(members[0]!.n).toBe("1");
  });

  it("a project invite sends the invitee to the project, slug-prefixed", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("pi");
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role, added_by)
      VALUES (${s.studioId}, ${outsider}, 'maintainer', ${s.ownerId})
    `;
    const { id: id } = await projectInvitationsRepo.createPending({
      projectId: s.projectId,
      invitedUserId: outsider,
      role: "viewer",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });

    const result = await decisionService.respond(
      await tokenOf("project_invitations", id),
      outsider,
      "confirm",
    );

    expect(result.state).toBe("accepted");
    // The URL spec says a project is `/project/{slug}-{id}`, not a bare id.
    expect(result.redirectTo).toBe(`/project/${s.projectSlug}-${s.projectId}`);
  });

  it("a role upgrade is approved by the owner and rewrites the role", async () => {
    const s = await seedScene();
    const { id } = await roleUpgradeRequestsRepo.createPending({
      projectId: s.projectId,
      requesterUserId: s.memberId,
      requestedRole: "editor",
      expiresAt: IN_A_WEEK(),
    });

    const result = await decisionService.respond(
      await tokenOf("role_upgrade_requests", id),
      s.ownerId,
      "confirm",
    );

    expect(result.state).toBe("accepted");
    const rows = await sql<{ role: string }[]>`
      SELECT role FROM project_members
      WHERE project_id = ${s.projectId} AND user_id = ${s.memberId} AND deleted_at IS NULL
    `;
    expect(rows[0]!.role).toBe("editor");
  });

  it("survives the recipient marking their whole inbox read", async () => {
    // Answering used to run through the bell entry, and its one-shot gate was
    // `read_at IS NULL`. Under that design one call to mark-all-read voided
    // every pending transfer and upgrade the user had: both answers came back
    // as not-found, and nothing told them why. Unifying onto the token moved
    // the truth to the request's own row, which is what fixed it — so this
    // pins the property rather than the old bug, because the way to lose it
    // again is for something to start consulting the notification once more.
    const s = await seedScene();
    const { id } = await roleUpgradeRequestsRepo.createPending({
      projectId: s.projectId,
      requesterUserId: s.memberId,
      requestedRole: "editor",
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("role_upgrade_requests", id);

    await sql`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${s.ownerId} AND read_at IS NULL
    `;

    const view = await decisionService.viewByToken(token, s.ownerId);
    expect(view?.state).toBe("answerable");
    const result = await decisionService.respond(token, s.ownerId, "confirm");
    expect(result.state).toBe("accepted");
  });

  it("a request whose container is gone refuses everyone the same way", async () => {
    // Deleting a project soft-deletes its member rows, and the role upgrade's
    // recipient IS the project's current owner — looked up, not stored. So the
    // real owner stops resolving as the recipient the moment the project dies.
    //
    // The recipient check must not be what answers them: "you are not the
    // recipient" is false about the one person who was asked. A container that
    // is gone closes the request for everybody, which is a conflict, not a
    // permission problem.
    const s = await seedScene();
    const { id } = await roleUpgradeRequestsRepo.createPending({
      projectId: s.projectId,
      requesterUserId: s.memberId,
      requestedRole: "editor",
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("role_upgrade_requests", id);
    await sql`
      UPDATE project_members SET deleted_at = now() WHERE project_id = ${s.projectId}
    `;
    await sql`
      UPDATE role_upgrade_requests SET deleted_at = now() WHERE id = ${id}
    `;

    await expect(
      decisionService.respond(token, s.ownerId, "confirm"),
    ).rejects.toThrow(ConflictError);
  });

  it("both transfers hand ownership over", async () => {
    const s = await seedScene();
    const { id: pt } = await projectTransfersRepo.createPending({
      projectId: s.projectId,
      fromUserId: s.ownerId,
      toUserId: s.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const pr = await decisionService.respond(
      await tokenOf("project_transfers", pt),
      s.memberId,
      "confirm",
    );
    expect(pr.state).toBe("accepted");
    expect(pr.redirectTo).toBe(`/project/${s.projectSlug}-${s.projectId}`);

    const s2 = await seedScene();
    const { id: st } = await studioTransfersRepo.createPending({
      studioId: s2.studioId,
      fromUserId: s2.ownerId,
      toUserId: s2.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const sr = await decisionService.respond(
      await tokenOf("studio_transfers", st),
      s2.memberId,
      "confirm",
    );
    expect(sr.state).toBe("accepted");
    expect(sr.redirectTo).toBe(`/studio/${s2.studioSlug}`);
  });
});

describe("declining settles the request and goes nowhere", () => {
  it("leaves the recipient on the page, with the request declined", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("dec");
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: outsider,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });

    const result = await decisionService.respond(
      await tokenOf("studio_invitations", id),
      outsider,
      "decline",
    );

    expect(result.state).toBe("declined");
    expect(result.redirectTo).toBeNull();
    expect(await statusOf("studio_invitations", id)).toBe("declined");
  });
});

describe("the gate in front of the write", () => {
  // §5.1: three codes, not one. Collapsing them back to 404 is exactly the
  // "four situations, one sentence" the landing page exists to undo, and a
  // bare `rejects.toThrow()` would not notice it happening.
  it("answering twice is refused by the row, not by the entrance", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("twice");
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: outsider,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);

    await decisionService.respond(token, outsider, "confirm");
    // Same token, same person, second time: the status now says it is done.
    await expect(
      decisionService.respond(token, outsider, "confirm"),
    ).rejects.toThrow(ConflictError);
  });

  it("somebody who is not the recipient cannot answer", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("wrong");
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: outsider,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });

    await expect(
      decisionService.respond(
        await tokenOf("studio_invitations", id),
        s.memberId,
        "confirm",
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(await statusOf("studio_invitations", id)).toBe("pending");
  });

  it("a timed-out request cannot be answered", async () => {
    const s = await seedScene();
    const outsider = await insertOutsider("late");
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: outsider,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    await sql`
      UPDATE studio_invitations SET expires_at = now() - interval '1 day' WHERE id = ${id}
    `;

    await expect(
      decisionService.respond(
        await tokenOf("studio_invitations", id),
        outsider,
        "confirm",
      ),
    ).rejects.toThrow(ConflictError);
  });

  it("a token nobody issued cannot be answered", async () => {
    const s = await seedScene();
    await expect(
      decisionService.respond("f".repeat(64), s.memberId, "confirm"),
    ).rejects.toThrow(NotFoundError);
  });
});
