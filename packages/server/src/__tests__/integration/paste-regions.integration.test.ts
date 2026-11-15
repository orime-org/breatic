// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A paste of an asset another region registered (inner#1955, design 6.15) —
 * real PG + Redis, the other region played by a stand-in.
 *
 * The pins:
 *
 *   1. An address this region's ledger does not know is asked of the other
 *      region by storage key, and the row it answers is registered in the
 *      target Studio against the same key, with no bytes moved.
 *   2. An address no region knows is left out of the map.
 *   3. A region that does not answer is skipped within the fan-out wait.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

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
import { getRedis, getStorageAdapter, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { mirrorAllInDirectory } from "./directory-fixtures.js";
import { startRegionStandIn, type RegionStandIn } from "./region-harness.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let sg: RegionStandIn;
let publicUrl: (key: string) => string;
let seq = 0;

beforeAll(async () => {
  sg = await startRegionStandIn();
  initCore({
    ...process.env,
    REGION: "us-west",
    GLOBAL_REGION: "us-west",
    REGION_API_URLS: JSON.stringify({ sg: sg.url }),
    ...GLOBAL_REGION_SETTINGS,
  });
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "paste-regions-test" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  const storage = await getStorageAdapter();
  publicUrl = (key) => storage.publicUrl(key);
});

afterEach(() => {
  sg.reset();
});

afterAll(async () => {
  initCore(process.env);
  await sg.close();
  await sql?.end({ timeout: 1 });
});

/**
 * A stored image key in the shape storage writes.
 * @returns The key.
 */
function imageKey(): string {
  return `image/2026-11-14/${Date.now()}${seq++}_${crypto.randomUUID()}.png`;
}

/**
 * A user with a personal Studio, a Project in it and a session.
 * @returns Their ids and session cookie.
 */
async function seedEditor(): Promise<{ userId: string; studioId: string; projectId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`paste-regions-${Date.now()}-${seq++}@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`paste-regions-s-${Date.now()}-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const slug = `paste-regions-p-${Date.now()}-${seq++}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, 'P', ${slug}) RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${user!.id}, 'owner', null)`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  await mirrorAllInDirectory(sql);
  return { userId: user!.id, studioId: studio!.id, projectId: project!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Paste addresses into a Project.
 * @param cookie - The session cookie.
 * @param projectId - The Project.
 * @param urls - The addresses.
 * @returns The response.
 */
async function paste(cookie: string, projectId: string, urls: string[]): Promise<Response> {
  return app.request("/api/v1/canvas/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId, urls, pairs: [], history: [] }),
  });
}

describe("pasting an asset another region registered", () => {
  it("registers the row the other region holds against the same key", async () => {
    const target = await seedEditor();
    const key = imageKey();
    const hash = crypto.randomBytes(32).toString("hex");
    sg.answers.findAssetsByKeys = (asked: unknown) =>
      Object.fromEntries((asked as string[]).map((k) => [k, {
        asset: k === key
          ? { id: crypto.randomUUID(), studioId: crypto.randomUUID(), contentHash: hash, storageKey: key, fileUrl: publicUrl(key), sizeBytes: 4096, mimeType: "image/png", kind: "image", source: "upload", width: 640, height: 480, durationSeconds: null }
          : null,
        cover: null,
      }]));

    const res = await paste(target.cookie, target.projectId, [publicUrl(key)]);

    expect(res.status).toBe(200);
    const rows = await sql<{ storage_key: string; content_hash: string; source: string }[]>`
      SELECT storage_key, content_hash, source FROM studio_assets WHERE studio_id = ${target.studioId} AND deleted_at IS NULL
    `;
    expect(rows).toEqual([{ storage_key: key, content_hash: hash, source: "upload" }]);
    expect(sg.received.map((call) => call.fn)).toEqual(["findAssetsByKeys"]);
  });

  it("asks no other region about an address this region already holds", async () => {
    const target = await seedEditor();
    const key = imageKey();
    const url = publicUrl(key);
    await sql`
      INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id, width, height)
      VALUES (${target.studioId}, ${crypto.randomBytes(32).toString("hex")}, ${key}, ${url}, 4096, 'image/png', 'image', 'upload', ${target.userId}, 640, 480)
    `;

    const res = await paste(target.cookie, target.projectId, [url]);

    expect(res.status).toBe(200);
    expect(sg.received).toEqual([]);
  });

  it("leaves out an address no region knows", async () => {
    const target = await seedEditor();
    const address = publicUrl(imageKey());

    const res = await paste(target.cookie, target.projectId, [address]);

    expect(res.status).toBe(200);
    expect((await res.json()).data.map).not.toHaveProperty(address);
  });

  it("skips a region that does not answer, waiting once for every address of the paste", async () => {
    const target = await seedEditor();
    sg.mode = "hang";
    const started = Date.now();

    const res = await paste(target.cookie, target.projectId, Array.from({ length: 8 }, () => publicUrl(imageKey())));

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
