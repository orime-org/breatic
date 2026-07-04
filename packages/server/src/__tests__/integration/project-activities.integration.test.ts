// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project activity feed — real-PG integration (ADR 2026-07-04
 * project-activity-feed).
 *
 * Pins the data invariants unit mocks cannot:
 *   - generation idempotency: two inserts with one taskId → ONE row
 *     (partial UNIQUE + ON CONFLICT), the billed-redelivery guard;
 *   - keyset pagination: page walk is stable when NEW rows land
 *     between page fetches (the reason offset pagination was rejected);
 *   - actor names resolve through the personal-studio join;
 *   - the upload handshake refuses a key that does not exist in
 *     storage (head() verification) and records nothing;
 *   - restore consumption: consumeRestoreAndAppend flips restored and
 *     appends the space:restored row in one transaction.
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

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  loadLocales,
  projectActivitiesRepo,
} from "@breatic/core";
import type { ProjectActivityPage } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "activities-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a user + personal studio (display name source); returns ids. */
async function insertUserWithStudio(
  name: string,
): Promise<{ userId: string; studioId: string }> {
  const email = `act-${seq++}@example.com`;
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const slug = `act-p-${seq++}`;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${slug}, 'personal', ${name}) RETURNING id
  `;
  return { userId, studioId: studios[0]!.id };
}

/** Insert a team studio + project owned by `ownerUserId`; returns project id. */
async function insertProject(ownerUserId: string): Promise<string> {
  const slug = `act-studio-${seq++}`;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerUserId}, ${slug}, 'team', ${`S ${slug}`}) RETURNING id
  `;
  const pslug = `act-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studios[0]!.id}, ${ownerUserId}, ${`P ${pslug}`}, ${pslug}, 'private')
    RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerUserId}, 'owner', null)
  `;
  return projectId;
}

/** Mint a real Redis session; returns the Cookie header. */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `breatic_session=${token}`;
}

describe("generation idempotency (billed-redelivery guard)", () => {
  it("two success upserts with one taskId leave ONE row", async () => {
    const { userId } = await insertUserWithStudio("Gen Author");
    const projectId = await insertProject(userId);
    const taskId = crypto.randomUUID();

    // A billed redelivery re-asserts success — the upsert refreshes the
    // single row rather than duplicating it.
    await projectActivitiesRepo.upsertGenerationSucceeded({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend" },
    });
    await projectActivitiesRepo.upsertGenerationSucceeded({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend" },
    });

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities WHERE task_id = ${taskId}
    `;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("generation outcome authority (success wins, failure never overwrites)", () => {
  it("a later success OVERWRITES a premature/crash-net failed row (same task, one row, succeeded)", async () => {
    const { userId } = await insertUserWithStudio("Outcome A");
    const projectId = await insertProject(userId);
    const taskId = crypto.randomUUID();

    // Premature failure lands first (e.g. crash-net on a stall that
    // later resumed and succeeded).
    await projectActivitiesRepo.insertGenerationFailedIfAbsent({
      projectId,
      actorUserId: userId,
      type: "generation:failed",
      taskId,
      payload: { source: "task", executedOn: "backend", errorMessage: "stalled" },
    });
    // The winning attempt asserts success.
    await projectActivitiesRepo.upsertGenerationSucceeded({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend", outputCount: 1 },
    });

    const rows = await sql<{ type: string }[]>`
      SELECT type FROM project_activities WHERE task_id = ${taskId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("generation:succeeded");
  });

  it("a crash-net failure does NOT overwrite an existing success (feed stays succeeded)", async () => {
    const { userId } = await insertUserWithStudio("Outcome B");
    const projectId = await insertProject(userId);
    const taskId = crypto.randomUUID();

    await projectActivitiesRepo.upsertGenerationSucceeded({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend", outputCount: 1 },
    });
    // A late crash-net failure for the same task must be a no-op.
    const inserted = await projectActivitiesRepo.insertGenerationFailedIfAbsent({
      projectId,
      actorUserId: userId,
      type: "generation:failed",
      taskId,
      payload: { source: "task", executedOn: "backend", errorMessage: "late net" },
    });
    expect(inserted).toBeNull();

    const rows = await sql<{ type: string }[]>`
      SELECT type FROM project_activities WHERE task_id = ${taskId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("generation:succeeded");
  });
});

describe("GET /projects/:id/activities — keyset feed", () => {
  it("pages walk newest-first and stay stable when new rows land mid-walk", async () => {
    const { userId } = await insertUserWithStudio("Feed Author");
    const projectId = await insertProject(userId);
    const cookie = await loginCookie(userId);

    // Five rows, oldest to newest s0..s4. created_at is set explicitly
    // per row: bulk inserts can land inside one millisecond, and the
    // (created_at, id) tie-break on a random uuid would make the order
    // assertion flaky (bitten in the full concurrent suite run).
    for (let i = 0; i < 5; i++) {
      const id = await projectActivitiesRepo.insert({
        projectId,
        actorUserId: userId,
        type: "space:created",
        payload: { spaceName: `s${i}` },
      });
      await sql`
        UPDATE project_activities
        SET created_at = to_timestamp(1783000000 + ${i})
        WHERE id = ${id}
      `;
    }

    const page1Res = await app.request(
      `/api/v1/projects/${projectId}/activities?limit=2`,
      { headers: { Cookie: cookie } },
    );
    expect(page1Res.status).toBe(200);
    const page1 = ((await page1Res.json()) as { data: ProjectActivityPage }).data;
    expect(page1.items.map((i) => i.payload["spaceName"])).toEqual(["s4", "s3"]);
    expect(page1.nextCursor).not.toBeNull();

    // A NEW row lands between page fetches — offset pagination would
    // shift the window and re-serve s3; keyset must continue at s2.
    const midId = await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:created",
      payload: { spaceName: "s5-mid-walk" },
    });
    await sql`
      UPDATE project_activities
      SET created_at = to_timestamp(1783000100)
      WHERE id = ${midId}
    `;

    const page2Res = await app.request(
      `/api/v1/projects/${projectId}/activities?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      { headers: { Cookie: cookie } },
    );
    const page2 = ((await page2Res.json()) as { data: ProjectActivityPage }).data;
    expect(page2.items.map((i) => i.payload["spaceName"])).toEqual(["s2", "s1"]);

    // Actor display name resolves through the personal-studio join.
    expect(page1.items[0]!.actorName).toBe("Feed Author");
  });

  it("404 for a non-member (existence hidden); garbage cursor falls back to page 1", async () => {
    const { userId } = await insertUserWithStudio("Owner X");
    const stranger = await insertUserWithStudio("Stranger");
    const projectId = await insertProject(userId);

    const res = await app.request(
      `/api/v1/projects/${projectId}/activities`,
      { headers: { Cookie: await loginCookie(stranger.userId) } },
    );
    expect(res.status).toBe(404);

    const garbage = await app.request(
      `/api/v1/projects/${projectId}/activities?cursor=%%%garbage`,
      { headers: { Cookie: await loginCookie(userId) } },
    );
    expect(garbage.status).toBe(200);
  });
});

