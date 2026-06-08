// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Share-link consume → project membership critical-path invariants —
 * `shareLinkService.consumeLink` against a real Postgres.
 *
 * Consuming an invite link is the auth critical path where a non-member
 * becomes a member (CLAUDE.md 鉴权 + 数据完整性). The bug this suite pins:
 * `consumeLink` used to only flip `consumed_at` and never wrote a
 * `project_members` row, so an invitee who clicked a valid link never
 * actually joined the project — and the `member_joined` notification the
 * route comment promised was never sent.
 *
 * The guarantees are transactional + SQL-level (the single-use CAS, the
 * `upsertMember` ON CONFLICT, and the owner notification all share one
 * `db.transaction`), so a mocked query builder cannot prove them — they
 * only behave correctly against real Postgres.
 *
 * Seeding uses a narrow raw `postgres` client; the assertions call the
 * real service (core's env-bound `db`, pointed at the testcontainer via
 * the injected config) and the real `projectMembersRepo` (core).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing the share service (→ @breatic/domain barrel
// pulls agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build
// Node's native ESM rejects). This suite never calls any ai function.
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
import { initCore, ForbiddenError, projectMembersRepo } from "@breatic/core";
import type { ProjectRole } from "@breatic/shared";
import * as shareLinkService from "@server/modules/share/shareLink.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "share-link-consume-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/** Insert a fresh user; returns { id, email }. */
async function insertUser(): Promise<{ id: string; email: string }> {
  const email = `slc-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

let studioSeq = 0;
/** Insert a team studio + the creator's admin member row; returns the id. */
async function insertStudio(createdByUserId: string): Promise<string> {
  const slug = `slc-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, 'team', ${`Studio ${slug}`})
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${createdByUserId}, 'admin')`;
  return id;
}

let projSeq = 0;
/** Insert a project (+ its owner row); returns the project id. */
async function insertProject(studioId: string, ownerUserId: string): Promise<string> {
  const slug = `slc-project-${projSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${ownerUserId}, ${`Project ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  const projectId = rows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerUserId}, 'owner', null)
  `;
  return projectId;
}

let tokenSeq = 0;
/** Insert an email-invite share link (single-use, bound to `boundEmail`). */
async function insertEmailLink(
  projectId: string,
  createdByUserId: string,
  boundEmail: string,
  role: "editor" | "viewer",
): Promise<string> {
  const token = `slc-email-token-${tokenSeq++}`;
  await sql`
    INSERT INTO share_links (project_id, created_by_user_id, token, role, kind, bound_email, expires_at)
    VALUES (${projectId}, ${createdByUserId}, ${token}, ${role}, 'email', ${boundEmail}, now() + interval '7 days')
  `;
  return token;
}

/** Insert a multi-use share link (no expiry, no bound email). */
async function insertMultiUseLink(
  projectId: string,
  createdByUserId: string,
  role: "editor" | "viewer",
): Promise<string> {
  const token = `slc-link-token-${tokenSeq++}`;
  await sql`
    INSERT INTO share_links (project_id, created_by_user_id, token, role, kind)
    VALUES (${projectId}, ${createdByUserId}, ${token}, ${role}, 'link')
  `;
  return token;
}

/** Count active member rows for a user on a project. */
async function activeMemberCount(projectId: string, userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]!.n;
}

