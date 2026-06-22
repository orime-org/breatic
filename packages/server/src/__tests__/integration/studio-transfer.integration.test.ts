// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio transfer-admin handshake (slice 3) — the auth + data-integrity
 * critical path, pinned end-to-end against a real Postgres.
 *
 * The transfer is a two-step handshake mirroring role-upgrade-request: the
 * admin requests (drops an actionable, expiring `studio.transfer_request`
 * notification), the recipient confirms (one tx: demote old admin → promote
 * new admin → notify the old admin) or cancels (mark read, no role change).
 *
 * The load-bearing invariants are SQL-level (transaction + CAS mark-read + the
 * `studio_members_one_admin_per_studio` partial unique) and a mocked query
 * builder cannot reproduce them, so they are proven here:
 *
 *   - requestTransfer lands an actionable notification with a future expiry.
 *   - confirm demotes the old admin to guest, promotes the recipient to
 *     admin, and notifies the old admin — leaving EXACTLY ONE active admin.
 *   - an expired request cannot be confirmed (Conflict).
 *   - two concurrent confirms apply the transfer EXACTLY ONCE.
 *   - cancel changes no roles.
 *
 * Runs against the testcontainer Postgres + Redis started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; assertions drive the real
 * `studioTransfer.service` (core's env-bound `db`).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core — the core barrel pulls
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build breaks
// Node's native loader. This suite never calls any ai function; the stubs
// keep that chain from loading (same guard the sibling studio suites use).
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
import { studioMembersRepo } from "@breatic/domain";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";

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
    connection: { application_name: "studio-transfer-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/** Insert a user; returns its id. */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`st-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let personalSeq = 0;
/** Give a user a personal studio (display name + slug) — the bell's actor-identity source. */
async function insertPersonalStudio(
  userId: string,
  name: string,
): Promise<string> {
  const slug = `st-personal-${personalSeq++}`;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${slug}, 'personal', ${name})
  `;
  return slug;
}

let studioSeq = 0;
/** Insert a team studio + the creator's admin member row; returns id + slug. */
async function insertStudioWithAdmin(
  adminUserId: string,
  type: "team" | "personal" = "team",
): Promise<{ id: string; slug: string }> {
  const slug = `st-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, ${type}, 'Transfer Studio')
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

/** Add an active member row directly. */
async function insertMemberRaw(
  studioId: string,
  userId: string,
  role: "admin" | "maintainer" | "guest",
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${role})
  `;
}

/** Count active admins on a studio — the transfer invariant. */
async function activeAdminCount(studioId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM studio_members
    WHERE studio_id = ${studioId} AND role = 'admin' AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

interface TransferNotif {
  id: string;
  type: string;
  expires_at: Date | null;
}

/** The recipient's transfer-request notifications, newest first. */
async function transferRequestsFor(userId: string): Promise<TransferNotif[]> {
  return sql<TransferNotif[]>`
    SELECT id, type, expires_at FROM notifications
    WHERE user_id = ${userId} AND type = 'studio.transfer_request'
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

/** Force a notification's expiry into the past (simulate the 7-day timeout). */
async function expireNotification(id: string): Promise<void> {
  await sql`UPDATE notifications SET expires_at = now() - interval '1 hour' WHERE id = ${id}`;
}

interface Seeded {
  studioId: string;
  slug: string;
  adminId: string;
  memberId: string;
  adminName: string;
  adminSlug: string;
  memberName: string;
  memberSlug: string;
}

/** A team studio with one admin + one ordinary member, each with a personal studio. */
async function seedStudio(): Promise<Seeded> {
  const adminId = await insertUser();
  const memberId = await insertUser();
  const adminName = "Admin Display";
  const memberName = "Member Display";
  const adminSlug = await insertPersonalStudio(adminId, adminName);
  const memberSlug = await insertPersonalStudio(memberId, memberName);
  const studio = await insertStudioWithAdmin(adminId);
  await insertMemberRaw(studio.id, memberId, "guest");
  return {
    studioId: studio.id,
    slug: studio.slug,
    adminId,
    memberId,
    adminName,
    adminSlug,
    memberName,
    memberSlug,
  };
}

describe("requestTransfer", () => {
  it("lands an actionable transfer-request notification with the actor identity + a future expiry", async () => {
    const { slug, adminId, memberId, adminName, adminSlug } = await seedStudio();

    await studioTransferService.requestTransfer(slug, adminId, memberId);

    const reqs = await transferRequestsFor(memberId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.type).toBe("studio.transfer_request");
    expect(reqs[0]!.expires_at).not.toBeNull();
    expect(reqs[0]!.expires_at!.getTime()).toBeGreaterThan(Date.now());

    // The bell payload carries the initiating admin's identity (name + @handle)
    // + the studio slug, so the row renders "[Admin] asked you to take over
    // [studio]" with both clickable.
    const [reqPayload] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications WHERE id = ${reqs[0]!.id}
    `;
    expect(reqPayload!.payload).toMatchObject({
      fromName: adminName,
      fromHandle: adminSlug,
      studioSlug: slug,
    });
  });

  it("rejects transferring to a non-member with NotFound", async () => {
    const { slug, adminId } = await seedStudio();
    const stranger = await insertUser();
    await expect(
      studioTransferService.requestTransfer(slug, adminId, stranger),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects transferring to oneself with a validation error", async () => {
    const { slug, adminId } = await seedStudio();
    await expect(
      studioTransferService.requestTransfer(slug, adminId, adminId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a personal studio with Forbidden", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin, "personal");
    await insertMemberRaw(studio.id, member, "guest");
    await expect(
      studioTransferService.requestTransfer(studio.slug, admin, member),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("confirmTransfer", () => {
  it("demotes the old admin, promotes the recipient, notifies the old admin (accepter identity) — exactly one active admin", async () => {
    const { studioId, slug, adminId, memberId, memberName, memberSlug } =
      await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);

    await studioTransferService.confirmTransfer(req!.id, memberId);

    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("guest");
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("admin");
    // The invariant: the studio has exactly one active admin after the swap.
    expect(await activeAdminCount(studioId)).toBe(1);
    // The old admin receives the approved notification carrying the accepter's
    // identity (name + @handle) + the studio slug.
    const approved = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications
      WHERE user_id = ${adminId} AND type = 'studio.transfer_approved'
        AND deleted_at IS NULL
    `;
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toMatchObject({
      accepterName: memberName,
      accepterHandle: memberSlug,
      studioSlug: slug,
    });
  });

  it("refuses to confirm an expired request with Conflict (roles unchanged)", async () => {
    const { studioId, slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);
    await expireNotification(req!.id);

    await expect(
      studioTransferService.confirmTransfer(req!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The whole transaction rolled back — roles are unchanged.
    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("admin");
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("guest");
    expect(await activeAdminCount(studioId)).toBe(1);
  });

  it("applies the transfer exactly once under two concurrent confirms", async () => {
    const { studioId, slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);

    const results = await Promise.allSettled([
      studioTransferService.confirmTransfer(req!.id, memberId),
      studioTransferService.confirmTransfer(req!.id, memberId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    // Decide-once: exactly one confirm wins, the loser aborts.
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    // The swap landed once: one active admin, one approved notification.
    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("guest");
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("admin");
    expect(await activeAdminCount(studioId)).toBe(1);
    expect(await countByType(adminId, "studio.transfer_approved")).toBe(1);
  });
});

describe("cancelTransfer", () => {
  it("marks the request read and changes no roles", async () => {
    const { studioId, slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);

    await studioTransferService.cancelTransfer(req!.id, memberId);

    // No role swap.
    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("admin");
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("guest");
    expect(await activeAdminCount(studioId)).toBe(1);
    // No approved notification was sent.
    expect(await countByType(adminId, "studio.transfer_approved")).toBe(0);
    // A second cancel is a no-op NotFound (already decided).
    await expect(
      studioTransferService.cancelTransfer(req!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
