// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lock order of every path that touches join requests — real Postgres.
 *
 * `deleteProject`, deciding a join request or a role upgrade, withdrawing a
 * join request or a role upgrade, accepting a transfer and removing a studio member each lock a
 * project's `projects` row before its request and member rows, so any two of
 * them queue instead of deadlocking. Deciding a join request also locks the requester's
 * studio membership before the project, so it never acts on a membership that a
 * concurrent removal is taking away.
 *
 * Each case parks one side at a chosen statement with a lock held from a
 * separate connection, then runs the other side, so the interleaving under test
 * is an observed fact rather than a hoped-for race.
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
import { ConflictError, initCore, NotFoundError } from "@breatic/core";
import * as joinService from "@server/modules/project-join-request/projectJoinRequest.service.js";
import * as decisionService from "@server/modules/decision/decision.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
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
    connection: { application_name: "project-join-lock-order-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Postgres' SQLSTATE for a deadlock it broke by aborting somebody. */
const DEADLOCK = "40P01";

/** Thrown inside a gate transaction to roll it back on purpose. */
class RollBack extends Error {}

/**
 * The SQLSTATE of a rejected query, walking drizzle's `cause` chain.
 * @param err - Whatever was thrown.
 * @returns The first SQLSTATE found, else null.
 */
function sqlStateOf(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") return null;
    if ("code" in current && typeof current.code === "string") return current.code;
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/**
 * Settle a call as soon as it starts, so a rejection that lands while the test
 * is still holding a gate is observed rather than reported as unhandled.
 * @param running - The call under test.
 * @returns How it ended.
 */
function track<T>(running: Promise<T>): Promise<PromiseSettledResult<T>> {
  return Promise.allSettled([running]).then(([outcome]) => outcome);
}

/**
 * Resolve once `running` has either finished or parked on a statement matching
 * `queryLike` — whichever the code under test does.
 * @param running - The call under test.
 * @param queryLike - Substrings of the statement it would park on.
 * @returns Which of the two happened.
 */
async function settledOrParked(
  running: Promise<unknown>,
  queryLike: readonly string[],
): Promise<"settled" | "parked"> {
  return Promise.race([
    running.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    waitUntilBlockedOn(sql, queryLike, 1).then(
      () => "parked" as const,
      () => "settled" as const,
    ),
  ]);
}

/**
 * Insert a user with a personal studio, so display names resolve.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`pjlo-${n}-${Date.now()}@example.com`}, true) RETURNING id
  `;
  const [personal] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`pjlo-user-${n}-${Date.now()}`}, 'personal', ${`User ${n}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${personal!.id}, ${user!.id}, 'admin')
  `;
  return user!.id;
}

/**
 * A team studio with an admin, a maintainer owning a project, a maintainer
 * editor on it (a transfer heir), and a maintainer with a pending join request.
 * @returns The ids the cases need.
 */
async function scene(): Promise<{
  studioId: string;
  studioSlug: string;
  adminId: string;
  ownerId: string;
  heirId: string;
  requesterId: string;
  projectId: string;
}> {
  const adminId = await insertUser();
  const ownerId = await insertUser();
  const heirId = await insertUser();
  const requesterId = await insertUser();
  const studioSlug = `pjlo-studio-${seq++}-${Date.now()}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${studioSlug}, 'team', 'Studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES
      (${studio!.id}, ${adminId}, 'admin'),
      (${studio!.id}, ${ownerId}, 'maintainer'),
      (${studio!.id}, ${heirId}, 'maintainer'),
      (${studio!.id}, ${requesterId}, 'maintainer')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${ownerId}, 'Project', ${`pjlo-p-${seq++}-${Date.now()}`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES
      (${project!.id}, ${ownerId}, 'owner', null),
      (${project!.id}, ${heirId}, 'editor', ${ownerId})
  `;
  return {
    studioId: studio!.id,
    studioSlug,
    adminId,
    ownerId,
    heirId,
    requesterId,
    projectId: project!.id,
  };
}

/**
 * The pending request of a requester, with the recipient of its bell entry.
 * @param projectId - The project.
 * @param requesterId - The requester.
 * @returns Its status, token and the bell's recipient and read state.
 */
async function requestOf(
  projectId: string,
  requesterId: string,
): Promise<{ status: string; share_token: string; bell_user: string | null; bell_read: boolean | null }> {
  const [row] = await sql<
    { status: string; share_token: string; bell_user: string | null; bell_read: boolean | null }[]
  >`
    SELECT r.status, r.share_token, n.user_id AS bell_user, n.read_at IS NOT NULL AS bell_read
    FROM project_join_requests r
    LEFT JOIN notifications n ON n.id = r.notification_id
    WHERE r.project_id = ${projectId} AND r.requester_user_id = ${requesterId}
    ORDER BY r.created_at DESC LIMIT 1
  `;
  if (!row) throw new Error("no join request row");
  return row;
}

/**
 * Play `deleteProject`'s first two steps from a separate connection — lock the
 * project, sweep its join requests — then start `other`, and once `other` has
 * parked, play the step that closes a cycle with a path in the wrong order.
 * @param projectId - The project being deleted.
 * @param other - The concurrent call under test.
 * @param closingStep - The cascade's later statement.
 * @param parkedOn - Substrings of the statement `other` parks on; empty for any.
 * @returns What each side threw, if anything.
 */
async function againstDelete(
  projectId: string,
  other: () => Promise<unknown>,
  closingStep: (c: postgres.TransactionSql) => Promise<unknown>,
  parkedOn: readonly string[],
): Promise<{ sweepError: unknown; otherError: unknown }> {
  const cascade = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  let sweepError: unknown = null;
  let running: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    await cascade.begin(async (c) => {
      await c`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      await c`
        UPDATE project_join_requests SET deleted_at = now()
        WHERE project_id = ${projectId} AND deleted_at IS NULL
      `;
      running = track(other());
      await waitUntilBlockedOn(sql, parkedOn, 1);
      try {
        await closingStep(c);
      } catch (err) {
        sweepError = err;
      }
    });
  } catch (err) {
    sweepError ??= err;
  } finally {
    await cascade.end({ timeout: 5 });
  }
  const settled = await running!;
  return { sweepError, otherError: settled.status === "rejected" ? settled.reason : null };
}

describe("deciding a request against removing the requester from the studio", () => {
  it("an approval racing the requester's removal leaves them with no seat on the project", async () => {
    const s = await scene();
    await joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId });
    const [pending] = await sql<{ share_token: string; notification_id: string }[]>`
      SELECT share_token, notification_id FROM project_join_requests
      WHERE project_id = ${s.projectId} AND requester_user_id = ${s.requesterId}
    `;

    // Holding the owner's bell entry parks the approval on retiring it, after
    // the member row is written and before the transaction commits.
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let approving: Promise<PromiseSettledResult<unknown>> | undefined;
    let removing: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await gate
        .begin(async (g) => {
          await g`SELECT id FROM notifications WHERE id = ${pending!.notification_id} FOR UPDATE`;
          approving = track(decisionService.respond(pending!.share_token, s.ownerId, "confirm"));
          await waitUntilBlockedOn(sql, ["update", "notifications"], 1);
          removing = track(studioMemberService.removeMember(s.studioSlug, s.requesterId));
          await settledOrParked(removing, ["studio_members", "for update"]);
          throw new RollBack();
        })
        .catch((err: unknown) => {
          if (!(err instanceof RollBack)) throw err;
        });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const [approved] = await Promise.all([approving!, removing!]);
    expect(approved.status).toBe("fulfilled");

    const [seat] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_members
      WHERE project_id = ${s.projectId} AND user_id = ${s.requesterId} AND deleted_at IS NULL
    `;
    const [inStudio] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_members
      WHERE studio_id = ${s.studioId} AND user_id = ${s.requesterId} AND deleted_at IS NULL
    `;
    expect(inStudio!.n).toBe(0);
    expect(seat!.n).toBe(0);
  });
});

describe("removing the requester before the approval reaches them", () => {
  it("the approval waits for the removal and refuses", async () => {
    const s = await scene();
    await joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId });
    const [pending] = await sql<{ share_token: string }[]>`
      SELECT share_token FROM project_join_requests
      WHERE project_id = ${s.projectId} AND requester_user_id = ${s.requesterId}
    `;
    // The requester is also a viewer on a second project; holding that member
    // row parks the removal on its member sweep, after it has locked the
    // studio's membership.
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug)
      VALUES (${s.studioId}, ${s.ownerId}, 'Other', ${`pjlo-q-${seq++}-${Date.now()}`}) RETURNING id
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by) VALUES
        (${other!.id}, ${s.ownerId}, 'owner', null),
        (${other!.id}, ${s.requesterId}, 'viewer', ${s.ownerId})
    `;

    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let removing: Promise<PromiseSettledResult<unknown>> | undefined;
    let approving: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await gate
        .begin(async (g) => {
          await g`
            SELECT user_id FROM project_members
            WHERE project_id = ${other!.id} AND user_id = ${s.requesterId} FOR UPDATE
          `;
          removing = track(studioMemberService.removeMember(s.studioSlug, s.requesterId));
          await waitUntilBlockedOn(sql, ["update", "project_members"], 1);
          approving = track(decisionService.respond(pending!.share_token, s.ownerId, "confirm"));
          await settledOrParked(approving, ["studio_members", "for update"]);
          throw new RollBack();
        })
        .catch((err: unknown) => {
          if (!(err instanceof RollBack)) throw err;
        });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const [removed, approved] = await Promise.all([removing!, approving!]);
    expect(removed.status).toBe("fulfilled");
    expect(approved.status === "rejected" ? approved.reason : null).toBeInstanceOf(ConflictError);

    const [seat] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_members
      WHERE project_id = ${s.projectId} AND user_id = ${s.requesterId} AND deleted_at IS NULL
    `;
    expect(seat!.n).toBe(0);
  });
});

describe("a role upgrade decision against an owner change", () => {
  it("approving an upgrade while its requester accepts the project does not deadlock", async () => {
    const s = await scene();
    const viewerId = s.requesterId;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${s.projectId}, ${viewerId}, 'viewer', ${s.ownerId})
    `;
    const { requestId } = await roleUpgradeService.request({
      requesterUserId: viewerId,
      projectId: s.projectId,
      projectName: "Project",
    });
    await projectTransferService.requestProjectTransfer(s.projectId, s.ownerId, viewerId);
    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM project_transfers WHERE project_id = ${s.projectId} AND status = 'pending'
    `;

    // Holding the project row lines both up behind it, the accept first.
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let accepting: Promise<PromiseSettledResult<unknown>> | undefined;
    let approving: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM projects WHERE id = ${s.projectId} FOR UPDATE`;
        accepting = track(projectTransferService.confirmProjectTransfer(offer!.id, viewerId));
        await waitUntilBlockedOn(sql, ["projects", "for update"], 1);
        approving = track(roleUpgradeService.approve({ requestId, ownerUserId: s.ownerId }));
        await waitUntilBlockedOn(sql, [], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const [accepted, approved] = await Promise.all([accepting!, approving!]);

    expect(accepted.status).toBe("fulfilled");
    // The requester now owns the project, so accepting settled their own
    // request; the approval that queued behind it finds it already handled.
    expect(approved.status === "rejected" ? approved.reason : null).toBeInstanceOf(ConflictError);
    const [upgrade] = await sql<{ status: string }[]>`
      SELECT status FROM role_upgrade_requests WHERE id = ${requestId}
    `;
    expect(upgrade!.status).toBe("expired");
    const [owner] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM project_members
      WHERE project_id = ${s.projectId} AND role = 'owner' AND deleted_at IS NULL
    `;
    expect(owner!.user_id).toBe(viewerId);
  });
});

describe("withdrawing a request against an owner change", () => {
  it("does not deadlock and leaves no bell entry for a withdrawn request", async () => {
    const s = await scene();
    await joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId });
    const [pending] = await sql<{ notification_id: string }[]>`
      SELECT notification_id FROM project_join_requests
      WHERE project_id = ${s.projectId} AND requester_user_id = ${s.requesterId}
    `;
    await projectTransferService.requestProjectTransfer(s.projectId, s.ownerId, s.heirId);
    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM project_transfers WHERE project_id = ${s.projectId} AND status = 'pending'
    `;

    // Holding the owner's bell entry parks the accept where it moves the
    // request to the new owner, with the project already locked.
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let accepting: Promise<PromiseSettledResult<unknown>> | undefined;
    let withdrawing: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM notifications WHERE id = ${pending!.notification_id} FOR UPDATE`;
        accepting = track(projectTransferService.confirmProjectTransfer(offer!.id, s.heirId));
        await waitUntilBlockedOn(sql, ["update", "notifications"], 1);
        withdrawing = track(joinService.cancelMine(s.projectId, s.requesterId));
        await waitUntilBlockedOn(sql, [], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const [accepted, withdrawn] = await Promise.all([accepting!, withdrawing!]);

    expect(accepted.status).toBe("fulfilled");
    expect(withdrawn.status).toBe("fulfilled");
    expect(await requestOf(s.projectId, s.requesterId)).toMatchObject({
      status: "cancelled",
      bell_user: s.heirId,
      bell_read: true,
    });
    const [open] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications
      WHERE project_id = ${s.projectId} AND type = 'project.join_request'
        AND read_at IS NULL AND deleted_at IS NULL
    `;
    expect(open!.n).toBe(0);
  });
});

describe("an owner change against a project delete", () => {
  it("accepting a transfer while the project is being deleted does not deadlock", async () => {
    const s = await scene();
    await joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId });
    await projectTransferService.requestProjectTransfer(s.projectId, s.ownerId, s.heirId);
    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM project_transfers WHERE project_id = ${s.projectId} AND status = 'pending'
    `;

    const { sweepError, otherError } = await againstDelete(
      s.projectId,
      () => projectTransferService.confirmProjectTransfer(offer!.id, s.heirId),
      (c) => c`
        UPDATE project_transfers SET deleted_at = now()
        WHERE project_id = ${s.projectId} AND deleted_at IS NULL
      `,
      [],
    );

    expect(sqlStateOf(sweepError)).not.toBe(DEADLOCK);
    expect(sqlStateOf(otherError)).not.toBe(DEADLOCK);
    expect(sweepError).toBeNull();
    // The offer went with the project, so the accept finds nothing to answer.
    expect(otherError).toBeInstanceOf(NotFoundError);
  });

  it("removing the owner from the studio while the project is being deleted does not deadlock", async () => {
    const s = await scene();
    await joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId });

    const { sweepError, otherError } = await againstDelete(
      s.projectId,
      () => studioMemberService.removeMember(s.studioSlug, s.ownerId),
      (c) => c`
        UPDATE project_members SET deleted_at = now()
        WHERE project_id = ${s.projectId} AND deleted_at IS NULL
      `,
      [],
    );

    expect(sqlStateOf(sweepError)).not.toBe(DEADLOCK);
    expect(sqlStateOf(otherError)).not.toBe(DEADLOCK);
    expect(sweepError).toBeNull();
    expect(otherError).toBeNull();
  });
});

describe("a request filed while the project changes owner", () => {
  it("lands in the new owner's bell", async () => {
    const s = await scene();
    await projectTransferService.requestProjectTransfer(s.projectId, s.ownerId, s.heirId);
    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM project_transfers WHERE project_id = ${s.projectId} AND status = 'pending'
    `;

    // A timed-out request of the same requester, held from another
    // connection, parks the filing where it expires stale rows — after it has
    // read who the owner is.
    const [stale] = await sql<{ id: string }[]>`
      INSERT INTO project_join_requests
        (project_id, requester_user_id, status, expires_at, share_token)
      VALUES (${s.projectId}, ${s.requesterId}, 'pending', now() - interval '1 hour',
              ${`pjlo-stale-${seq++}-${Date.now()}`})
      RETURNING id
    `;
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let filing: Promise<PromiseSettledResult<unknown>> | undefined;
    let transferring: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await gate
        .begin(async (g) => {
          await g`SELECT id FROM project_join_requests WHERE id = ${stale!.id} FOR UPDATE`;
          filing = track(joinService.request({ projectId: s.projectId, requesterUserId: s.requesterId }));
          await waitUntilBlockedOn(sql, ["update", "project_join_requests"], 1);
          transferring = track(projectTransferService.confirmProjectTransfer(offer!.id, s.heirId));
          await settledOrParked(transferring, ["projects", "for update"]);
          throw new RollBack();
        })
        .catch((err: unknown) => {
          if (!(err instanceof RollBack)) throw err;
        });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const [filed, transferred] = await Promise.all([filing!, transferring!]);
    expect(filed.status).toBe("fulfilled");
    expect(transferred.status).toBe("fulfilled");

    expect(await requestOf(s.projectId, s.requesterId)).toMatchObject({
      status: "pending",
      bell_user: s.heirId,
      bell_read: false,
    });
  });
});
