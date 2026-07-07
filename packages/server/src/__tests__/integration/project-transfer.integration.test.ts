// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project transfer-owner handshake (#1611) — the auth + data-integrity
 * critical path, pinned end-to-end against a real Postgres.
 *
 * Mirrors the studio transfer-admin handshake (studioTransfer.service): the
 * project OWNER requests (drops an actionable, expiring `project.transfer_request`
 * notification), the recipient confirms (one tx: demote old owner → editor,
 * promote the recipient → owner via `materializeOwner`, emit the
 * `member:ownership-transferred` activity, notify the old owner) or cancels.
 *
 * Load-bearing invariants proven here (a mocked query builder can't):
 *   - requestProjectTransfer lands an actionable notification (actor identity +
 *     future expiry); rejects a non-owner initiator, a personal-studio project,
 *     a guest / non-member recipient, and self-transfer.
 *   - confirm demotes the old owner to editor (D1 降一档), promotes the
 *     recipient to owner (materializeOwner inserts them if they were not yet a
 *     project member), leaving EXACTLY ONE active owner, and emits the activity.
 *   - an expired request cannot be confirmed (Conflict); roles unchanged.
 *   - two concurrent confirms apply the transfer EXACTLY ONCE.
 *   - cancel changes no roles.
 *
 * (The studio-level removal cascade — admin kicks a member → their owned
 * projects reassign to the admin, ADR D4b — is already covered by
 * studio-member-service.integration.test.ts and NOT duplicated here.)
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
import { initCore } from "@breatic/core";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";

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
    connection: { application_name: "project-transfer-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`pt-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let personalSeq = 0;
/** Give a user a personal studio (display name + slug) — the actor-identity source. */
async function insertPersonalStudio(userId: string, name: string): Promise<string> {
  const slug = `pt-personal-${personalSeq++}`;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${slug}, 'personal', ${name})
  `;
  return slug;
}

let studioSeq = 0;
/** Insert a team studio + the creator's admin member row. */
async function insertTeamStudio(
  adminUserId: string,
  type: "team" | "personal" = "team",
): Promise<{ id: string; slug: string }> {
  const slug = `pt-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, ${type}, 'PT Studio') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

async function insertStudioMember(
  studioId: string,
  userId: string,
  role: "admin" | "maintainer" | "guest",
): Promise<void> {
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, ${role})`;
}

let projectSeq = 0;
/** Insert a project in a studio + the owner's project_members row. */
async function insertProject(
  studioId: string,
  ownerUserId: string,
): Promise<{ id: string; slug: string }> {
  const slug = `pt-proj-${projectSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${ownerUserId}, ${slug}, 'PT Project') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${id}, ${ownerUserId}, 'owner')`;
  return { id, slug };
}

async function insertProjectMember(
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<void> {
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})`;
}

async function getProjectRole(projectId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]?.role ?? null;
}

