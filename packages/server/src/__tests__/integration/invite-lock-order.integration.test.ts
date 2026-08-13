// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The order in which the project-invite paths take their two locks — real
 * Postgres.
 *
 * Every path that files a project-scoped REQUEST row (invite, transfer offer,
 * role-upgrade request) takes the `projects` row lock, and `deleteProject`
 * takes it FIRST and only then sweeps those tables (`project.repo.ts`, the
 * comment there says "Taken FIRST"). Membership rows are not in that set:
 * `materializeBaselineViewer` writes one with no lock and no transaction at
 * all, and racing the cascade there is a separate, pre-existing gap. Any path
 * that takes these two the other way round closes an AB/BA cycle: Postgres notices
 * after `deadlock_timeout` and aborts one side with 40P01, which is neither an
 * `AppError` nor an `HTTPException` and therefore surfaces as a 500 to whoever
 * lost.
 *
 * `createInvite` used to be that path. Its transaction opened with
 * `expireStalePending` — an `UPDATE project_invitations` that takes a row lock
 * on any timed-out invite for this (project, invitee) — and only afterwards
 * asked for the `projects` row. The window is not microseconds wide: it lasts
 * as long as the delete cascade holds its lock.
 *
 * The case below drives that cycle deliberately rather than hoping for it: a
 * separate connection plays the delete cascade's two steps by hand, and the
 * probe turns "the invite is now parked on the projects row" into an observed
 * fact. With the old order the second step deadlocks; with the lock taken
 * first it goes through.
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
import { initCore, loadLocales } from "@breatic/core";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "invite-lock-order-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * A studio with an admin, a project in it, and a registered invitee who already
 * has a timed-out pending invite to that project.
 *
 * The stale invite is what makes `expireStalePending` actually write: without a
 * matching row it takes no lock at all and the ordering question never arises.
 * @returns The ids the case needs.
 */
async function seedStaleInvite(): Promise<{
  projectId: string;
  adminId: string;
  inviteeEmail: string;
}> {
  const tag = `ilo-${seq++}`;
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`${tag}-a@example.test`}, true, 'pro') RETURNING id
  `;
  const [invitee] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-i@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin!.id}, ${`${tag}-s`}, 'team', 'Studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${admin!.id}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${admin!.id}, 'Project', ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${project!.id}, ${admin!.id}, 'owner')
  `;
  // Timed out an hour ago: still `pending`, so `expireStalePending` matches it.
  await sql`
    INSERT INTO project_invitations
      (project_id, invited_user_id, role, invited_by, status, expires_at, share_token)
    VALUES (${project!.id}, ${invitee!.id}, 'viewer', ${admin!.id}, 'pending',
            now() - interval '1 hour', ${`${tag}-token`})
  `;
  return {
    projectId: project!.id,
    adminId: admin!.id,
    inviteeEmail: `${tag}-i@example.test`,
  };
}

/**
 * A live pending studio invite, and the studio it belongs to.
 * @returns The ids the confirm case needs.
 */
async function seedStudioInvite(): Promise<{
  studioId: string;
  invitationId: string;
  inviteeId: string;
}> {
  const tag = `ilo-s-${seq++}`;
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`${tag}-a@example.test`}, true, 'pro') RETURNING id
  `;
  const [invitee] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-i@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin!.id}, ${`${tag}-s`}, 'team', 'Studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${admin!.id}, 'admin')
  `;
  const [invite] = await sql<{ id: string }[]>`
    INSERT INTO studio_invitations
      (studio_id, invited_user_id, role, invited_by, status, expires_at, share_token)
    VALUES (${studio!.id}, ${invitee!.id}, 'guest', ${admin!.id}, 'pending',
            now() + interval '7 days', ${`${tag}-token`})
    RETURNING id
  `;
  return {
    studioId: studio!.id,
    invitationId: invite!.id,
    inviteeId: invitee!.id,
  };
}

/**
 * Whether somebody else currently holds that entity row's lock.
 *
 * `NOWAIT` is what makes this answerable at all: a plain `FOR UPDATE` would
 * join the queue and the test would learn nothing until the holder left.
 * @param table - `studios` or `projects`.
 * @param rowId - Which row.
 * @returns True when the row is already locked by another transaction.
 */
async function rowIsLockedByAnother(
  table: "studios" | "projects",
  rowId: string,
): Promise<boolean> {
  const probe = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  try {
    await probe.begin(async (p) => {
      await p`SELECT id FROM ${p(table)} WHERE id = ${rowId} FOR UPDATE NOWAIT`;
    });
    return false;
  } catch (err) {
    // 55P03 is "lock_not_available", which NOWAIT raises instead of waiting.
    if (sqlStateOf(err) === "55P03") return true;
    throw err;
  } finally {
    await probe.end({ timeout: 5 });
  }
}

