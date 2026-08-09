// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a REFUSED decision leaves behind, for all three deferred-request flows.
 *
 * The gates themselves are easy to get right and easy to test. The part that
 * silently rots is what happens to the row afterwards, and it splits two ways:
 *
 *   - a request that has genuinely stopped being answerable (timed out, or its
 *     premise gone) must be pushed to a terminal status and have its bell entry
 *     retired — nothing else will ever do it, since "expired" is by definition
 *     the case where nobody came;
 *   - a request refused because the CALLER lacks standing must be left exactly
 *     as it was, because it is still perfectly valid for whoever does.
 *
 * Get the first wrong and the row sits `pending` forever holding a uniqueness
 * slot that, for a transfer, is the entire container: nobody can ever transfer
 * that project again. Get the second wrong and one stranger's click burns a
 * request the rightful decider never saw.
 *
 * Both need a real Postgres, and specifically a real TRANSACTION: the failure
 * paths write and then refuse, so a service that writes inside the transaction
 * it is about to abort passes every mock-based test while persisting nothing.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// These suites never reach a model, so `ai` is stubbed to keep the SDK out
// of their module graph. It used to say the stub was load-bearing — that
// `ai` pulled in @opentelemetry/api, whose ESM build Node rejects. AI SDK 7
// does not depend on that package at all (v6 did), both versions import
// cleanly under Node ESM, and one suite passed with the stub removed. So
// this is a choice, not a necessity.
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

// The setup file only puts the container URLs on `process.env`; handing them to
// core is each test's own job, since the setup file cannot import core.
initCore(process.env);

import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "deferred-lifecycle-test-driver" },
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
}

/**
 * A team studio with an admin/owner and one maintainer who also collaborates
 * on the studio's project — the minimum shape all three flows need.
 * @returns The seeded ids.
 */
async function seedScene(): Promise<Scene> {
  const tag = `dl-${seq++}`;
  const [owner, member] = await Promise.all([
    insertUser(`${tag}-owner`),
    insertUser(`${tag}-member`),
  ]);
  const slug = `${tag}-studio`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner}, ${slug}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role, added_by)
    VALUES (${studio!.id}, ${owner}, 'admin', ${owner}),
           (${studio!.id}, ${member}, 'maintainer', ${owner})
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner}, 'owner', ${owner}),
           (${project!.id}, ${member}, 'viewer', ${owner})
  `;
  return {
    ownerId: owner,
    memberId: member,
    studioId: studio!.id,
    studioSlug: slug,
    projectId: project!.id,
  };
}

/**
 * Insert a user and return its id.
 * @param tag - Unique-ish fragment for the email.
 * @returns The new user's id.
 */
async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/**
 * Read a request row's status and whether its bell entry is still unread.
 * @param table - Request table name.
 * @param id - Request id.
 * @returns The status and the bell entry's read state.
 */
async function stateOf(
  table: string,
  id: string,
): Promise<{ status: string; bellUnread: boolean }> {
  const rows = await sql<{ status: string; notification_id: string | null }[]>`
    SELECT status, notification_id FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0]!;
  if (row.notification_id === null) {
    return { status: row.status, bellUnread: false };
  }
  const notices = await sql<{ read_at: Date | null }[]>`
    SELECT read_at FROM notifications WHERE id = ${row.notification_id}
  `;
  return { status: row.status, bellUnread: notices[0]?.read_at == null };
}

/**
 * Age a request and its bell entry past their deadline, the way the clock
 * would. Both move together because the create path writes them together.
 * @param table - Request table name.
 * @param id - Request id.
 */
async function ageOut(table: string, id: string): Promise<void> {
  await sql`
    UPDATE ${sql(table)} SET expires_at = now() - interval '1 hour'
    WHERE id = ${id}
  `;
  await sql`
    UPDATE notifications SET expires_at = now() - interval '1 hour'
    WHERE id = (SELECT notification_id FROM ${sql(table)} WHERE id = ${id})
  `;
}

/**
 * The id of the single live request on a container / for a requester.
 * @param table - Request table name.
 * @param column - The container or requester column to match on.
 * @param value - Its value.
 * @returns The request id.
 */
