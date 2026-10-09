// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /canvas/paste` — a paste counts as an upload into the Studio it lands
 * in (inner#1349, design 5.4).
 *
 * No bytes move: an address the target Studio already holds by hash is used as
 * it is, an address it lacks is registered against the same storage key, and a
 * video brings its cover with it. Each copy gets one history row written from
 * its own data, with addresses taken from the server's own answer.
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
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getStorageAdapter,
} from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let publicUrl: (key: string) => string;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "canvas-paste-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  const storage = await getStorageAdapter();
  publicUrl = (key) => storage.publicUrl(key);
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A stored key in the shape storage writes. */
function key(kind: "image" | "video", cover = false): string {
  const id = crypto.randomUUID();
  return `${kind}/2026-10-09/${Date.now()}${seq++}_${id}${cover ? "_cover" : ""}.${cover ? "png" : kind === "image" ? "png" : "mp4"}`;
}

/** A user with a personal studio, a project in it, and a session. */
async function seedEditor(): Promise<{ userId: string; studioId: string; projectId: string; cookie: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`cp-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`cp-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'admin')`;
  const slug = `cp-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${userId}, 'owner', null)`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/** One ledger row. */
async function asset(
  studioId: string,
  userId: string,
  opts: { key: string; hash?: string; kind?: "image" | "video"; source?: string; sizeBytes?: string; coverAssetId?: string },
): Promise<{ id: string; url: string; hash: string }> {
  const hash = opts.hash ?? crypto.randomBytes(32).toString("hex");
  const kind = opts.kind ?? "image";
  const url = publicUrl(opts.key);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source,
       produced_by_user_id, width, height, cover_asset_id)
    VALUES
      (${studioId}, ${hash}, ${opts.key}, ${url}, ${opts.sizeBytes ?? "4096"},
       ${kind === "image" ? "image/png" : "video/mp4"}, ${kind}, ${opts.source ?? "upload"},
       ${userId}, 640, 480, ${opts.coverAssetId ?? null})
    RETURNING id
  `;
  return { id: rows[0]!.id, url, hash };
}

/** Fill a studio's storage. */
async function fill(studioId: string, userId: string): Promise<void> {
  await asset(studioId, userId, { key: key("video"), kind: "video", sizeBytes: "1000000000000000" });
}

/** Send a paste. */
async function paste(
  cookie: string,
  projectId: string,
  body: { urls?: string[]; pairs?: Array<{ url: string; cover: string }>; history?: unknown[] },
): Promise<Response> {
  return app.request("/api/v1/canvas/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      project_id: projectId,
      space_id: crypto.randomUUID(),
      urls: body.urls ?? [],
      pairs: body.pairs ?? [],
      history: body.history ?? [],
    }),
  });
}

/** The ledger rows of a studio, oldest first. */
async function ledger(studioId: string): Promise<Array<{ id: string; storage_key: string; content_hash: string; source: string; cover_asset_id: string | null; file_url: string }>> {
  return sql`
    SELECT id, storage_key, content_hash, source, cover_asset_id, file_url
    FROM studio_assets WHERE studio_id = ${studioId} AND deleted_at IS NULL ORDER BY created_at, id
  `;
}

/** History rows of a node. */
async function history(projectId: string, nodeId: string): Promise<Array<{ entry_type: string; content: string; thumbnail_url: string | null; user_id: string; media_width: number | null; mime_type: string | null }>> {
  return sql`
    SELECT entry_type, content, thumbnail_url, user_id, media_width, mime_type
    FROM node_history WHERE project_id = ${projectId} AND node_id = ${nodeId}
  `;
}

