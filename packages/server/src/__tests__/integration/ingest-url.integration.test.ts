// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /canvas/ingest-url` — handing the backend an address instead of bytes
 * (task #207, design §7.2).
 *
 * It is the sibling of `POST /assets/upload-ticket`: same gates, same rows, and
 * the same order. The one difference is who moves the bytes — there the browser
 * sends parts, here the ingest Worker fetches the address itself.
 *
 * The order those two rows are written in is what this suite pins hardest. The
 * grant has to exist first, because its storage key is the only thing the
 * settlement path can find the node task row by, and a row opened before the
 * grant carries no key to be found by.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The canvas routes reach the agent stack on import; this keeps it inert. */
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

const SOURCE = "https://cdn.test.invalid/clip.mp4";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "ingest-url-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh user, their personal studio, a project in it, and a session. */
async function seedEditor(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`iu-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`iu-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `iu-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;

  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    projectId,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * Submit an address.
 * @param cookie - The caller's session.
 * @param body - What to send, merged over a well-formed request.
 * @returns The route's answer.
 */
async function submit(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/v1/canvas/ingest-url", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      url: SOURCE,
      node_id: crypto.randomUUID(),
      ...body,
    }),
  });
}

/** How many grants and node task rows this project has. */
async function rowsFor(projectId: string): Promise<{
  grants: number;
  nodeTasks: number;
}> {
  const g = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM upload_grants WHERE project_id = ${projectId}
  `;
  const t = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM node_tasks WHERE project_id = ${projectId}
  `;
  return { grants: Number(g[0]!.n), nodeTasks: Number(t[0]!.n) };
}

describe("POST /canvas/ingest-url — what it takes", () => {
  it("accepts an address and answers with the task it opened", async () => {
    const { projectId, cookie } = await seedEditor();
    const spaceId = crypto.randomUUID();

    const res = await submit(cookie, { project_id: projectId, space_id: spaceId });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { task_id: string } };
    expect(body.data.task_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("opens the grant first, so the node task carries its key", async () => {
    // Settlement finds the node task row by the grant's storage key and by
    // nothing else, so a row opened before the grant exists can never be
    // settled — it would sit running until the budget judged it.
    const { projectId, cookie } = await seedEditor();
    const spaceId = crypto.randomUUID();

    await submit(cookie, { project_id: projectId, space_id: spaceId });

    const rows = await sql<{ storage_key: string | null }[]>`
      SELECT nt.storage_key
      FROM node_tasks nt
      WHERE nt.project_id = ${projectId}
    `;
    expect(rows).toHaveLength(1);
    const grants = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM upload_grants WHERE project_id = ${projectId}
    `;
    expect(grants).toHaveLength(1);
    expect(rows[0]!.storage_key).toBe(grants[0]!.storage_key);
  });

  it("opens the node task as an upload that is running", async () => {
    const { projectId, cookie } = await seedEditor();

    await submit(cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    const rows = await sql<{ kind: string; status: string }[]>`
      SELECT kind, status FROM node_tasks WHERE project_id = ${projectId}
    `;
    expect(rows[0]).toMatchObject({ kind: "upload", status: "running" });
  });
});

