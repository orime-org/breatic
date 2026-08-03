// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Filing a request mints its share token, in all five flows.
 *
 * The column is NOT NULL, so this is not a nicety: a repo that forgets to mint
 * one cannot insert at all. What this suite pins is that no flow was left out
 * and that the tokens are actually distinct — a shared constant would satisfy
 * NOT NULL and satisfy a per-table unique index too, right up until the second
 * request in the same table.
 *
 * Minting lives in the repo rather than in each service, because the token is
 * part of the row: five services each remembering to pass one is five chances
 * to forget, and the one that forgets fails at runtime rather than at compile
 * time.
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
    connection: { application_name: "share-token-minting-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Reads back the token a freshly filed request was given.
 * @param table - The request table to read from.
 * @param id - The row's id.
 * @returns That row's `share_token`.
 * @throws {Error} when the row is missing, which means the insert did not land.
 */
async function tokenOf(table: string, id: string): Promise<string> {
  const rows = await sql<{ share_token: string }[]>`
    SELECT share_token FROM ${sql(table)} WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`${table}: no row ${id}`);
  return row.share_token;
}

interface Scene {
  ownerId: string;
  memberId: string;
  studioId: string;
  projectId: string;
}

/**
 * A team studio with two members and one project — the least all five flows
 * need in order to be filed.
 * @returns The seeded ids.
 * @throws {Error} when any seed insert returns no row.
 */
async function seedScene(): Promise<Scene> {
  const tag = `stm-${seq++}-${Date.now()}`;
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

describe("every flow mints a share token when the request is filed", () => {
  it("all five repos produce a 64-hex token, and no two are alike", async () => {
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

    const tokens = await Promise.all([
      tokenOf("studio_invitations", studioInviteId),
      tokenOf("project_invitations", projectInviteId),
      tokenOf("role_upgrade_requests", roleUpgradeId),
      tokenOf("project_transfers", projectTransferId),
      tokenOf("studio_transfers", studioTransferId),
    ]);

    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
    // Distinctness is the point: NOT NULL and a per-table unique index would
    // both be satisfied by one shared constant.
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("two requests in the same table get different tokens", async () => {
    const first = await seedScene();
    const second = await seedScene();

    const a = await studioInvitationsRepo.createPending({
      studioId: first.studioId,
      invitedUserId: first.memberId,
      role: "guest",
      invitedBy: first.ownerId,
      expiresAt: IN_A_WEEK(),
    });
    const b = await studioInvitationsRepo.createPending({
      studioId: second.studioId,
      invitedUserId: second.memberId,
      role: "guest",
      invitedBy: second.ownerId,
      expiresAt: IN_A_WEEK(),
    });

    const [tokenA, tokenB] = await Promise.all([
      tokenOf("studio_invitations", a),
      tokenOf("studio_invitations", b),
    ]);
    expect(tokenA).not.toBe(tokenB);
  });
});
