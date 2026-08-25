// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the landing page shows, for every flow and every state it can be in.
 *
 * One page now answers five kinds of request, and the thing it must never do is
 * collapse distinct situations into one sentence. Four of them used to read
 * "invalid link": already answered, timed out, withdrawn, and a token nobody
 * issued. Only the last of those is actually invalid.
 *
 * The state order is load-bearing and is checked here rather than left to
 * reading order:
 *
 *   - deleted first, because a request that went away with its project is gone
 *     no matter what its status column still says;
 *   - then the terminal statuses, then the two expiry checks;
 *   - already-a-member LAST, and ONLY for the two invite flows — it can only
 *     downgrade a request that would otherwise be answerable, and the other
 *     three flows require the recipient to be a member already, so testing
 *     "are you in?" there would leave them permanently unanswerable.
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
import { initCore } from "@breatic/core";

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
    connection: { application_name: "decision-view-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  ownerId: string;
  ownerName: string;
  memberId: string;
  studioId: string;
  studioName: string;
  projectId: string;
  projectName: string;
}

/**
 * A team studio with an owner and a member, one project, and a personal studio
 * for each user — the last one matters because a user's display name IS their
 * personal studio's name.
 * @returns The seeded scene.
 * @throws {Error} when any seed insert returns no row.
 */
