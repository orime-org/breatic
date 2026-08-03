// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Finding the one request a token names, across five tables.
 *
 * Everything the landing page does starts here: it is handed a token and has to
 * work out which of the five flows it belongs to before it can say anything at
 * all. Three properties matter, and all three are the kind that only a real
 * database can settle:
 *
 *   1. Each of the five kinds resolves, and resolves to the right kind. A
 *      lookup that searched four tables would look perfectly healthy until
 *      somebody used the fifth.
 *   2. A token nobody issued resolves to nothing — that, and only that, is what
 *      the page may call an invalid link.
 *   3. A SOFT-DELETED request still resolves. Its project was deleted and the
 *      cascade took the request with it, but the person holding the link has to
 *      be told the thing is gone rather than that their link was never real.
 *      This is why the lookup must not filter on `deleted_at`.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core — the core barrel pulls agent/llm →
// the `ai` SDK → @opentelemetry/api, whose ESM build uses bare relative imports
// Node's native ESM rejects. This suite never calls any ai function.
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

initCore(process.env);

import * as decisionRepo from "@server/modules/decision/decision.repo.js";
import * as studioInvitationsRepo from "@server/modules/studio/studioInvitations.repo.js";
import * as projectInvitationsRepo from "@server/modules/project-invite/projectInvitations.repo.js";
import * as roleUpgradeRequestsRepo from "@server/modules/role-upgrade-request/roleUpgradeRequests.repo.js";
import * as projectTransfersRepo from "@server/modules/project/projectTransfers.repo.js";
import * as studioTransfersRepo from "@server/modules/studio/studioTransfers.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "decision-resolve-test-driver" },
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
  projectId: string;
}

/**
 * A team studio with two members and one project.
 * @returns The seeded ids.
 * @throws {Error} when any seed insert returns no row.
 */
async function seedScene(): Promise<Scene> {
  const tag = `dr-${seq++}-${Date.now()}`;
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-owner@example.com`}, true) RETURNING id
  `;
  const [member] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-member@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  if (!owner || !member || !studio || !project) throw new Error("seed failed");
  return {
    ownerId: owner.id,
    memberId: member.id,
    studioId: studio.id,
    projectId: project.id,
  };
}

const IN_A_WEEK = (): Date => new Date(Date.now() + 7 * 24 * 3600 * 1000);

/**
 * Reads back the token a request was given.
 * @param table - Which request table.
 * @param id - The row id.
 * @returns The row's share token.
 * @throws {Error} when there is no such row.
 */
async function tokenOf(table: string, id: string): Promise<string> {
  const rows = await sql<{ share_token: string }[]>`
    SELECT share_token FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`${table}: no row ${id}`);
  return row.share_token;
}

describe("a token resolves to exactly one request, whichever flow it is", () => {
  it("resolves all five kinds, each to its own kind and row", async () => {
    const scene = await seedScene();

    const studioInviteId = await studioInvitationsRepo.createPending({
      studioId: scene.studioId,
      invitedUserId: scene.memberId,
      role: "guest",
      invitedBy: scene.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const projectInviteId = await projectInvitationsRepo.createPending({
      projectId: scene.projectId,
      invitedUserId: scene.memberId,
      role: "viewer",
      invitedBy: scene.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const { id: roleUpgradeId } = await roleUpgradeRequestsRepo.createPending({
      projectId: scene.projectId,
      requesterUserId: scene.memberId,
      requestedRole: "editor",
      expiresAt: IN_A_WEEK(),
    });
    const { id: projectTransferId } = await projectTransfersRepo.createPending({
      projectId: scene.projectId,
      fromUserId: scene.ownerId,
      toUserId: scene.memberId,
      expiresAt: IN_A_WEEK(),
    });
    const { id: studioTransferId } = await studioTransfersRepo.createPending({
      studioId: scene.studioId,
      fromUserId: scene.ownerId,
      toUserId: scene.memberId,
      expiresAt: IN_A_WEEK(),
    });

    const cases = [
      { table: "studio_invitations", id: studioInviteId, kind: "studio_invite" },
      { table: "project_invitations", id: projectInviteId, kind: "project_invite" },
      { table: "role_upgrade_requests", id: roleUpgradeId, kind: "role_upgrade" },
      { table: "project_transfers", id: projectTransferId, kind: "project_transfer" },
      { table: "studio_transfers", id: studioTransferId, kind: "studio_transfer" },
    ] as const;

    for (const c of cases) {
      const token = await tokenOf(c.table, c.id);
      const found = await decisionRepo.resolveByToken(token);
      expect(found, `${c.kind} must resolve`).not.toBeNull();
      expect(found!.kind).toBe(c.kind);
      expect(found!.id).toBe(c.id);
      expect(found!.status).toBe("pending");
      expect(found!.deleted).toBe(false);
    }
  });

  it("a token nobody issued resolves to nothing", async () => {
    expect(await decisionRepo.resolveByToken("f".repeat(64))).toBeNull();
    expect(await decisionRepo.resolveByToken("")).toBeNull();
    // Not hex, not the right length, and shaped like an injection attempt.
    expect(await decisionRepo.resolveByToken("' OR 1=1 --")).toBeNull();
  });

  it("a soft-deleted request still resolves, and says so", async () => {
    const scene = await seedScene();
    const inviteId = await projectInvitationsRepo.createPending({
      projectId: scene.projectId,
      invitedUserId: scene.memberId,
      role: "viewer",
      invitedBy: scene.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const token = await tokenOf("project_invitations", inviteId);

    await sql`
      UPDATE project_invitations SET deleted_at = now() WHERE id = ${inviteId}
    `;

    const found = await decisionRepo.resolveByToken(token);
    // Still findable — otherwise "this request is gone" is indistinguishable
    // from "this token was never real".
    expect(found).not.toBeNull();
    expect(found!.kind).toBe("project_invite");
    expect(found!.deleted).toBe(true);
  });
});
