// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every read the two `confirmInvite` transactions make must go through the
 * transaction handle — real Postgres.
 *
 * Those two transactions hold a row lock (`studios` / `projects`) for their
 * whole length. A read issued without the handle does not join the
 * transaction: it asks the pool for a SECOND connection while the first is
 * still held. Under concurrent confirms that is how the pool empties itself,
 * and it empties into a shape that does not recover — the connection the lock
 * holder cannot get is the one it needs before it can commit and let go, so
 * everything queued behind that row waits with it. Nothing times that wait
 * out: postgres.js queues a query until a pooled connection frees up and has
 * no option to bound that queue (`connect_timeout`, which does have a default,
 * bounds establishing a new socket — a different phase entirely).
 *
 * A signature that merely accepts a handle proves nothing; what these cases
 * pin is that the query actually runs inside the caller's transaction, by
 * asking it to see a write only that transaction can see. Delete the `tx ??`
 * from any of the three functions below and its case goes red.
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
import { and, eq } from "drizzle-orm";
import { initCore, db, schema, projectMembersRepo } from "@breatic/core";
import * as studioRepo from "@server/modules/studio/studio.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "tx-scoped-reads-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * An account with a personal studio, plus a team studio it administers and a
 * project inside that studio.
 * @returns The ids the cases need.
 */
async function seedScene(): Promise<{
  userId: string;
  teamStudioId: string;
  projectId: string;
}> {
  const tag = `txr-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`${tag}@example.test`}, true, 'pro') RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-personal`}, 'personal', ${`${tag} before`})
  `;
  const [team] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-team`}, 'team', 'Team') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${team!.id}, ${user!.id}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${team!.id}, ${user!.id}, 'Project', ${`${tag}-p`}) RETURNING id
  `;
  return { userId: user!.id, teamStudioId: team!.id, projectId: project!.id };
}

describe("reads inside the confirm transactions run inside them", () => {
  it("getPersonalProfilesByCreators sees a rename this transaction has not committed", async () => {
    const { userId } = await seedScene();

    await db.transaction(async (tx) => {
      await tx
        .update(schema.studios)
        .set({ name: "renamed in flight" })
        .where(
          and(
            eq(schema.studios.createdByUserId, userId),
            eq(schema.studios.type, "personal"),
          ),
        );
      const profiles = await studioRepo.getPersonalProfilesByCreators(
        [userId],
        tx,
      );
      expect(profiles.get(userId)?.name).toBe("renamed in flight");
    });
  });

  it("countMembersByStudioIds counts a member this transaction has not committed", async () => {
    const { teamStudioId } = await seedScene();
    const other = await seedScene();

    await db.transaction(async (tx) => {
      await tx.insert(schema.studioMembers).values({
        studioId: teamStudioId,
        userId: other.userId,
        role: "guest",
      });
      const counts = await studioRepo.countMembersByStudioIds(
        [teamStudioId],
        tx,
      );
      expect(counts.get(teamStudioId)).toBe(2);
    });
  });

  it("countExplicitMembers counts a collaborator this transaction has not committed", async () => {
    const { projectId, userId } = await seedScene();
    const other = await seedScene();

    await db.transaction(async (tx) => {
      await tx.insert(schema.projectMembers).values({
        projectId,
        userId: other.userId,
        role: "viewer",
        addedBy: userId,
      });
      expect(await projectMembersRepo.countExplicitMembers(projectId, tx)).toBe(
        1,
      );
    });
  });
});