async function seedScene(): Promise<Scene> {
  const tag = `dv-${seq++}-${Date.now()}`;
  const ownerName = `${tag}-owner-name`;
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-owner@example.com`}, true) RETURNING id
  `;
  const [member] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-member@example.com`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${`${tag}-oh`}, 'personal', ${ownerName}),
           (${member!.id}, ${`${tag}-mh`}, 'personal', ${`${tag}-member-name`})
  `;
  const studioName = `${tag}-team`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${`${tag}-studio`}, 'team', ${studioName}) RETURNING id
  `;
  const projectName = `${tag}-proj`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner!.id}, ${projectName}, ${`${tag}-p`}) RETURNING id
  `;
  // A project's owner is a project_members row, not a column — creating one
  // through the app does this, and a role upgrade is decided BY that owner, so
  // a seed that skips it makes the recipient nobody.
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner!.id}, 'owner', ${owner!.id})
  `;
  if (!owner || !member || !studio || !project) throw new Error("seed failed");
  return {
    ownerId: owner.id,
    ownerName,
    memberId: member.id,
    studioId: studio.id,
    studioName,
    projectId: project.id,
    projectName,
  };
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

describe("the view names the right thing, in every flow", () => {
  it("a studio invite shows the studio, the inviter and the offered role", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("studio_invitations", id),
      s.memberId,
    );
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("studio_invite");
    expect(view!.state).toBe("answerable");
    expect(view!.entityName).toBe(s.studioName);
    expect(view!.actorName).toBe(s.ownerName);
    expect(view!.role).toBe("guest");
    expect(view!.isRecipient).toBe(true);
    expect(view!.windowDays).toBeGreaterThan(0);
  });

  it("a project invite shows the project", async () => {
    const s = await seedScene();
    const { id: id } = await projectInvitationsRepo.createPending({
      projectId: s.projectId,
      invitedUserId: s.memberId,
      role: "viewer",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("project_invitations", id),
      s.memberId,
    );
    expect(view!.kind).toBe("project_invite");
    expect(view!.entityName).toBe(s.projectName);
    expect(view!.role).toBe("viewer");
  });

  it("a role upgrade carries the requester's own words", async () => {
    const s = await seedScene();
    const { id } = await roleUpgradeRequestsRepo.createPending({
      projectId: s.projectId,
      requesterUserId: s.memberId,
      requestedRole: "editor",
      message: "I keep needing to fix typos",
      expiresAt: IN_A_WEEK(),
    });
    // The OWNER decides a role upgrade, so the owner is the recipient here.
    const view = await decisionService.viewByToken(
      await tokenOf("role_upgrade_requests", id),
      s.ownerId,
    );
    expect(view!.kind).toBe("role_upgrade");
    expect(view!.entityName).toBe(s.projectName);
    expect(view!.role).toBe("editor");
    expect(view!.message).toBe("I keep needing to fix typos");
    expect(view!.isRecipient).toBe(true);
  });

  it("both transfers carry no role, because they always mean ownership", async () => {
    const s = await seedScene();
    const { id: pt } = await projectTransfersRepo.createPending({
      projectId: s.projectId,
      fromUserId: s.ownerId,
      toUserId: s.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const { id: st } = await studioTransfersRepo.createPending({
      studioId: s.studioId,
      fromUserId: s.ownerId,
      toUserId: s.memberId,
      expiresAt: IN_A_WEEK(),
    });

    const pv = await decisionService.viewByToken(
      await tokenOf("project_transfers", pt),
      s.memberId,
    );
    expect(pv!.kind).toBe("project_transfer");
    expect(pv!.entityName).toBe(s.projectName);
    expect(pv!.role).toBeNull();
    expect(pv!.isRecipient).toBe(true);

    const sv = await decisionService.viewByToken(
      await tokenOf("studio_transfers", st),
      s.memberId,
    );
    expect(sv!.kind).toBe("studio_transfer");
    expect(sv!.entityName).toBe(s.studioName);
    expect(sv!.role).toBeNull();
  });

  it("carries no ids and no slugs at all", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("studio_invitations", id),
      s.memberId,
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(s.studioId);
    expect(serialized).not.toContain(s.projectId);
    expect(serialized).not.toContain(s.ownerId);
    expect(serialized).not.toContain(s.memberId);
  });
});

describe("the view tells the four dead ends apart", () => {
  it("a token nobody issued is the only invalid link", async () => {
    const s = await seedScene();
    expect(await decisionService.viewByToken("f".repeat(64), s.memberId)).toBeNull();
  });

  it("an answered request says which way it was answered", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);

    await sql`UPDATE studio_invitations SET status = 'accepted' WHERE id = ${id}`;
    expect((await decisionService.viewByToken(token, s.memberId))!.state).toBe("accepted");

    await sql`UPDATE studio_invitations SET status = 'declined' WHERE id = ${id}`;
    expect((await decisionService.viewByToken(token, s.memberId))!.state).toBe("declined");
  });

  it("a withdrawn request says withdrawn, in either vocabulary", async () => {
    const s = await seedScene();
    const { id: inviteId } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const inviteToken = await tokenOf("studio_invitations", inviteId);
    // Invites say 'revoked'; the three #28 tables say 'cancelled'. Both mean
    // the same thing to the person holding the link.
    await sql`UPDATE studio_invitations SET status = 'revoked' WHERE id = ${inviteId}`;
    expect((await decisionService.viewByToken(inviteToken, s.memberId))!.state).toBe("revoked");

    const { id: transferId } = await studioTransfersRepo.createPending({
      studioId: s.studioId,
      fromUserId: s.ownerId,
      toUserId: s.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const transferToken = await tokenOf("studio_transfers", transferId);
    await sql`UPDATE studio_transfers SET status = 'cancelled' WHERE id = ${transferId}`;
    expect((await decisionService.viewByToken(transferToken, s.memberId))!.state).toBe("revoked");
  });

  it("timed out counts as expired whether or not the reaper has been by", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);

    // Reaper has not run: status is still 'pending', but the window closed.
    await sql`
      UPDATE studio_invitations SET expires_at = now() - interval '1 day' WHERE id = ${id}
    `;
    expect((await decisionService.viewByToken(token, s.memberId))!.state).toBe("expired");

    // Reaper has run.
    await sql`UPDATE studio_invitations SET status = 'expired' WHERE id = ${id}`;
    expect((await decisionService.viewByToken(token, s.memberId))!.state).toBe("expired");
  });

  it("a request that went away with its project reads gone, not invalid", async () => {
    const s = await seedScene();
    const { id: id } = await projectInvitationsRepo.createPending({
      projectId: s.projectId,
      invitedUserId: s.memberId,
      role: "viewer",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("project_invitations", id);
    await sql`UPDATE project_invitations SET deleted_at = now() WHERE id = ${id}`;

    const view = await decisionService.viewByToken(token, s.memberId);
    expect(view).not.toBeNull();
    expect(view!.state).toBe("gone");
  });
});

describe("already-a-member applies to invites only", () => {
  it("an invite that would still raise the recipient stays answerable", async () => {
    const s = await seedScene();
    // The reachable path this guards: a studio member opens a `studio`-visible
    // project from the studio list, which materializes a baseline `viewer` row
    // (`project.service.ts:loadForViewer`). Reading "already a member" off the
    // mere existence of a row would then kill a pending EDITOR invite — the
    // recipient never got what the invite offered, and could not ask again.
    const { id } = await projectInvitationsRepo.createPending({
      projectId: s.projectId,
      invitedUserId: s.memberId,
      role: "editor",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("project_invitations", id);
    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${s.projectId}, ${s.memberId}, 'viewer')
    `;
    const view = await decisionService.viewByToken(token, s.memberId);
    expect(view!.state).toBe("answerable");
  });

  it("an invite to somebody who already holds that role says so", async () => {
    const s = await seedScene();
    const { id } = await projectInvitationsRepo.createPending({
      projectId: s.projectId,
      invitedUserId: s.memberId,
      role: "viewer",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("project_invitations", id);
    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${s.projectId}, ${s.memberId}, 'editor')
    `;
    // Outranks what was offered, so the invite really is moot.
    const view = await decisionService.viewByToken(token, s.memberId);
    expect(view!.state).toBe("already_member");
  });

  it("points the recipient at the thing they are already in", async () => {
    const s = await seedScene();
    const { id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role, added_by)
      VALUES (${s.studioId}, ${s.memberId}, 'guest', ${s.ownerId})
    `;
    const [studio] = await sql<{ slug: string }[]>`
      SELECT slug FROM studios WHERE id = ${s.studioId}
    `;

    const mine = await decisionService.viewByToken(token, s.memberId);
    expect(mine!.state).toBe("already_member");
    expect(mine!.destination).toBe(`/studio/${studio!.slug}`);

    // The one field that names the entity, and only to somebody whose own
    // membership is what put this request in that state.
    const theirs = await decisionService.viewByToken(token, s.ownerId);
    expect(theirs!.state).toBe("already_member");
    expect(theirs!.destination).toBeNull();
  });

  it("never names the entity on a state that is still answerable", async () => {
    const s = await seedScene();
    const { id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("studio_invitations", id),
      s.memberId,
    );
    expect(view!.state).toBe("answerable");
    expect(view!.destination).toBeNull();
  });

  it("an invite to somebody already in says so instead of offering buttons", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);
    // Somebody added them directly while the invite sat there.
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role, added_by)
      VALUES (${s.studioId}, ${s.memberId}, 'maintainer', ${s.ownerId})
    `;
    expect((await decisionService.viewByToken(token, s.memberId))!.state).toBe("already_member");
  });

  it("a transfer to an existing member stays answerable", async () => {
    const s = await seedScene();
    // Transfers REQUIRE the recipient to be a member already, so the
    // already-member test must not be applied to them.
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role, added_by)
      VALUES (${s.studioId}, ${s.memberId}, 'maintainer', ${s.ownerId})
    `;
    const { id } = await studioTransfersRepo.createPending({
      studioId: s.studioId,
      fromUserId: s.ownerId,
      toUserId: s.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("studio_transfers", id),
      s.memberId,
    );
    expect(view!.state).toBe("answerable");
  });
});