/** Count active owners on a project — the transfer invariant. */
async function activeOwnerCount(projectId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM project_members
    WHERE project_id = ${projectId} AND role = 'owner' AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

interface TransferNotif {
  id: string;
  type: string;
  expires_at: Date | null;
}

async function transferRequestsFor(userId: string): Promise<TransferNotif[]> {
  return sql<TransferNotif[]>`
    SELECT id, type, expires_at FROM notifications
    WHERE user_id = ${userId} AND type = 'project.transfer_request'
      AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;
}

async function countByType(userId: string, type: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

async function activityCount(projectId: string, type: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM project_activities
    WHERE project_id = ${projectId} AND type = ${type} AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

async function expireNotification(id: string): Promise<void> {
  await sql`UPDATE notifications SET expires_at = now() - interval '1 hour' WHERE id = ${id}`;
}

interface Seeded {
  studioId: string;
  projectId: string;
  projectSlug: string;
  adminId: string;
  ownerId: string;
  ownerName: string;
  ownerSlug: string;
  recipientId: string;
  recipientName: string;
  recipientSlug: string;
}

/**
 * A team studio (admin) with a project owned by a maintainer (`ownerId`) and a
 * second maintainer (`recipientId`) who is NOT yet a project member — so
 * confirm exercises the materializeOwner insert path.
 */
async function seedProjectTransfer(): Promise<Seeded> {
  const adminId = await insertUser();
  const ownerId = await insertUser();
  const recipientId = await insertUser();
  const ownerName = "Owner Display";
  const recipientName = "Recipient Display";
  const ownerSlug = await insertPersonalStudio(ownerId, ownerName);
  const recipientSlug = await insertPersonalStudio(recipientId, recipientName);
  const studio = await insertTeamStudio(adminId);
  await insertStudioMember(studio.id, ownerId, "maintainer");
  await insertStudioMember(studio.id, recipientId, "maintainer");
  const project = await insertProject(studio.id, ownerId);
  return {
    studioId: studio.id,
    projectId: project.id,
    projectSlug: project.slug,
    adminId,
    ownerId,
    ownerName,
    ownerSlug,
    recipientId,
    recipientName,
    recipientSlug,
  };
}

describe("requestProjectTransfer", () => {
  it("lands an actionable transfer-request notification with the actor identity + a future expiry", async () => {
    const { projectId, projectSlug, ownerId, recipientId, ownerName, ownerSlug } =
      await seedProjectTransfer();

    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);

    const reqs = await transferRequestsFor(recipientId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.type).toBe("project.transfer_request");
    expect(reqs[0]!.expires_at).not.toBeNull();
    expect(reqs[0]!.expires_at!.getTime()).toBeGreaterThan(Date.now());

    const [reqPayload] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications WHERE id = ${reqs[0]!.id}
    `;
    expect(reqPayload!.payload).toMatchObject({
      fromName: ownerName,
      fromHandle: ownerSlug,
      projectSlug,
    });
  });

  it("rejects a non-owner initiator with Forbidden", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    // The recipient (a maintainer, not the project owner) tries to initiate.
    await expect(
      projectTransferService.requestProjectTransfer(projectId, recipientId, ownerId),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a personal-studio project with Forbidden", async () => {
    const adminId = await insertUser();
    const recipientId = await insertUser();
    const studio = await insertTeamStudio(adminId, "personal");
    const project = await insertProject(studio.id, adminId);
    await expect(
      projectTransferService.requestProjectTransfer(project.id, adminId, recipientId),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a guest recipient with a validation error (only non-guest can receive)", async () => {
    const { studioId, projectId, ownerId } = await seedProjectTransfer();
    const guestId = await insertUser();
    await insertStudioMember(studioId, guestId, "guest");
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, guestId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a recipient who is not a studio member with NotFound", async () => {
    const { projectId, ownerId } = await seedProjectTransfer();
    const stranger = await insertUser();
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, stranger),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects transferring to oneself with a validation error", async () => {
    const { projectId, ownerId } = await seedProjectTransfer();
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, ownerId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("confirmProjectTransfer", () => {
  it("demotes the old owner to editor, promotes the recipient to owner (inserting them), notifies the old owner, emits the activity — exactly one owner", async () => {
    const {
      projectId,
      ownerId,
      recipientId,
      recipientName,
      recipientSlug,
      projectSlug,
    } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.confirmProjectTransfer(req!.id, recipientId);

    // Old owner dropped ONE rank to editor (D1), recipient is the new owner —
    // materializeOwner inserted them (they were not a project member before).
    expect(await getProjectRole(projectId, ownerId)).toBe("editor");
    expect(await getProjectRole(projectId, recipientId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
    // The transfer is recorded in the project activity feed.
    expect(await activityCount(projectId, "member:ownership-transferred")).toBe(1);
    // The old owner is notified with the accepter's identity + project slug.
    const approved = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications
      WHERE user_id = ${ownerId} AND type = 'project.transfer_approved'
        AND deleted_at IS NULL
    `;
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toMatchObject({
      accepterName: recipientName,
      accepterHandle: recipientSlug,
      projectSlug,
    });
  });

  it("promotes a recipient who was already an editor to owner", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await insertProjectMember(projectId, recipientId, "editor");
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.confirmProjectTransfer(req!.id, recipientId);

    expect(await getProjectRole(projectId, ownerId)).toBe("editor");
    expect(await getProjectRole(projectId, recipientId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });

  it("refuses to confirm an expired request with Conflict (roles unchanged)", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);
    await expireNotification(req!.id);

    await expect(
      projectTransferService.confirmProjectTransfer(req!.id, recipientId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });

  it("applies the transfer exactly once under two concurrent confirms", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    const results = await Promise.allSettled([
      projectTransferService.confirmProjectTransfer(req!.id, recipientId),
      projectTransferService.confirmProjectTransfer(req!.id, recipientId),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await getProjectRole(projectId, ownerId)).toBe("editor");
    expect(await getProjectRole(projectId, recipientId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
    expect(await countByType(ownerId, "project.transfer_approved")).toBe(1);
  });
});

describe("cancelProjectTransfer", () => {
  it("marks the request read and changes no roles", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.cancelProjectTransfer(req!.id, recipientId);

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
    expect(await countByType(ownerId, "project.transfer_approved")).toBe(0);
    await expect(
      projectTransferService.cancelProjectTransfer(req!.id, recipientId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
