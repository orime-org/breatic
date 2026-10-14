// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/ingest-url` — an address fetched into storage with no node
 * behind it (inner#1351 + inner#1390 design §4.1, A10).
 *
 * The document body's lane for an outside address. It takes the same gates
 * as `POST /canvas/ingest-url` and queues the same job; what differs is that
 * no node task row is opened, and the browser reads how the fetch ended from
 * `GET /assets/upload-status` under the storage key this answers.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The routes reach the agent stack on import; this keeps it inert. */
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
import { Queue } from "bullmq";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import { getRateLimit } from "@server/config/rate-limits.js";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const SOURCE = "https://cdn.test.invalid/picture.jpg";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "assets-ingest-url-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * A fresh user, their personal studio, a project in it, and a session.
 * @returns The ids and the session cookie.
 */
async function seedEditor(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`aiu-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`aiu-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `aiu-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug})
    RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Submit an address.
 * @param cookie - The caller's session.
 * @param body - What to send, merged over a well-formed request.
 * @returns The route's answer.
 */
async function submit(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/v1/assets/ingest-url", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ url: SOURCE, space_id: crypto.randomUUID(), ...body }),
  });
}

/**
 * How many grants and node task rows this project has.
 * @param projectId - The project.
 * @returns The counts.
 */
async function rowsFor(projectId: string): Promise<{ grants: number; nodeTasks: number }> {
  const g = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM upload_grants WHERE project_id = ${projectId}
  `;
  const t = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM node_tasks WHERE project_id = ${projectId}
  `;
  return { grants: Number(g[0]!.n), nodeTasks: Number(t[0]!.n) };
}

describe("POST /assets/ingest-url — what it takes", () => {
  it("opens a grant with no node task and answers its storage key", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await submit(cookie, { project_id: projectId });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { storage_key: string } };
    const grants = await sql<{ storage_key: string; node_id: string | null }[]>`
      SELECT storage_key, node_id FROM upload_grants WHERE project_id = ${projectId}
    `;
    expect(grants).toEqual([{ storage_key: body.data.storage_key, node_id: null }]);
    expect(await rowsFor(projectId)).toEqual({ grants: 1, nodeTasks: 0 });
  });

  it("queues the fetch with no node to write to", async () => {
    const { projectId, cookie } = await seedEditor();
    const add = vi.spyOn(Queue.prototype, "add");
    try {
      const res = await submit(cookie, { project_id: projectId });
      expect(res.status).toBe(201);
      const [name, data] = add.mock.calls.at(-1)!;
      expect(name).toBe("ingest-url");
      expect(data).toMatchObject({ url: SOURCE, projectId });
      expect(data).not.toHaveProperty("nodeId");
    } finally {
      add.mockRestore();
    }
  });
});

describe("POST /assets/ingest-url — when the queue will not take the job", () => {
  it("answers 500 and the status query reads the fetch as failed", async () => {
    const { projectId, cookie } = await seedEditor();
    const add = vi.spyOn(Queue.prototype, "add").mockRejectedValue(new Error("OOM command not allowed"));
    try {
      const res = await submit(cookie, { project_id: projectId });
      expect(res.status).toBe(500);
    } finally {
      add.mockRestore();
    }
    const grants = await sql<{ storage_key: string; voided_at: Date | null }[]>`
      SELECT storage_key, voided_at FROM upload_grants WHERE project_id = ${projectId}
    `;
    expect(grants).toHaveLength(1);
    const status = await app.request(
      `/api/v1/assets/upload-status?key=${encodeURIComponent(grants[0]!.storage_key)}`,
      { headers: { cookie } },
    );
    const answer = (await status.json()) as { data: { items: { state: string }[] } };
    expect(answer.data.items[0]!.state).toBe("failed");
  });
});

describe("POST /assets/ingest-url — what it refuses", () => {
  it("refuses a caller with no session", async () => {
    const { projectId } = await seedEditor();
    const res = await submit("", { project_id: projectId });
    expect(res.status).toBe(401);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses a stranger without telling them the project exists", async () => {
    const owner = await seedEditor();
    const stranger = await seedEditor();
    const res = await submit(stranger.cookie, { project_id: owner.projectId });
    expect(res.status).toBe(404);
    expect(await rowsFor(owner.projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses a viewer", async () => {
    const owner = await seedEditor();
    const viewer = await seedEditor();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${viewer.userId}, 'viewer', ${owner.userId})
    `;
    const res = await submit(viewer.cookie, { project_id: owner.projectId });
    expect(res.status).toBe(403);
    expect(await rowsFor(owner.projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses an address that is not https", async () => {
    const { projectId, cookie } = await seedEditor();
    const res = await submit(cookie, { url: "http://cdn.test.invalid/picture.jpg", project_id: projectId });
    expect(res.status).toBe(422);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses when the studio has no storage left", async () => {
    const { studioId, userId, projectId, cookie } = await seedEditor();
    await sql`
      INSERT INTO studio_assets
        (studio_id, content_hash, storage_key, file_url, size_bytes,
         mime_type, kind, source, produced_by_user_id)
      VALUES
        (${studioId}, ${crypto.randomBytes(32).toString("hex")},
         ${`image/${seq++}.png`}, 'https://cdn.test.invalid/x.png',
         ${"1000000000000000"}, 'image/png', 'image', 'upload', ${userId})
    `;
    const res = await submit(cookie, { project_id: projectId });
    expect(res.status).toBe(507);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("shares one window with the canvas lane, so one account cannot double its fetches", async () => {
    const { projectId, cookie } = await seedEditor();
    const { max } = getRateLimit("ingest-url");
    for (let n = 0; n < max; n += 1) {
      const res = await app.request("/api/v1/canvas/ingest-url", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          url: SOURCE,
          project_id: projectId,
          space_id: crypto.randomUUID(),
          node_id: crypto.randomUUID(),
        }),
      });
      expect(res.status).toBe(201);
    }
    const res = await submit(cookie, { project_id: projectId });
    expect(res.status).toBe(429);
  });
});
