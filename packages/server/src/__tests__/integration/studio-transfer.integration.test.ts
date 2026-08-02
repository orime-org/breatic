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
 *   - confirm demotes the old admin to maintainer, promotes the recipient to
 *     admin, and notifies the old admin — leaving EXACTLY ONE active admin.
 *   - requestTransfer rejects a guest recipient (only non-guest can receive).
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
import { getDecisionWindowMs } from "@server/config/limits.js";

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

/** Force a notification's expiry into the past (simulate the window running out). */
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
  await insertMemberRaw(studio.id, memberId, "maintainer");
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
    const { studioId, slug, adminId, memberId, adminName } = await seedStudio();

    await studioTransferService.requestTransfer(slug, adminId, memberId);

    const reqs = await transferRequestsFor(memberId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.type).toBe("studio.transfer_request");
    expect(reqs[0]!.expires_at).not.toBeNull();
    expect(reqs[0]!.expires_at!.getTime()).toBeGreaterThan(Date.now());

    // The bell payload carries the initiating admin's id + the studio id, so
    // the row renders "[Admin] asked you to take over [studio]" with both
    // clickable — the names and links come from resolving those ids at read
    // time, not from a copy frozen when the request was sent.
    const [reqPayload] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications WHERE id = ${reqs[0]!.id}
    `;
    // Ids, not names: the handle and slug are resolved at read time so a
    // rename cannot leave this notification pointing at the wrong place.
    expect(reqPayload!.payload).toMatchObject({
      fromName: adminName,
      fromUserId: adminId,
      studioId,
    });
    expect(reqPayload!.payload).not.toHaveProperty("fromHandle");
    expect(reqPayload!.payload).not.toHaveProperty("studioSlug");
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

  it("rejects transferring to a guest member — only non-guest (admin/maintainer) can receive (#1612)", async () => {
    const adminId = await insertUser();
    const guestId = await insertUser();
    const studio = await insertStudioWithAdmin(adminId);
    await insertMemberRaw(studio.id, guestId, "guest");
    await expect(
      studioTransferService.requestTransfer(studio.slug, adminId, guestId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("confirmTransfer", () => {
  it("demotes the old admin, promotes the recipient, notifies the old admin (accepter identity) — exactly one active admin", async () => {
    const { studioId, slug, adminId, memberId, memberName } =
      await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);

    await studioTransferService.confirmTransfer(req!.id, memberId);

    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("maintainer");
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
      accepterUserId: memberId,
      studioId,
    });
    expect(approved[0]!.payload).not.toHaveProperty("accepterHandle");
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
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("maintainer");
    expect(await activeAdminCount(studioId)).toBe(1);
  });

  it("stamps the request deadline from the configured decision window", async () => {
    // The write site moved from a local constant to the shared window
    // with nothing asserting the result — a getter handing back the wrong unit
    // would have left this file green. Read from the getter rather than naming
    // a number, so turning the operator knob does not redden the suite.
    const { slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);

    const aheadMs = req!.expires_at!.getTime() - Date.now();
    expect(aheadMs).toBeLessThanOrEqual(getDecisionWindowMs());
    expect(aheadMs).toBeGreaterThan(getDecisionWindowMs() - 60_000);
  });

  it("refuses to decline a notification that is not a transfer request, leaving it unread", async () => {
    // The type check runs AFTER the mark-read CAS, and that CAS matches on id +
    // recipient only — it never looks at the type. Without the transaction,
    // aiming this endpoint at any other unread notification would mark it read
    // and only then fail, silently consuming a row it had no business touching.
    const { memberId } = await seedStudio();
    const [notif] = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, payload)
      VALUES (${memberId}, 'studio.invite_accepted', '{}'::jsonb)
      RETURNING id
    `;

    await expect(
      studioTransferService.cancelTransfer(notif!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 404 });

    const [after] = await sql<{ read_at: Date | null }[]>`
      SELECT read_at FROM notifications WHERE id = ${notif!.id}
    `;
    expect(after!.read_at).toBeNull();
  });

  it("refuses to DECLINE an expired request with Conflict, leaving it unread", async () => {
    // Expiry closes the request outright: past the window there is no decision
    // left to make, not "you may still say no". Declining an expired request
    // must fail exactly like confirming one — and it must fail WHOLE, so the
    // mark-read that serializes the decision cannot survive the rejection and
    // leave a request that is neither decidable nor visible.
    const { studioId, slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);
    await expireNotification(req!.id);

    await expect(
      studioTransferService.cancelTransfer(req!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [after] = await sql<{ read_at: Date | null }[]>`
      SELECT read_at FROM notifications WHERE id = ${req!.id}
    `;
    expect(after!.read_at).toBeNull();
    // Roles never move on a decline, expired or not.
    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("admin");
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
    expect(await studioMembersRepo.getRole(studioId, adminId)).toBe("maintainer");
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("admin");
    expect(await activeAdminCount(studioId)).toBe(1);
    expect(await countByType(adminId, "studio.transfer_approved")).toBe(1);
  });
});

