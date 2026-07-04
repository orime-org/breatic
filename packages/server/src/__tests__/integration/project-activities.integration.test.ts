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
  it("two insertIgnoreDuplicateTask calls with one taskId leave ONE row", async () => {
    const { userId } = await insertUserWithStudio("Gen Author");
    const projectId = await insertProject(userId);
    const taskId = crypto.randomUUID();

    const first = await projectActivitiesRepo.insertIgnoreDuplicateTask({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend" },
    });
    const second = await projectActivitiesRepo.insertIgnoreDuplicateTask({
      projectId,
      actorUserId: userId,
      type: "generation:succeeded",
      taskId,
      payload: { source: "task", executedOn: "backend" },
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities WHERE task_id = ${taskId}
    `;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("GET /projects/:id/activities — keyset feed", () => {
  it("pages walk newest-first and stay stable when new rows land mid-walk", async () => {
    const { userId } = await insertUserWithStudio("Feed Author");
    const projectId = await insertProject(userId);
    const cookie = await loginCookie(userId);

    // Five rows, oldest to newest s0..s4.
    for (let i = 0; i < 5; i++) {
      await projectActivitiesRepo.insert({
        projectId,
        actorUserId: userId,
        type: "space:created",
        payload: { spaceName: `s${i}` },
      });
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
    await projectActivitiesRepo.insert({
      projectId,
      actorUserId: userId,
      type: "space:created",
      payload: { spaceName: "s5-mid-walk" },
    });

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

    await projectActivitiesRepo.consumeRestoreAndAppend(deleted!.id, {
      projectId,
      actorUserId: userId,
      type: "space:restored",
      spaceId,
      payload: { spaceName: "Doomed" },
    });

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
});