describe("POST /assets/uploaded — handshake verification", () => {
  it("422 and NO activity row when the storage object does not exist", async () => {
    const { userId } = await insertUserWithStudio("Uploader");
    const projectId = await insertProject(userId);

    const res = await app.request("/api/v1/assets/uploaded", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await loginCookie(userId),
      },
      body: JSON.stringify({
        project_id: projectId,
        key: "nonexistent/never-uploaded.png",
        kind: "image",
      }),
    });
    expect(res.status).toBe(422);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    expect(rows[0]!.n).toBe(0);
  });

  it("422 and NO row for a key not owned by the caller + project (cross-project / traversal guard)", async () => {
    const { userId } = await insertUserWithStudio("Owner Y");
    const attacker = await insertUserWithStudio("Attacker");
    const projectId = await insertProject(userId);
    // Attacker is a real editor on the project.
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${attacker.userId}, 'editor', ${userId})
    `;
    const cookie = await loginCookie(attacker.userId);

    // A key belonging to ANOTHER user / project (foreign asset URL the
    // attacker has seen). Even if the object exists in storage, it must
    // be refused because it is not bound to (attacker, projectId).
    const foreignKey = `${userId}/some-other-project/image/2026-07-04/x.png`;
    const cross = await app.request("/api/v1/assets/uploaded", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, key: foreignKey, kind: "image" }),
    });
    expect(cross.status).toBe(422);

    // A path-traversal key is refused before head() even runs.
    const traversal = await app.request("/api/v1/assets/uploaded", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        project_id: projectId,
        key: `${attacker.userId}/${projectId}/../../../../etc/hostname`,
        kind: "image",
      }),
    });
    expect(traversal.status).toBe(422);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    expect(rows[0]!.n).toBe(0);
  });

  it("records asset:uploaded after a real local upload round-trip", async () => {
    const { userId } = await insertUserWithStudio("Uploader 2");
    const projectId = await insertProject(userId);
    const cookie = await loginCookie(userId);

    // Presign against local storage, PUT the bytes, then handshake.
    const presign = await app.request(
      `/api/v1/assets/presign?filename=a.png&content_type=image/png&project_id=${projectId}`,
      { headers: { Cookie: cookie } },
    );
    expect(presign.status).toBe(200);
    const { uploadUrl, key } = (
      (await presign.json()) as { data: { uploadUrl: string; key: string } }
    ).data;
    const putPath = new URL(uploadUrl).pathname;
    const put = await app.request(putPath, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Cookie: cookie },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    expect(put.status).toBe(200);

    const handshake = await app.request("/api/v1/assets/uploaded", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, key, kind: "image" }),
    });
    expect(handshake.status).toBe(200);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("POST /assets/deleted — report guards", () => {
  it("400 for an over-long file_url (feed-bloat cap)", async () => {
    const { userId } = await insertUserWithStudio("Deleter");
    const projectId = await insertProject(userId);
    const res = await app.request("/api/v1/assets/deleted", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await loginCookie(userId),
      },
      body: JSON.stringify({
        project_id: projectId,
        entries: [{ file_url: `http://x/${"A".repeat(4000)}`, kind: "image" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits a report flood (429 before the window resets)", async () => {
    const { userId } = await insertUserWithStudio("Flooder");
    const projectId = await insertProject(userId);
    const cookie = await loginCookie(userId);
    const body = JSON.stringify({
      project_id: projectId,
      entries: [{ file_url: "http://x/f.png", kind: "image" }],
    });
    // The limiter is 120/60s per user; fire past it and assert a 429
    // appears (any authenticated editor could otherwise flood the
    // append-only feed table). Break as soon as it trips.
    let tripped = false;
    for (let i = 0; i < 130 && !tripped; i++) {
      const res = await app.request("/api/v1/assets/deleted", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body,
      });
      if (res.status === 429) tripped = true;
    }
    expect(tripped).toBe(true);
  });
});