describe("confirmTransfer — TOCTOU eligibility re-check", () => {
  it("rejects confirm when the recipient was demoted to guest after the request (roles unchanged)", async () => {
    const { studioId, slug, adminId, memberId } = await seedStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [req] = await transferRequestsFor(memberId);
    // The admin demotes the recipient to guest AFTER the request was sent.
    await sql`UPDATE studio_members SET role = 'guest' WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await expect(
      studioTransferService.confirmTransfer(req!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The swap did NOT happen: the admin stays admin, the recipient stays guest.
    const roles = await sql<{ user_id: string; role: string }[]>`
      SELECT user_id, role FROM studio_members
      WHERE studio_id = ${studioId} AND deleted_at IS NULL
    `;
    const roleOf = (uid: string): string | undefined =>
      roles.find((r) => r.user_id === uid)?.role;
    expect(roleOf(adminId)).toBe("admin");
    expect(roleOf(memberId)).toBe("guest");
  });

  it("rejects confirm when the studio changed hands after the request (the initiator is no longer admin)", async () => {
    // A request names its initiator in a payload written a whole window
    // ago. If the studio has since moved to somebody else, confirming that
    // stale request would demote whoever holds the role now — and promote the
    // long-since-demoted initiator back up to maintainer on the way past.
    const { studioId, slug, adminId, memberId } = await seedStudio();
    const successorId = await insertUser();
    await insertMemberRaw(studioId, successorId, "maintainer");
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [stale] = await transferRequestsFor(memberId);

    // The studio changes hands to the successor (demote first — the one-admin
    // partial unique rejects a second active admin).
    await sql`UPDATE studio_members SET role = 'maintainer' WHERE studio_id = ${studioId} AND user_id = ${adminId}`;
    await sql`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${successorId}`;

    await expect(
      studioTransferService.confirmTransfer(stale!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    const roles = await sql<{ user_id: string; role: string }[]>`
      SELECT user_id, role FROM studio_members
      WHERE studio_id = ${studioId} AND deleted_at IS NULL
    `;
    const roleOf = (uid: string): string | undefined =>
      roles.find((r) => r.user_id === uid)?.role;
    expect(roleOf(successorId)).toBe("admin");
    expect(roleOf(adminId)).toBe("maintainer");
    expect(roleOf(memberId)).toBe("maintainer");
    expect(await activeAdminCount(studioId)).toBe(1);
  });

  it("rejects confirm when the recipient already became admin by another route (no bystander gets demoted)", async () => {
    // The variant the one-admin index cannot catch, because the promotion it
    // would perform is a no-op: the recipient IS already the admin. The DEMOTE
    // still runs, so the stale request's initiator — a plain member by now —
    // gets pushed to maintainer for no reason. A guest would be pushed UP.
    const { studioId, slug, adminId, memberId } = await seedStudio();
    const bystanderId = await insertUser();
    await insertMemberRaw(studioId, bystanderId, "guest");
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [stale] = await transferRequestsFor(memberId);

    // The studio moves to the recipient by some other route, and the original
    // initiator ends up a guest.
    await sql`UPDATE studio_members SET role = 'guest' WHERE studio_id = ${studioId} AND user_id = ${adminId}`;
    await sql`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await expect(
      studioTransferService.confirmTransfer(stale!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    const roles = await sql<{ user_id: string; role: string }[]>`
      SELECT user_id, role FROM studio_members
      WHERE studio_id = ${studioId} AND deleted_at IS NULL
    `;
    const roleOf = (uid: string): string | undefined =>
      roles.find((r) => r.user_id === uid)?.role;
    expect(roleOf(memberId)).toBe("admin");
    // Still a guest — the stale request did not hand them a promotion.
    expect(roleOf(adminId)).toBe("guest");
    expect(roleOf(bystanderId)).toBe("guest");
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
    expect(await studioMembersRepo.getRole(studioId, memberId)).toBe("maintainer");
    expect(await activeAdminCount(studioId)).toBe(1);
    // No approved notification was sent.
    expect(await countByType(adminId, "studio.transfer_approved")).toBe(0);
    // A second cancel is a no-op NotFound (already decided).
    await expect(
      studioTransferService.cancelTransfer(req!.id, memberId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