describe("POST /canvas/paste", () => {
  it("uses what the same studio already holds and writes one upload row from the copy's data", async () => {
    const a = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const before = (await ledger(a.studioId)).length;
    const node = crypto.randomUUID();
    const res = await paste(a.cookie, a.projectId, {
      urls: [img.url],
      history: [{ node_id: node, kind: "media", content: img.url, width: 640, height: 480, mimeType: "image/png", size: 4096 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map).toEqual({ [img.url]: img.url });
    expect(await ledger(a.studioId)).toHaveLength(before);
    expect(await history(a.projectId, node)).toEqual([
      { entry_type: "upload", content: img.url, thumbnail_url: null, user_id: a.userId, media_width: 640, mime_type: "image/png" },
    ]);
  });

  it("registers an address the target studio lacks against the same key, as an upload", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const res = await paste(b.cookie, b.projectId, { urls: [img.url] });
    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content_hash: img.hash, source: "upload" });
    expect((await res.json()).data.map[img.url]).toBe(rows[0]!.file_url);
  });

  it("maps to the row the target studio already holds under another key, and history follows it", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const theirs = await asset(b.studioId, b.userId, { key: key("image"), hash: img.hash });
    await fill(b.studioId, b.userId);
    const node = crypto.randomUUID();
    const res = await paste(b.cookie, b.projectId, {
      urls: [img.url],
      history: [{ node_id: node, kind: "media", content: img.url }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map).toEqual({ [img.url]: theirs.url });
    expect((await history(b.projectId, node))[0]?.content).toBe(theirs.url);
  });

  it("registers a video with its own cover, the cover as source cover", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    const node = crypto.randomUUID();
    const res = await paste(b.cookie, b.projectId, {
      pairs: [{ url: vid.url, cover: cover.url }],
      urls: [cover.url],
      history: [{ node_id: node, kind: "media", content: vid.url, coverUrl: cover.url }],
    });
    expect(res.status).toBe(200);
    const map = (await res.json()).data.map;
    const rows = await ledger(b.studioId);
    const coverRow = rows.find((r) => r.content_hash === cover.hash);
    const videoRow = rows.find((r) => r.content_hash === vid.hash);
    expect(rows).toHaveLength(2);
    expect(coverRow?.source).toBe("cover");
    expect(videoRow?.cover_asset_id).toBe(coverRow?.id);
    expect(map[cover.url]).toBe(coverRow?.file_url);
    expect((await history(b.projectId, node))[0]?.thumbnail_url).toBe(coverRow?.file_url);
  });

  it("links a cover to a video the target studio holds without one", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    const theirs = await asset(b.studioId, b.userId, { key: key("video"), kind: "video", hash: vid.hash });
    const res = await paste(b.cookie, b.projectId, { pairs: [{ url: vid.url, cover: cover.url }] });
    expect(res.status).toBe(200);
    const [row] = await sql<{ cover_asset_id: string | null }[]>`SELECT cover_asset_id FROM studio_assets WHERE id = ${theirs.id}`;
    expect(row?.cover_asset_id).not.toBeNull();
  });

  it("uses the target video's own cover when it has one, writing nothing even when full", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    const theirCover = await asset(b.studioId, b.userId, { key: key("video", true), source: "cover" });
    const theirs = await asset(b.studioId, b.userId, { key: key("video"), kind: "video", hash: vid.hash, coverAssetId: theirCover.id });
    await fill(b.studioId, b.userId);
    const before = (await ledger(b.studioId)).length;
    const res = await paste(b.cookie, b.projectId, { pairs: [{ url: vid.url, cover: cover.url }], urls: [cover.url] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map).toEqual({ [vid.url]: theirs.url, [cover.url]: theirCover.url });
    expect(await ledger(b.studioId)).toHaveLength(before);
  });

  it("refuses with 507 and writes nothing when the target is full and something must be registered", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const one = await asset(a.studioId, a.userId, { key: key("image") });
    const two = await asset(a.studioId, a.userId, { key: key("image") });
    await fill(b.studioId, b.userId);
    const before = (await ledger(b.studioId)).length;
    const node = crypto.randomUUID();
    const res = await paste(b.cookie, b.projectId, {
      urls: [one.url, two.url],
      history: [{ node_id: node, kind: "media", content: one.url }],
    });
    expect(res.status).toBe(507);
    expect(await ledger(b.studioId)).toHaveLength(before);
    expect(await history(b.projectId, node)).toEqual([]);
  });

  it("keeps a text copy's words as a snapshot row, with no ledger rows", async () => {
    const a = await seedEditor();
    const before = (await ledger(a.studioId)).length;
    const node = crypto.randomUUID();
    const res = await paste(a.cookie, a.projectId, { history: [{ node_id: node, kind: "text", content: "hello\nworld" }] });
    expect(res.status).toBe(200);
    expect((await history(a.projectId, node)).map((r) => [r.entry_type, r.content])).toEqual([["snapshot", "hello\nworld"]]);
    expect(await ledger(a.studioId)).toHaveLength(before);
  });

  it("leaves an address no ledger knows out of the map and writes it no history", async () => {
    const a = await seedEditor();
    const stray = publicUrl(key("image"));
    const node = crypto.randomUUID();
    const res = await paste(a.cookie, a.projectId, {
      urls: [stray],
      history: [{ node_id: node, kind: "media", content: stray }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map).toEqual({});
    expect(await history(a.projectId, node)).toEqual([]);
  });

  it("answers 403 to someone who cannot edit the project", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const res = await paste(b.cookie, a.projectId, {});
    expect(res.status).toBe(403);
  });
});
