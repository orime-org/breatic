// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The order in which the project-invite paths take their two locks — real
 * Postgres.
 *
 * Every path that adds a project-scoped row takes the `projects` row lock, and
 * `deleteProject` takes it FIRST and only then sweeps `project_invitations`
 * (`project.repo.ts`, the comment there says "Taken FIRST"). Any path that
 * takes those two the other way round closes an AB/BA cycle: Postgres notices
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
 * The SQLSTATE of a rejected query, when it has one.
 *
 * Both sides are asked for it rather than just the sweep: which transaction
 * Postgres aborts to break a cycle is its own choice, so pinning only one of
 * them would pass whenever it happened to pick the other.
 * @param err - Whatever was thrown or rejected with.
 * @returns The `code` field if this looks like a PostgresError, else null.
 */
function sqlStateOf(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "code" in err) {
    const { code } = err;
    if (typeof code === "string") return code;
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
