// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Role-upgrade decisions must re-check their premises at decision time, against
 * a real Postgres.
 *
 * A role-upgrade request carries no expiry, so an arbitrary amount of time —
 * and an arbitrary number of role changes — can pass between "a viewer asks for
 * editor" and "the owner clicks approve". Two premises that held when the
 * request was filed can be false by then:
 *
 *   - the DECIDER may no longer be the project's owner (the project was
 *     transferred away from them), yet the request notification still sits in
 *     their inbox and the decision route carries no role gate;
 *   - the REQUESTER may no longer be a viewer (they were promoted, or the
 *     project was transferred TO them), so "raise them to editor" would be a
 *     DEMOTION.
 *
 * Composed, those two produce the invariant break this suite guards: the
 * project ends up with ZERO owners. `project_members_one_owner_per_project` is
 * a partial UNIQUE index — it forbids a second owner but cannot conjure a
 * missing one, so nothing at the SQL layer catches it.
 *
 * These are transaction / visibility properties, so they are only provable
 * against a real Postgres. Runs against the testcontainer Postgres + Redis
 * started by global-setup.ts; seeding uses a narrow raw `postgres` client while
 * the assertions drive the real `roleUpgradeRequest.service`.
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
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";

// integration-setup.ts injects the container URLs into process.env but
// deliberately does not call initCore itself — a setup file runs for every
// suite, so importing the core barrel there would pull the application into
// every module graph.
// Guarded because the worker process is shared (singleFork) with sibling suites.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "role-upgrade-stale-premise-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`rup-${tag}-${seq++}@example.com`}, true)
    RETURNING id
  `;
  return row!.id;
}

async function insertStudio(createdByUserId: string, tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`rup-studio-${tag}-${seq++}`}, 'personal', ${`studio-${tag}`})
    RETURNING id
  `;
  return row!.id;
}

async function insertProject(
  studioId: string,
  creatorUserId: string,
  tag: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${creatorUserId}, ${`proj-${tag}`}, ${`proj-${tag}-${seq++}`})
    RETURNING id
  `;
  return row!.id;
}

async function insertMember(
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
  addedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, ${addedBy})
  `;
}

async function insertRoleUpgradeRequest(
  inboxUserId: string,
  requesterId: string,
  projectId: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [notice] = await sql<{ id: string }[]>`
    INSERT INTO notifications (user_id, type, payload, project_id, expires_at)
    VALUES (
      ${inboxUserId},
      'access.role_upgrade_request',
      ${sql.json({ requesterUserId: requesterId, projectName: "Demo", requestedRole: "editor" })},
      ${projectId},
      ${expiresAt}
    )
    RETURNING id
  `;
  // The request is a row of its own now; the notification only announces it.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO role_upgrade_requests
      (project_id, requester_user_id, requested_role, status, notification_id, expires_at, share_token)
      VALUES (${projectId}, ${requesterId}, 'editor', 'pending', ${notice!.id}, ${expiresAt}, replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
    RETURNING id
  `;
  return row!.id;
}

async function setRole(
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<void> {
  await sql`
    UPDATE project_members SET role = ${role}
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
}

async function memberRole(
  projectId: string,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]?.role ?? null;
}

async function countOwners(projectId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM project_members
    WHERE project_id = ${projectId} AND role = 'owner' AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

interface Transferred {
  formerOwnerId: string;
  requesterId: string;
  projectId: string;
  requestId: string;
}

/**
 * The state left behind by an OWNER TRANSFER that happened after a viewer filed
 * a role-upgrade request: the requester is now the project's owner, the former
 * owner has been demoted to editor (the one-rank-down demotion
 * `confirmProjectTransfer` applies), and the untouched request notification is
 * still sitting unread in the former owner's inbox.
 */
async function seedTransferredAwayFromDecider(
  tag: string,
): Promise<Transferred> {
  const formerOwnerId = await insertUser(`former-${tag}`);
  const requesterId = await insertUser(`requester-${tag}`);
  const studioId = await insertStudio(formerOwnerId, tag);
  const projectId = await insertProject(studioId, formerOwnerId, tag);
  await insertMember(projectId, formerOwnerId, "owner", null);
  await insertMember(projectId, requesterId, "viewer", formerOwnerId);
  const requestId = await insertRoleUpgradeRequest(
    formerOwnerId,
    requesterId,
    projectId,
  );

  // The transfer: demote the old owner first, then promote the requester —
  // the same order confirmProjectTransfer uses to stay clear of the one-owner
  // partial unique index.
  await setRole(projectId, formerOwnerId, "editor");
  await setRole(projectId, requesterId, "owner");

  return { formerOwnerId, requesterId, projectId, requestId };
}

describe("role-upgrade approve re-checks its premises", () => {
  it("a project still has exactly one owner after a stale request is approved", async () => {
    const { formerOwnerId, requesterId, projectId, requestId } =
      await seedTransferredAwayFromDecider("keeps-owner");

    // The former owner clicks approve on the request still in their inbox.
    // Whatever the service decides to answer, the project must not be left
    // ownerless — an ownerless project can never be transferred, deleted by
    // its owner, or have its access requests decided again.
    await roleUpgradeService
      .approve({
        requestId,
        ownerUserId: formerOwnerId,
      })
      .catch(() => undefined);

    expect(await countOwners(projectId)).toBe(1);
    expect(await memberRole(projectId, requesterId)).toBe("owner");
  });

  it("a former owner cannot decide the project's role-upgrade requests", async () => {
    const { formerOwnerId, requesterId, projectId, requestId } =
      await seedTransferredAwayFromDecider("former-owner-denied");

    // Deciding who may collaborate on a project is the current owner's call.
    // Holding the notification is not authority — the decision route carries no
    // role gate, so the service is the only place this can be enforced.
    await expect(
      roleUpgradeService.approve({
        requestId,
        ownerUserId: formerOwnerId,
      }),
    ).rejects.toThrow();

    expect(await memberRole(projectId, requesterId)).toBe("owner");
  });

  it("a former owner cannot reject the project's role-upgrade requests either", async () => {
    const { formerOwnerId, requesterId, requestId } =
      await seedTransferredAwayFromDecider("former-owner-reject");

    // Reject writes no role, but it still CONSUMES the request and tells the
    // requester they were turned down — a decision the former owner no longer
    // gets to make. Leaving this path open would let them silently burn every
    // request the new owner was supposed to answer.
    await expect(
      roleUpgradeService.reject({
        requestId,
        ownerUserId: formerOwnerId,
      }),
    ).rejects.toThrow();

    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM notifications
      WHERE user_id = ${requesterId}
        AND type = 'access.role_upgrade_rejected'
        AND deleted_at IS NULL
    `;
    expect(rows[0]!.c).toBe(0);
  });
});