describe("deleteProject cascade soft-deletes the feed", () => {
  it("a deleted project's activity rows are soft-deleted + excluded from the feed", async () => {
    const { userId } = await insertUserWithStudio("Deleter Owner");
    const projectId = await insertProject(userId);
    await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:created",
      payload: { spaceName: "S" },
    });
    // Before delete: one live row.
    const before = await projectActivitiesRepo.listByProject(projectId, null, 50);
    expect(before).toHaveLength(1);

    const { deleteProject } = await import(
      "@server/modules/project/project.repo.js"
    );
    await deleteProject(projectId);

    // The rows are soft-deleted (deleted_at stamped) and no longer served.
    const after = await projectActivitiesRepo.listByProject(projectId, null, 50);
    expect(after).toHaveLength(0);
    const live = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `;
    expect(live[0]!.n).toBe(0);
    const total = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities WHERE project_id = ${projectId}
    `;
    expect(total[0]!.n).toBe(1); // row still present, just soft-deleted
  });
});

describe("restore consumption transaction", () => {
  it("consumeRestoreAndAppend flips restored + appends space:restored atomically", async () => {
    const { userId } = await insertUserWithStudio("Restorer");
    const projectId = await insertProject(userId);
    const spaceId = crypto.randomUUID();

    await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:deleted",
      spaceId,
      payload: { spaceName: "Doomed", spaceSnapshot: { id: spaceId } },
    });
    const deleted = await projectActivitiesRepo.latestUnrestoredDeleted(
      projectId,
      spaceId,
    );
    expect(deleted).not.toBeNull();

    const won = await projectActivitiesRepo.consumeRestoreAndAppend(
      deleted!.id,
      {
        projectId,
        actorUserId: userId,
        type: "space:restored",
        spaceId,
        payload: { spaceName: "Doomed" },
      },
    );
    expect(won).toBe(true);

    // The deleted row is consumed — a second restore finds nothing…
    expect(
      await projectActivitiesRepo.latestUnrestoredDeleted(projectId, spaceId),
    ).toBeNull();
    // …and the restored row exists.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'space:restored'
    `;
    expect(rows[0]!.n).toBe(1);

    // delete → restore → delete → restore loop: a NEW deletion record
    // is its own restore source.
    await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:deleted",
      spaceId,
      payload: { spaceName: "Doomed", spaceSnapshot: { id: spaceId } },
    });
    const second = await projectActivitiesRepo.latestUnrestoredDeleted(
      projectId,
      spaceId,
    );
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(deleted!.id);
  });

  it("consume is a CAS: a second consume of the same deleted row loses (no duplicate space:restored)", async () => {
    const { userId } = await insertUserWithStudio("Racer");
    const projectId = await insertProject(userId);
    const spaceId = crypto.randomUUID();
    await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:deleted",
      spaceId,
      payload: { spaceName: "Raced", spaceSnapshot: { id: spaceId } },
    });
    const deleted = await projectActivitiesRepo.latestUnrestoredDeleted(
      projectId,
      spaceId,
    );
    const restoredRow = {
      projectId,
      actorUserId: userId,
      type: "space:restored" as const,
      spaceId,
      payload: { spaceName: "Raced" },
    };
    // Two instances race the SAME deleted row: exactly one wins + appends.
    const [a, b] = await Promise.all([
      projectActivitiesRepo.consumeRestoreAndAppend(deleted!.id, restoredRow),
      projectActivitiesRepo.consumeRestoreAndAppend(deleted!.id, restoredRow),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'space:restored'
    `;
    expect(rows[0]!.n).toBe(1);
  });
});
