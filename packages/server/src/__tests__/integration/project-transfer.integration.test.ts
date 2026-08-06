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
import type * as LimitsModule from "@server/config/limits.js";

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

// The decision window is mocked to a value the repo does not ship, so a write
// site that went back to spelling out its own seven days cannot pass. Reading
// the real getter here would only prove the test and the code agree with each
// other — measured: with the assertions reading getDecisionWindowMs(), putting
// `7 * 24 * 60 * 60 * 1000` back into the service left every test in this file
// green. The other getters keep their real behaviour.
const decisionWindow = vi.hoisted(() => ({ days: 3 }));
vi.mock("@server/config/limits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LimitsModule>()),
  getDecisionWindowDays: () => decisionWindow.days,
  getDecisionWindowMs: () => decisionWindow.days * 24 * 60 * 60 * 1000,
  getDecisionWindowSeconds: () => decisionWindow.days * 24 * 60 * 60,
}));

import postgres from "postgres";
import { initCore, projectMembersRepo } from "@breatic/core";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as projectMembersService from "@server/modules/project/projectMembers.service.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

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
  /** The row the entry announces — what the decision endpoints act on. */
  transfer_id: string;
}

async function transferRequestsFor(userId: string): Promise<TransferNotif[]> {
  return sql<TransferNotif[]>`
    SELECT id, type, expires_at, payload->>'transferId' AS transfer_id
    FROM notifications
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

async function expireTransfer(transferId: string): Promise<void> {
  // Both projections move together, exactly as the create path writes them:
  // the decision gate reads the ROW, the bell reads the entry, and a test that
  // aged only one of them would stop exercising the gate it claims to.
  await sql`
    UPDATE project_transfers SET expires_at = now() - interval '1 hour'
    WHERE id = ${transferId}
  `;
  await sql`
    UPDATE notifications SET expires_at = now() - interval '1 hour'
    WHERE payload->>'transferId' = ${transferId}
  `;
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
 * A team studio (admin) with a project owned by `ownerId`. By default the
 * `recipientId` is BOTH a studio maintainer AND a project editor — the two
 * layers a project-transfer recipient must satisfy (D3, 2026-07-08). Each layer
 * can be overridden (or nulled) independently so a test can seed an ineligible
 * recipient: a non-project-member, an outside collaborator (project member but
 * not a studio member), or a studio guest.
 */
async function seedProjectTransfer(opts?: {
  recipientStudioRole?: "admin" | "maintainer" | "guest" | null;
  recipientProjectRole?: "editor" | "viewer" | null;
}): Promise<Seeded> {
  const recipientStudioRole =
    opts?.recipientStudioRole === undefined ? "maintainer" : opts.recipientStudioRole;
  const recipientProjectRole =
    opts?.recipientProjectRole === undefined ? "editor" : opts.recipientProjectRole;
  const adminId = await insertUser();
  const ownerId = await insertUser();
  const recipientId = await insertUser();
  const ownerName = "Owner Display";
  const recipientName = "Recipient Display";
  const ownerSlug = await insertPersonalStudio(ownerId, ownerName);
  const recipientSlug = await insertPersonalStudio(recipientId, recipientName);
  const studio = await insertTeamStudio(adminId);
  await insertStudioMember(studio.id, ownerId, "maintainer");
  if (recipientStudioRole)
    await insertStudioMember(studio.id, recipientId, recipientStudioRole);
  const project = await insertProject(studio.id, ownerId);
  if (recipientProjectRole)
    await insertProjectMember(project.id, recipientId, recipientProjectRole);
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
  it("stamps the request deadline from the configured decision window", async () => {
    // Mirror of the studio transfer's twin test: pins that the write site
    // reads the shared window. The unit itself is held by limits.test.ts.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    const aheadMs = req!.expires_at!.getTime() - Date.now();
    const windowMs = decisionWindow.days * 24 * 60 * 60 * 1000;
    expect(aheadMs).toBeLessThanOrEqual(windowMs);
    expect(aheadMs).toBeGreaterThan(windowMs - 60_000);
  });
  it("lands an actionable transfer-request notification with the actor identity + a future expiry", async () => {
    const { projectId, ownerId, recipientId, ownerName } =
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
    // Ids, not names: the handle and slug are resolved at read time so a
    // rename cannot leave this notification pointing at the wrong place.
    expect(reqPayload!.payload).toMatchObject({
      fromName: ownerName,
      fromUserId: ownerId,
      projectId,
    });
    expect(reqPayload!.payload).not.toHaveProperty("fromHandle");
    expect(reqPayload!.payload).not.toHaveProperty("projectSlug");
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
    // The recipient IS a project editor but only a studio guest → studio-layer reject.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer({
      recipientStudioRole: "guest",
    });
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a recipient who is not a project member with a validation error", async () => {
    // A studio maintainer who never joined the project → project-layer reject.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer({
      recipientProjectRole: null,
    });
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an outside collaborator (project member but NOT a studio member) — prevents transferring out of the studio", async () => {
    // A project editor who is not a studio member at all → studio-layer reject.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer({
      recipientStudioRole: null,
    });
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects transferring to oneself with a validation error", async () => {
    const { projectId, ownerId } = await seedProjectTransfer();
    await expect(
      projectTransferService.requestProjectTransfer(projectId, ownerId, ownerId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("confirmProjectTransfer", () => {
  it("demotes the old owner to editor, promotes the recipient to owner (from editor), notifies the old owner, emits the activity — exactly one owner", async () => {
    const { projectId, ownerId, recipientId, recipientName } =
      await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId);

    // Old owner dropped ONE rank to editor (D1), recipient is the new owner —
    // materializeOwner promoted them from editor (D3: recipient is a project member).
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
      accepterUserId: recipientId,
      projectId,
    });
    expect(approved[0]!.payload).not.toHaveProperty("accepterHandle");
  });

  it("promotes a recipient who was a project viewer to owner (viewer can receive)", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer({
      recipientProjectRole: "viewer",
    });
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId);

    expect(await getProjectRole(projectId, ownerId)).toBe("editor");
    expect(await getProjectRole(projectId, recipientId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });

  it("refuses to confirm an expired request with Conflict (roles unchanged)", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);
    await expireTransfer(req!.transfer_id);

    await expect(
      projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });




  it("applies the transfer exactly once under two concurrent confirms", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    const results = await Promise.allSettled([
      projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId),
      projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await getProjectRole(projectId, ownerId)).toBe("editor");
    expect(await getProjectRole(projectId, recipientId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
    expect(await countByType(ownerId, "project.transfer_approved")).toBe(1);
  });
});

describe("confirmProjectTransfer — TOCTOU eligibility re-check", () => {
  it("rejects confirm when the recipient was demoted to studio guest after the request (roles unchanged)", async () => {
    const { studioId, projectId, ownerId, recipientId } =
      await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      recipientId,
    );
    const [req] = await transferRequestsFor(recipientId);
    // The admin demotes the recipient to guest AFTER the request was sent.
    await sql`UPDATE studio_members SET role = 'guest' WHERE studio_id = ${studioId} AND user_id = ${recipientId}`;

    await expect(
      projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await getProjectRole(projectId, recipientId)).toBe("editor");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });

  it("rejects confirm when the recipient was kicked from the studio after the request (ownership cannot leave the studio)", async () => {
    const { studioId, projectId, ownerId, recipientId } =
      await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      recipientId,
    );
    const [req] = await transferRequestsFor(recipientId);
    // A studio kick soft-deletes the recipient's studio_members + project_members rows.
    await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ${studioId} AND user_id = ${recipientId}`;
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${projectId} AND user_id = ${recipientId}`;

    await expect(
      projectTransferService.confirmProjectTransfer(req!.transfer_id, recipientId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
  });
});

describe("confirmProjectTransfer — concurrency invariants", () => {
  it("a member-removal racing the confirm cannot leave the project ownerless", async () => {
    // `projectMembersService.remove` reads the target's role and then soft-
    // deletes their row as two separate statements with no transaction at all.
    // Its read can therefore see "editor" while a confirm is mid-flight, and
    // its delete then lands on the row that confirm has since promoted to
    // owner — taking the project's only owner with it. The owner-uniqueness
    // index cannot catch this: it forbids two owners, not zero.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      recipientId,
    );
    const [req] = await transferRequestsFor(recipientId);

    // Park the confirm on its first write (demoting the outgoing owner) by
    // holding that row from another connection. Every eligibility read is
    // done by then; nothing is written yet.
    let openGate!: () => void;
    const gateHeld = new Promise<void>((r) => {
      openGate = r;
    });
    const gate = sql.begin(async (t) => {
      await t`
        SELECT 1 FROM project_members
        WHERE project_id = ${projectId} AND user_id = ${ownerId}
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      await gateHeld;
    });

    const transfer = projectTransferService.confirmProjectTransfer(
      req!.transfer_id,
      recipientId,
    );
    await waitUntilBlockedOn(sql, "project_members");

    const removal = projectMembersService.remove(projectId, recipientId, ownerId);
    await new Promise((r) => setTimeout(r, 300));

    openGate();
    await gate;
    await Promise.allSettled([transfer, removal]);

    // Whoever wins, the project keeps exactly one owner.
    expect(await activeOwnerCount(projectId)).toBe(1);
  });

  it("a concurrent role change cannot demote the owner the confirm just installed", async () => {
    // Same shape as the removal above: `changeRole` reads the target's role
    // outside any transaction and then writes unconditionally. Its "you are
    // not the owner, so I may demote you" decision can be stale by the time
    // the write lands, turning the project's new owner into a viewer.
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(
      projectId,
      ownerId,
      recipientId,
    );
    const [req] = await transferRequestsFor(recipientId);

    let openGate!: () => void;
    const gateHeld = new Promise<void>((r) => {
      openGate = r;
    });
    const gate = sql.begin(async (t) => {
      await t`
        SELECT 1 FROM project_members
        WHERE project_id = ${projectId} AND user_id = ${ownerId}
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      await gateHeld;
    });

    const transfer = projectTransferService.confirmProjectTransfer(
      req!.transfer_id,
      recipientId,
    );
    await waitUntilBlockedOn(sql, "project_members");

    const demotion = projectMembersService.changeRole(
      projectId,
      recipientId,
      "viewer",
      ownerId,
    );
    await new Promise((r) => setTimeout(r, 300));

    openGate();
    await gate;
    await Promise.allSettled([transfer, demotion]);

    expect(await activeOwnerCount(projectId)).toBe(1);
  });
});

describe("declineProjectTransfer", () => {
  it("marks the request read and changes no roles", async () => {
    const { projectId, ownerId, recipientId } = await seedProjectTransfer();
    await projectTransferService.requestProjectTransfer(projectId, ownerId, recipientId);
    const [req] = await transferRequestsFor(recipientId);

    await projectTransferService.declineProjectTransfer(req!.transfer_id, recipientId);

    expect(await getProjectRole(projectId, ownerId)).toBe("owner");
    expect(await activeOwnerCount(projectId)).toBe(1);
    expect(await countByType(ownerId, "project.transfer_approved")).toBe(0);
    // A second click reports 409, not 404. Telling "already answered" apart
    // from "no such offer" is the whole reason the offer has a status column:
    // while it was only a bell entry, both collapsed into the same silence.
    await expect(
      projectTransferService.declineProjectTransfer(req!.transfer_id, recipientId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("listTransferCandidates (recipient picker data)", () => {
  it("returns project editor/viewer members who are non-guest studio members, excluding the owner and non-project-members", async () => {
    const { projectId, ownerId, adminId, recipientId } =
      await seedProjectTransfer();
    const ids = (await projectMembersRepo.listTransferCandidates(projectId)).map(
      (r) => r.userId,
    );
    expect(ids).toContain(recipientId); // editor + maintainer → eligible
    expect(ids).not.toContain(ownerId); // the owner role is excluded
    expect(ids).not.toContain(adminId); // studio member but NOT a project member
  });

  it("includes a viewer recipient (viewer can receive)", async () => {
    const { projectId, recipientId } = await seedProjectTransfer({
      recipientProjectRole: "viewer",
    });
    const ids = (await projectMembersRepo.listTransferCandidates(projectId)).map(
      (r) => r.userId,
    );
    expect(ids).toContain(recipientId);
  });

  it("excludes a studio guest, an outside collaborator, and a non-project-member", async () => {
    const guest = await seedProjectTransfer({ recipientStudioRole: "guest" });
    expect(
      (await projectMembersRepo.listTransferCandidates(guest.projectId)).map(
        (r) => r.userId,
      ),
    ).not.toContain(guest.recipientId);

    const outside = await seedProjectTransfer({ recipientStudioRole: null });
    expect(
      (await projectMembersRepo.listTransferCandidates(outside.projectId)).map(
        (r) => r.userId,
      ),
    ).not.toContain(outside.recipientId);

    const nonMember = await seedProjectTransfer({ recipientProjectRole: null });
    expect(
      (await projectMembersRepo.listTransferCandidates(nonMember.projectId)).map(
        (r) => r.userId,
      ),
    ).not.toContain(nonMember.recipientId);
  });
});