describe("the window the card states is the request's own", () => {
  it("an old request keeps its own window after the knob changes", async () => {
    // The knob (`deferred_request_ttl_days`) can be turned; the window a
    // request HAD is a fact about its row. Reading the knob at view time made
    // every historical expired card change its story with the config — the
    // old spec accepted that drift on the premise that the expired card was
    // nearly unreachable, and this PR's permanent token made it fully reachable.
    const s = await seedScene();
    const { id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("studio_invitations", id);
    // A request filed under a 9-day knob, now past its deadline.
    await sql`
      UPDATE studio_invitations
      SET created_at = now() - interval '10 days',
          expires_at = now() - interval '1 day'
      WHERE id = ${id}
    `;

    const view = await decisionService.viewByToken(token, s.memberId);
    expect(view!.state).toBe("expired");
    // 9, from the row — not 7, from today's yaml.
    expect(view!.windowDays).toBe(9);
  });
});

describe("someone else's link", () => {
  it("shows the request but marks the viewer as not the recipient", async () => {
    const s = await seedScene();
    const { id: id } = await studioInvitationsRepo.createPending({
      studioId: s.studioId,
      invitedUserId: s.memberId,
      role: "guest",
      invitedBy: s.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const view = await decisionService.viewByToken(
      await tokenOf("studio_invitations", id),
      s.ownerId,
    );
    expect(view!.isRecipient).toBe(false);
    // Still answerable in itself — it is simply not this viewer's to answer.
    expect(view!.state).toBe("answerable");
  });
});