/** Read the `consumed_at` of a share link by token. */
async function consumedAt(token: string): Promise<Date | null> {
  const rows = await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM share_links WHERE token = ${token}
  `;
  return rows[0]!.consumed_at;
}

/** Fetch the `member_joined` notifications in a user's inbox. */
async function memberJoinedNotifs(
  ownerUserId: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  return sql<{ type: string; payload: Record<string, unknown> }[]>`
    SELECT type, payload FROM notifications
    WHERE user_id = ${ownerUserId} AND type = 'access.member_joined' AND deleted_at IS NULL
  `;
}

describe("consumeLink — email invite enrolls the bound recipient", () => {
  it("makes the consumer a project member at link.role + notifies the owner + spends the token", async () => {
    const owner = await insertUser();
    const invitee = await insertUser();
    const studioId = await insertStudio(owner.id);
    const projectId = await insertProject(studioId, owner.id);
    const token = await insertEmailLink(projectId, owner.id, invitee.email, "editor");

    // Pre-condition: invitee is NOT yet a member.
    expect(await projectMembersRepo.getRole(projectId, invitee.id)).toBeNull();

    const link = await shareLinkService.consumeLink(token, invitee.id, invitee.email);

    // The consumer is now an active member at the link's role.
    expect(await projectMembersRepo.getRole(projectId, invitee.id)).toBe<ProjectRole>("editor");
    expect(await activeMemberCount(projectId, invitee.id)).toBe(1);

    // The single-use email token is spent.
    expect(link.consumedAt).toBeInstanceOf(Date);
    expect(await consumedAt(token)).not.toBeNull();

    // The owner received exactly one member_joined notification.
    const notifs = await memberJoinedNotifs(owner.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.payload.newMemberUserId).toBe(invitee.id);
    expect(notifs[0]!.payload.role).toBe("editor");
  });
});

describe("consumeLink — multi-use link enrolls every distinct consumer", () => {
  it("makes the consumer a viewer member without spending the token + notifies the owner", async () => {
    const owner = await insertUser();
    const consumer = await insertUser();
    const studioId = await insertStudio(owner.id);
    const projectId = await insertProject(studioId, owner.id);
    const token = await insertMultiUseLink(projectId, owner.id, "viewer");

    const link = await shareLinkService.consumeLink(token, consumer.id, consumer.email);

    expect(await projectMembersRepo.getRole(projectId, consumer.id)).toBe<ProjectRole>("viewer");
    expect(await activeMemberCount(projectId, consumer.id)).toBe(1);
    // Multi-use link is never marked consumed.
    expect(link.consumedAt).toBeNull();
    expect(await consumedAt(token)).toBeNull();
    expect(await memberJoinedNotifs(owner.id)).toHaveLength(1);
  });
});

describe("consumeLink — multi-use link idempotence (same consumer re-consumes)", () => {
  it("re-consuming does not error, keeps exactly one active member row, and does not re-notify", async () => {
    const owner = await insertUser();
    const consumer = await insertUser();
    const studioId = await insertStudio(owner.id);
    const projectId = await insertProject(studioId, owner.id);
    const token = await insertMultiUseLink(projectId, owner.id, "editor");

    await shareLinkService.consumeLink(token, consumer.id, consumer.email);
    // Second consume by the same already-member must be a no-op.
    await shareLinkService.consumeLink(token, consumer.id, consumer.email);

    expect(await projectMembersRepo.getRole(projectId, consumer.id)).toBe<ProjectRole>("editor");
    expect(await activeMemberCount(projectId, consumer.id)).toBe(1);
    // No second join notification (the member already existed).
    expect(await memberJoinedNotifs(owner.id)).toHaveLength(1);
  });
});

describe("consumeLink — single-use email token cannot be replayed", () => {
  it("rejects the second consume with Forbidden and does not double-enroll", async () => {
    const owner = await insertUser();
    const invitee = await insertUser();
    const studioId = await insertStudio(owner.id);
    const projectId = await insertProject(studioId, owner.id);
    const token = await insertEmailLink(projectId, owner.id, invitee.email, "viewer");

    await shareLinkService.consumeLink(token, invitee.id, invitee.email);
    expect(await activeMemberCount(projectId, invitee.id)).toBe(1);

    // Second consume of a spent single-use token is Forbidden.
    await expect(
      shareLinkService.consumeLink(token, invitee.id, invitee.email),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Still exactly one active membership + one notification (no double write).
    expect(await activeMemberCount(projectId, invitee.id)).toBe(1);
    expect(await memberJoinedNotifs(owner.id)).toHaveLength(1);
  });
});

describe("consumeLink — owner clicking their own multi-use link", () => {
  it("does not duplicate the owner row and does not notify themselves", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner.id);
    const projectId = await insertProject(studioId, owner.id);
    const token = await insertMultiUseLink(projectId, owner.id, "viewer");

    await shareLinkService.consumeLink(token, owner.id, owner.email);

    // The owner role is unchanged (NOT downgraded to viewer) and unique.
    expect(await projectMembersRepo.getRole(projectId, owner.id)).toBe<ProjectRole>("owner");
    expect(await activeMemberCount(projectId, owner.id)).toBe(1);
    // No self-notification.
    expect(await memberJoinedNotifs(owner.id)).toHaveLength(0);
  });
});