async function liveRequestId(
  table: string,
  column: string,
  value: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM ${sql(table)}
    WHERE ${sql(column)} = ${value} AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]!.id;
}

describe("a timed-out request is written down by the decision that meets it", () => {
  it("role upgrade: the row lands `expired` and the bell entry is retired", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );
    await ageOut("role_upgrade_requests", requestId);

    await expect(
      roleUpgradeService.approve({ requestId, ownerUserId: ownerId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Nothing else will ever do this. Left `pending`, the row holds this
    // requester's slot for good and the dead bell entry keeps its buttons.
    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("project transfer: the row lands `expired` and the bell entry is retired", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );
    await ageOut("project_transfers", transferId);

    await expect(
      projectTransferService.confirmProjectTransfer(transferId, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    // For a transfer the stranded slot is the whole project: left `pending`,
    // this project could never be transferred again.
    expect(await stateOf("project_transfers", transferId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("studio transfer: the row lands `expired` and the bell entry is retired", async () => {
    const { ownerId, memberId, studioId, studioSlug } = await seedScene();
    await studioTransferService.requestTransfer(studioSlug, ownerId, memberId);
    const transferId = await liveRequestId(
      "studio_transfers",
      "studio_id",
      studioId,
    );
    await ageOut("studio_transfers", transferId);

    await expect(
      studioTransferService.confirmTransfer(transferId, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await stateOf("studio_transfers", transferId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });
});

describe("a request whose premise is gone is written down too", () => {
  it("role upgrade: approving someone who became an editor retires the request", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );
    // Promoted by another route while the request waited: there is nothing
    // left to grant.
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${memberId}
    `;

    await expect(
      roleUpgradeService.approve({ requestId, ownerUserId: ownerId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("role upgrade: rejecting someone who became an editor retires it as well", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${memberId}
    `;

    await expect(
      roleUpgradeService.reject({ requestId, ownerUserId: ownerId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("project transfer: a recipient demoted to studio guest retires the offer", async () => {
    const { ownerId, memberId, studioId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );
    // Ownership must not leave the studio to a guest — and the offer that
    // proposed it is now dead, not merely refused.
    await sql`
      UPDATE studio_members SET role = 'guest'
      WHERE studio_id = ${studioId} AND user_id = ${memberId}
    `;

    await expect(
      projectTransferService.confirmProjectTransfer(transferId, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await stateOf("project_transfers", transferId)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });
});

describe("a request cannot be filed onto a project that is being deleted", () => {
  it("role upgrade: filing after the delete is refused, not orphaned", async () => {
    // The window this closes: the insert's own foreign key takes only
    // FOR KEY SHARE, which does not conflict with the delete's FOR NO KEY
    // UPDATE, so without an explicit lock the two transactions run past each
    // other and the cascade cannot see the uncommitted row. What commits is a
    // live pending request on a dead project — undecidable, unreapable, and
    // holding its slot forever.
    const { ownerId, memberId, projectId } = await seedScene();
    await projectRepo.deleteProject(projectId);

    await expect(
      roleUpgradeService.request({
        ownerUserId: ownerId,
        requesterUserId: memberId,
        projectId,
        projectName: "Demo",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM role_upgrade_requests
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `;
    expect(rows[0]!.c).toBe(0);
  });

  it("project transfer: offering after the delete is refused, not orphaned", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectRepo.deleteProject(projectId);

    await expect(
      projectTransferService.requestProjectTransfer(
        projectId,
        ownerId,
        memberId,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("a decision is credited only to someone who still holds the project", () => {
  it("reject: a caller who lost the project settles nothing", async () => {
    // The same window approve was hardened against. It lives in `settle` now
    // rather than in each caller, because a rule every caller has to remember
    // is one that reject forgot for a whole round.
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );

    const third = await insertUser(`dl-newowner2-${seq++}`);
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${ownerId}
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${third}, 'owner', ${ownerId})
    `;

    await expect(
      roleUpgradeService.reject({ requestId, ownerUserId: ownerId }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
  });
});

describe("a deleted project takes its outstanding requests with it", () => {
  it("role upgrade: the request does not outlive the project", async () => {
    // Left behind it is both undecidable and unkillable: every decision path
    // resolves the caller's role through a join that filters deleted projects,
    // so it answers 403 forever and deliberately leaves the row pending; the
    // reaper only runs from a new request, which needs a live project. The row
    // would hold its slot permanently and its restrict FK would block any
    // future hard delete.
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );

    await projectRepo.deleteProject(projectId);

    const rows = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM role_upgrade_requests WHERE id = ${requestId}
    `;
    expect(rows[0]!.deleted_at).not.toBeNull();
    // And the announcement comes down with it. The unread query hides an entry
    // only once its own deadline passes, so a week-long request would otherwise
    // leave Approve and Reject standing over a row that now answers 404.
    expect((await stateOf("role_upgrade_requests", requestId)).bellUnread).toBe(
      false,
    );
  });

  it("project transfer: the offer does not outlive the project", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );

    await projectRepo.deleteProject(projectId);

    const rows = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM project_transfers WHERE id = ${transferId}
    `;
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect((await stateOf("project_transfers", transferId)).bellUnread).toBe(
      false,
    );
  });
});

describe("reaping takes the bell entry down with the row", () => {
  it("role upgrade: the reaped request's entry does not outlive it", async () => {
    // The reaper is the one settle path that runs inside a repo, which cannot
    // write another module's table — so the entry comes back up to the service
    // to be retired. Miss that and the invariant "a settled request has no live
    // bell entry" rests on an unrelated filter in the unread query, and leaks
    // through every read that does not apply it.
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const first = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );
    await ageOut("role_upgrade_requests", first);

    // Filing again is what reaps the old row.
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });

    expect(await stateOf("role_upgrade_requests", first)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("studio transfer: the reaped offer's entry does not outlive it", async () => {
    const { ownerId, memberId, studioId, studioSlug } = await seedScene();
    await studioTransferService.requestTransfer(studioSlug, ownerId, memberId);
    const first = await liveRequestId(
      "studio_transfers",
      "studio_id",
      studioId,
    );
    await ageOut("studio_transfers", first);

    await studioTransferService.requestTransfer(studioSlug, ownerId, memberId);

    expect(await stateOf("studio_transfers", first)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });

  it("project transfer: the reaped offer's entry does not outlive it", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const first = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );
    await ageOut("project_transfers", first);

    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );

    expect(await stateOf("project_transfers", first)).toEqual({
      status: "expired",
      bellUnread: false,
    });
  });
});

describe("a request refused for lack of standing is left alone", () => {
  it("role upgrade: a non-owner's attempt changes nothing about the request", async () => {
    // Their lack of authority says nothing about the request, which the real
    // owner can still answer. Settling it here would let any stranger burn it.
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );

    await expect(
      roleUpgradeService.approve({ requestId, ownerUserId: memberId }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
    // And the rightful owner can still answer it.
    await roleUpgradeService.approve({ requestId, ownerUserId: ownerId });
    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "approved",
      bellUnread: false,
    });
  });

  it("project transfer: someone who is not the recipient cannot touch the offer", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );

    // The offer names its recipient; holding the id is not standing. Before
    // the offer had a row of its own this was implicit in the bell entry's
    // ownership, and moving it to a table is exactly where such a guard gets
    // lost.
    await expect(
      projectTransferService.confirmProjectTransfer(transferId, ownerId),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await stateOf("project_transfers", transferId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
  });

  it("studio transfer: someone who is not the recipient cannot touch the offer", async () => {
    const { ownerId, memberId, studioId, studioSlug } = await seedScene();
    await studioTransferService.requestTransfer(studioSlug, ownerId, memberId);
    const transferId = await liveRequestId(
      "studio_transfers",
      "studio_id",
      studioId,
    );

    await expect(
      studioTransferService.confirmTransfer(transferId, ownerId),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await stateOf("studio_transfers", transferId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
  });
});

describe("a decider who loses the project mid-decision destroys nothing", () => {
  it("role upgrade: the request survives for whoever owns it now", async () => {
    // The conditional write refuses for two different reasons — the requester's
    // role moved, or the decider stopped being the owner — and only the first
    // means the request is over. Conflating them lets a caller who is no longer
    // entitled to decide write off a request the NEW owner never gets to see.
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const requestId = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );

    // The project changes hands between the gate and the write. Reproduced by
    // demoting the decider directly: the conditional write's EXISTS is what
    // notices, and it notices the same way either way.
    const third = await insertUser(`dl-newowner-${seq++}`);
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${ownerId}
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${third}, 'owner', ${ownerId})
    `;

    await expect(
      roleUpgradeService.approve({ requestId, ownerUserId: ownerId }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await stateOf("role_upgrade_requests", requestId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
    // And the new owner can answer it.
    await roleUpgradeService.approve({ requestId, ownerUserId: third });
    expect((await stateOf("role_upgrade_requests", requestId)).status).toBe(
      "approved",
    );
  });
});

describe("withdrawing frees the container's slot at once", () => {
  it("project transfer: the current owner can withdraw and offer again", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      projectId,
    );

    await projectTransferService.withdrawProjectTransfer(transferId, projectId);

    expect(await stateOf("project_transfers", transferId)).toEqual({
      status: "cancelled",
      bellUnread: false,
    });
    // The escape hatch is only real if a fresh offer can follow immediately.
    await expect(
      projectTransferService.requestProjectTransfer(
        projectId,
        ownerId,
        memberId,
      ),
    ).resolves.toBeUndefined();
  });

  it("studio transfer: the current admin can withdraw and offer again", async () => {
    const { ownerId, memberId, studioId, studioSlug } = await seedScene();
    await studioTransferService.requestTransfer(studioSlug, ownerId, memberId);
    const transferId = await liveRequestId(
      "studio_transfers",
      "studio_id",
      studioId,
    );

    await studioTransferService.withdrawTransfer(transferId, studioSlug);

    expect(await stateOf("studio_transfers", transferId)).toEqual({
      status: "cancelled",
      bellUnread: false,
    });
    await expect(
      studioTransferService.requestTransfer(studioSlug, ownerId, memberId),
    ).resolves.toBeUndefined();
  });

  it("project transfer: a withdrawal aimed at another project does nothing", async () => {
    const mine = await seedScene();
    const theirs = await seedScene();
    await projectTransferService.requestProjectTransfer(
      theirs.projectId,
      theirs.ownerId,
      theirs.memberId,
    );
    const transferId = await liveRequestId(
      "project_transfers",
      "project_id",
      theirs.projectId,
    );

    await expect(
      projectTransferService.withdrawProjectTransfer(
        transferId,
        mine.projectId,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await stateOf("project_transfers", transferId)).toEqual({
      status: "pending",
      bellUnread: true,
    });
  });
});

describe("one live request at a time, and a dead one never blocks", () => {
  it("role upgrade: a second live request is refused, a timed-out one is reaped", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    await roleUpgradeService.request({
      ownerUserId: ownerId,
      requesterUserId: memberId,
      projectId,
      projectName: "Demo",
    });
    const first = await liveRequestId(
      "role_upgrade_requests",
      "project_id",
      projectId,
    );

    await expect(
      roleUpgradeService.request({
        ownerUserId: ownerId,
        requesterUserId: memberId,
        projectId,
        projectName: "Demo",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Once it times out the requester is not held hostage by their own silence.
    await ageOut("role_upgrade_requests", first);
    await expect(
      roleUpgradeService.request({
        ownerUserId: ownerId,
        requesterUserId: memberId,
        projectId,
        projectName: "Demo",
      }),
    ).resolves.toBeTruthy();
    expect((await stateOf("role_upgrade_requests", first)).status).toBe(
      "expired",
    );
  });

  it("project transfer: a second live offer is refused even to another person", async () => {
    const { ownerId, memberId, projectId } = await seedScene();
    const third = await insertUser(`dl-third-${seq++}`);
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${third}, 'viewer', ${ownerId})
    `;
    const [studioRow] = await sql<{ studio_id: string }[]>`
      SELECT studio_id FROM projects WHERE id = ${projectId}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role, added_by)
      VALUES (${studioRow!.studio_id}, ${third}, 'maintainer', ${ownerId})
    `;
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      memberId,
    );

    // A project has one owner, so the slot is the project — not the pair.
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, third),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