describe("POST /canvas/ingest-url — what the node's row says", () => {
  it("names the address without the credential in its query string", async () => {
    // A signed direct link is the commonest shape of an external address, and
    // its query string is a bearer credential for somebody else's origin. The
    // row is read by every viewer of this project and kept for good, while
    // what identifies the source to a reader is the address without it.
    const { projectId, cookie } = await seedEditor();

    await submit(cookie, {
      url: "https://cdn.test.invalid/a/clip.mp4?Expires=1757&Signature=s3cret",
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    const rows = await sql<{ label: string }[]>`
      SELECT label FROM node_tasks WHERE project_id = ${projectId}
    `;
    expect(rows[0]!.label).toBe("https://cdn.test.invalid/a/clip.mp4");
  });

  it("gives the row a budget this lane can reach, not the shared default", async () => {
    // The default is sized for a browser that may genuinely still be
    // uploading. Here one call is bounded, so a row left running by a restart
    // sits under a claim the code knows it cannot meet.
    const { projectId, cookie } = await seedEditor();

    await submit(cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    const rows = await sql<{ budget_ms: string }[]>`
      SELECT budget_ms FROM node_tasks WHERE project_id = ${projectId}
    `;
    expect(Number(rows[0]!.budget_ms)).toBe(590_000);
  });
});

describe("POST /canvas/ingest-url — when the queue will not take the job", () => {
  it("settles the row it already told everyone about", async () => {
    // The row and its counts reach every open canvas before the enqueue, which
    // is the last step that can still fail. Left running, the submitter alone
    // learns it failed while everyone else watches a task that never started.
    const { projectId, cookie } = await seedEditor();
    // Thrown at the queue rather than at Redis: what the route has to do is
    // the same whether the write was refused, the connection was gone, or the
    // instance was out of memory.
    const add = vi
      .spyOn(Queue.prototype, "add")
      .mockRejectedValue(new Error("OOM command not allowed"));

    try {
      const res = await submit(cookie, {
        project_id: projectId,
        space_id: crypto.randomUUID(),
      });
      expect(res.status).toBe(500);
    } finally {
      add.mockRestore();
    }

    const rows = await sql<{ status: string; error_message: string | null }[]>`
      SELECT status, error_message FROM node_tasks WHERE project_id = ${projectId}
    `;
    expect(rows[0]).toMatchObject({
      status: "failed",
      error_message: "not_started",
    });
  });
});

describe("POST /canvas/ingest-url — what it refuses", () => {
  it("refuses a caller with no session", async () => {
    const { projectId } = await seedEditor();

    const res = await app.request("/api/v1/canvas/ingest-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: SOURCE,
        project_id: projectId,
        space_id: crypto.randomUUID(),
        node_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(401);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses a stranger without telling them the project exists", async () => {
    const owner = await seedEditor();
    const stranger = await seedEditor();

    const res = await submit(stranger.cookie, {
      project_id: owner.projectId,
      space_id: crypto.randomUUID(),
    });

    // 404 rather than 403: someone with no role at all learns nothing about
    // whether that id names anything.
    expect(res.status).toBe(404);
    expect(await rowsFor(owner.projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses a viewer, who may read this project but not add to it", async () => {
    const owner = await seedEditor();
    const viewer = await seedEditor();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${viewer.userId}, 'viewer', ${owner.userId})
    `;

    const res = await submit(viewer.cookie, {
      project_id: owner.projectId,
      space_id: crypto.randomUUID(),
    });

    expect(res.status).toBe(403);
    expect(await rowsFor(owner.projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses an address that is not https", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await submit(cookie, {
      url: "http://cdn.test.invalid/clip.mp4",
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses an address past the length a url may be", async () => {
    // 2kB, the ceiling Google Docs publishes for the same kind of input.
    const { projectId, cookie } = await seedEditor();

    const res = await submit(cookie, {
      url: `https://cdn.test.invalid/${"a".repeat(2100)}.mp4`,
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses a request that names no node", async () => {
    // The result of this lane is a node's content, and the node's task list is
    // the only way its outcome can be read back.
    const { projectId, cookie } = await seedEditor();

    const res = await app.request("/api/v1/canvas/ingest-url", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        url: SOURCE,
        project_id: projectId,
        space_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(422);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });

  it("refuses one account submitting more than the window allows", async () => {
    // This is the one endpoint where a single call puts up to two gigabytes of
    // somebody else's bytes through our Worker, so how many of them one
    // account may start is part of deciding whether to take them at all.
    const { projectId, cookie } = await seedEditor();
    const spaceId = crypto.randomUUID();
    const { max } = getRateLimit("ingest-url");

    const answers: number[] = [];
    for (let n = 0; n <= max; n += 1) {
      const res = await submit(cookie, {
        project_id: projectId,
        space_id: spaceId,
      });
      answers.push(res.status);
    }

    expect(answers.slice(0, max)).toEqual(Array.from({ length: max }, () => 201));
    expect(answers.at(-1)).toBe(429);
    expect(await rowsFor(projectId)).toEqual({ grants: max, nodeTasks: max });
  });

  it("refuses when the studio has no storage left", async () => {
    const { studioId, userId, projectId, cookie } = await seedEditor();
    // Fill the account past its ceiling. The gate asks only whether anything
    // is left, which is what a caller handing over an address needs: nobody
    // can say how large the thing behind it is.
    await sql`
      INSERT INTO studio_assets
        (studio_id, content_hash, storage_key, file_url, size_bytes,
         mime_type, kind, source, produced_by_user_id)
      VALUES
        (${studioId}, ${crypto.randomBytes(32).toString("hex")},
         ${`video/${seq++}.mp4`}, 'https://cdn.test.invalid/x.mp4',
         ${"1000000000000000"}, 'video/mp4', 'video', 'upload', ${userId})
    `;

    const res = await submit(cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
    });

    expect(res.status).toBe(507);
    expect(await rowsFor(projectId)).toEqual({ grants: 0, nodeTasks: 0 });
  });
});