/**
 * The SQLSTATE of a rejected query, when it has one.
 *
 * Both sides are asked for it rather than just the sweep: which transaction
 * Postgres aborts to break a cycle is its own choice, so pinning only one of
 * them would pass whenever it happened to pick the other.
 *
 * The chain is walked rather than the top level read, for the reason
 * `utils/pg-error.ts` already documents: a query made through drizzle arrives
 * as a `DrizzleQueryError` whose own `code` is undefined and whose SQLSTATE
 * sits on `.cause`. Measured here — under a real deadlock the invite side
 * rejected with `code=undefined, cause.code=40P01`, so a flat check reported
 * null and the assertion below passed while the deadlock was happening.
 * @param err - Whatever was thrown or rejected with.
 * @returns The first SQLSTATE found on the error or its causes, else null.
 */
function sqlStateOf(err: unknown): string | null {
  let current: unknown = err;
  // Bounded so a cyclic cause chain cannot spin here.
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") return null;
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/** Postgres' SQLSTATE for a deadlock it broke by aborting somebody. */
const DEADLOCK = "40P01";

describe("project invite — lock order against the delete cascade", () => {
  it("re-inviting does not deadlock with a delete that already holds the project row", async () => {
    const { projectId, adminId, inviteeEmail } = await seedStaleInvite();

    // This connection plays `deleteProject`: the projects row first…
    const cascade = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let sweepError: unknown = null;
    let invite: Promise<unknown>;
    try {
      await cascade.begin(async (c) => {
        await c`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;

        // …while a re-invite for the same (project, invitee) starts up. It has
        // a stale pending row to expire and a project row to lock; only one
        // order of those two survives what happens next.
        invite = projectInviteService.createInvite(
          projectId,
          adminId,
          inviteeEmail,
          "viewer",
        );
        await waitUntilBlockedOn(sql, ["projects", "for update"], 1);

        // …and the cascade's second step: sweep this project's invitations.
        // With the invite holding the stale row's lock this closes the cycle.
        try {
          await c`
            UPDATE project_invitations SET deleted_at = now()
            WHERE project_id = ${projectId} AND deleted_at IS NULL
          `;
        } catch (err) {
          sweepError = err;
        }
      });
    } finally {
      await cascade.end({ timeout: 5 });
    }
    const [settled] = await Promise.allSettled([invite!]);
    const inviteError = settled.status === "rejected" ? settled.reason : null;

    expect(sqlStateOf(sweepError)).not.toBe(DEADLOCK);
    expect(sqlStateOf(inviteError)).not.toBe(DEADLOCK);
    // Neither side merely survived: the sweep committed and the re-invite went
    // on to file a fresh row once the cascade let go of the project.
    expect(sweepError).toBeNull();
    expect(inviteError).toBeNull();
  });
});

describe("invite confirm — the entity row is locked before the accept CAS", () => {
  /**
   * Park a confirm on its invitation row, then ask whether it already holds the
   * entity row.
   *
   * The order is not observable from the outside any other way: both orders end
   * up parked on the same invitation row, and the CAS the wrong order would
   * have already run is uncommitted and therefore invisible. What separates
   * them is whether the entity row is held at that moment.
   * @param table - The entity table the confirm must have locked by then.
   * @param entityId - Which row.
   * @param invitationTable - The invitation table its CAS writes.
   * @param invitationId - The invitation row to hold, parking the CAS.
   * @param confirm - The confirm call to start.
   * @returns Whether the entity row was already locked while the CAS waited.
   */
  async function entityHeldWhileCasWaits(
    table: "studios" | "projects",
    entityId: string,
    invitationTable: "studio_invitations" | "project_invitations",
    invitationId: string,
    confirm: () => Promise<unknown>,
  ): Promise<boolean> {
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let held = false;
    let running: Promise<unknown>;
    try {
      await gate.begin(async (g) => {
        await g`
          SELECT id FROM ${g(invitationTable)} WHERE id = ${invitationId}
          FOR UPDATE
        `;
        running = confirm();
        await waitUntilBlockedOn(sql, [invitationTable, "update"], 1);
        held = await rowIsLockedByAnother(table, entityId);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    await Promise.allSettled([running!]);
    return held;
  }

  it("holds the project row while its accept CAS waits", async () => {
    const { projectId, adminId, inviteeEmail } = await seedStaleInvite();
    // A fresh, live invite to confirm (the seeded one is deliberately stale).
    const { invitationId } = await projectInviteService.createInvite(
      projectId,
      adminId,
      inviteeEmail,
      "viewer",
    );
    const [invitee] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${inviteeEmail}
    `;

    const held = await entityHeldWhileCasWaits(
      "projects",
      projectId,
      "project_invitations",
      invitationId,
      () => projectInviteService.confirmInvite(invitationId, invitee!.id),
    );

    expect(held).toBe(true);
  });

  it("holds the studio row while its accept CAS waits", async () => {
    const { studioId, invitationId, inviteeId } = await seedStudioInvite();

    const held = await entityHeldWhileCasWaits(
      "studios",
      studioId,
      "studio_invitations",
      invitationId,
      () => studioInviteService.confirmInvite(invitationId, inviteeId),
    );

    expect(held).toBe(true);
  });
});
