// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import fc from "fast-check";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getStorageAdapter,
  coverKeyFor,
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
    INSERT INTO users (email, email_verified) VALUES (${`canvas-paste-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`canvas-paste-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'admin')`;
  const slug = `canvas-paste-proj-${seq++}`;
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

  // A picture turned upright is filed under its upright copy's key with the
  // received bytes' hash (inner#1367 §4.5); pasting it carries both over.
  it("registers a picture turned upright against its upright key, with the received hash", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const uprightKey = key("image").replace(/\.png$/, "_upright.png");
    const img = await asset(a.studioId, a.userId, { key: uprightKey });

    const res = await paste(b.cookie, b.projectId, { urls: [img.url] });

    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content_hash: img.hash, storage_key: uprightKey });
    // The row counts against the target studio's storage at the copy's size.
    const [counted] = await sql<Array<{ size_bytes: string }>>`
      SELECT size_bytes FROM studio_assets WHERE id = ${rows[0]!.id}
    `;
    expect(counted?.size_bytes).toBe("4096");
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

  it("keeps a text copy's words however long they are, as the snapshot route does", async () => {
    const a = await seedEditor();
    const node = crypto.randomUUID();
    const words = "x".repeat(250_000);
    const res = await paste(a.cookie, a.projectId, { history: [{ node_id: node, kind: "text", content: words }] });
    expect(res.status).toBe(200);
    expect((await history(a.projectId, node)).map((r) => r.content.length)).toEqual([words.length]);
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

  // A document block holds only the video's address (inner#1537 §5.4): the
  // server files the cover the ledger knows, the way an upload does.
  it("registers a video named alone together with the cover its row points at", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const videoKey = key("video");
    const cover = await asset(a.studioId, a.userId, { key: coverKeyFor(videoKey), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: videoKey, kind: "video", coverAssetId: cover.id });
    const res = await paste(b.cookie, b.projectId, { urls: [vid.url] });
    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    const coverRow = rows.find((r) => r.content_hash === cover.hash);
    const videoRow = rows.find((r) => r.content_hash === vid.hash);
    expect(coverRow?.source).toBe("cover");
    expect(videoRow?.cover_asset_id).toBe(coverRow?.id);
    expect((await res.json()).data.map).toEqual({ [vid.url]: videoRow?.file_url, [cover.url]: coverRow?.file_url });
  });

  it("takes the cover from another row under the same key when the first row it finds has none", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const c = await seedEditor();
    const shared = key("video");
    const hash = crypto.randomBytes(32).toString("hex");
    // Filed first and without a cover, the way a document paste into another studio filed it.
    await asset(c.studioId, c.userId, { key: shared, kind: "video", hash });
    const cover = await asset(a.studioId, a.userId, { key: coverKeyFor(shared), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: shared, kind: "video", hash, coverAssetId: cover.id });
    const res = await paste(b.cookie, b.projectId, { urls: [vid.url] });
    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    const coverRow = rows.find((r) => r.content_hash === cover.hash);
    expect(rows.find((r) => r.content_hash === hash)?.cover_asset_id).toBe(coverRow?.id);
  });

  it("gives the cover the ledger knows to a video the target studio holds without one", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const videoKey = key("video");
    const cover = await asset(a.studioId, a.userId, { key: coverKeyFor(videoKey), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: videoKey, kind: "video", coverAssetId: cover.id });
    const theirs = await asset(b.studioId, b.userId, { key: key("video"), kind: "video", hash: vid.hash });
    const res = await paste(b.cookie, b.projectId, { urls: [vid.url] });
    expect(res.status).toBe(200);
    const [row] = await sql<{ cover_asset_id: string | null }[]>`SELECT cover_asset_id FROM studio_assets WHERE id = ${theirs.id}`;
    expect(row?.cover_asset_id).not.toBeNull();
  });

  it("answers each address's media as the target studio's ledger holds it", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const videoKey = key("video");
    const cover = await asset(a.studioId, a.userId, { key: coverKeyFor(videoKey), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: videoKey, kind: "video", coverAssetId: cover.id });
    const res = await paste(b.cookie, b.projectId, { urls: [img.url, vid.url] });
    expect(res.status).toBe(200);
    const { map, media } = (await res.json()).data;
    expect(media[map[img.url]]).toEqual({ coverUrl: null, width: 640, height: 480, duration: null, mimeType: "image/png", size: 4096 });
    expect(media[map[vid.url]]).toEqual({ coverUrl: map[cover.url], width: 640, height: 480, duration: null, mimeType: "video/mp4", size: 4096 });
  });

  it("fills a media history row's thumbnail and numbers from the ledger when the copy carries none", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const videoKey = key("video");
    const cover = await asset(a.studioId, a.userId, { key: coverKeyFor(videoKey), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: videoKey, kind: "video", coverAssetId: cover.id });
    const node = crypto.randomUUID();
    const res = await paste(b.cookie, b.projectId, {
      urls: [vid.url],
      history: [{ node_id: node, kind: "media", content: vid.url }],
    });
    expect(res.status).toBe(200);
    const { map } = (await res.json()).data;
    expect(await history(b.projectId, node)).toEqual([
      { entry_type: "upload", content: map[vid.url], thumbnail_url: map[cover.url], user_id: b.userId, media_width: 640, mime_type: "video/mp4" },
    ]);
  });

  // Another studio can point its row of a video at any picture through a pair;
  // a video named alone takes only the frame cut from its own bytes.
  it("takes no picture another studio paired with a video as that video's cover", async () => {
    const victim = await seedEditor();
    const other = await seedEditor();
    const b = await seedEditor();
    const videoKey = key("video");
    const hash = crypto.randomBytes(32).toString("hex");
    const vid = await asset(victim.studioId, victim.userId, { key: videoKey, kind: "video", hash });
    const planted = await asset(other.studioId, other.userId, { key: key("image") });
    const pairRes = await paste(other.cookie, other.projectId, { pairs: [{ url: vid.url, cover: planted.url }] });
    expect(pairRes.status).toBe(200);

    const res = await paste(b.cookie, b.projectId, { urls: [vid.url] });
    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    expect(rows.find((r) => r.content_hash === planted.hash)).toBeUndefined();
    expect(rows.find((r) => r.content_hash === hash)?.cover_asset_id).toBeNull();
  });

  // One paste reads every video's cover in one query; a row pairing one
  // pasted video with another pasted video's frame must not hand that frame over.
  it("takes no other pasted video's frame as a video's cover", async () => {
    const victim = await seedEditor();
    const other = await seedEditor();
    const b = await seedEditor();
    const firstKey = key("video");
    const firstHash = crypto.randomBytes(32).toString("hex");
    const first = await asset(victim.studioId, victim.userId, { key: firstKey, kind: "video", hash: firstHash });
    const secondKey = key("video");
    const secondCover = await asset(victim.studioId, victim.userId, { key: coverKeyFor(secondKey), source: "cover" });
    const second = await asset(victim.studioId, victim.userId, { key: secondKey, kind: "video", coverAssetId: secondCover.id });
    const pairRes = await paste(other.cookie, other.projectId, { pairs: [{ url: first.url, cover: secondCover.url }] });
    expect(pairRes.status).toBe(200);

    const res = await paste(b.cookie, b.projectId, { urls: [first.url, second.url] });
    expect(res.status).toBe(200);
    const rows = await ledger(b.studioId);
    const coverRow = rows.find((r) => r.content_hash === secondCover.hash);
    expect(rows.find((r) => r.content_hash === second.hash)?.cover_asset_id).toBe(coverRow?.id);
    expect(rows.find((r) => r.content_hash === firstHash)?.cover_asset_id).toBeNull();
  });

  it("keeps the numbers a copy carries in its history row", async () => {
    const a = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const node = crypto.randomUUID();
    const res = await paste(a.cookie, a.projectId, {
      urls: [img.url],
      history: [{ node_id: node, kind: "media", content: img.url, width: 100, mimeType: "image/webp" }],
    });
    expect(res.status).toBe(200);
    expect((await history(a.projectId, node))[0]).toMatchObject({ media_width: 100, mime_type: "image/webp" });
  });

  it("answers 404 to someone with no role and 403 to a viewer, writing nothing", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    expect((await paste(b.cookie, a.projectId, {})).status).toBe(404);
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${a.projectId}, ${b.userId}, 'viewer', ${a.userId})`;
    const node = crypto.randomUUID();
    const res = await paste(b.cookie, a.projectId, { history: [{ node_id: node, kind: "text", content: "x" }] });
    expect(res.status).toBe(403);
    expect(await history(a.projectId, node)).toEqual([]);
  });
});

/** The live Project media relations of a Project, by asset id. */
async function relations(projectId: string): Promise<Array<{ asset_id: string; display_name: string | null }>> {
  return sql`
    SELECT asset_id, display_name FROM project_asset_refs
    WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY asset_id
  `;
}

/** Run with every insert or update of one table refused while `when` holds. */
async function refusing(table: "project_asset_refs" | "studio_assets", when: string, run: () => Promise<void>): Promise<void> {
  const name = `paste_fault_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN IF ${when} THEN RAISE EXCEPTION 'injected paste failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await run();
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    }
  } finally {
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

/** The last segment of an address, as a relation names it. */
function fileName(url: string): string {
  return new URL(url).pathname.split("/").pop()!;
}

describe("POST /canvas/paste writes Project media relations (inner#2171 design §5.1)", () => {
  it("relates an address the same Studio holds to the Project, named after its file", async () => {
    const a = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const before = (await ledger(a.studioId)).length;
    const res = await paste(a.cookie, a.projectId, { urls: [img.url] });
    expect(res.status).toBe(200);
    expect(await relations(a.projectId)).toEqual([{ asset_id: img.id, display_name: fileName(img.url) }]);
    expect(await ledger(a.studioId)).toHaveLength(before);
  });

  it("relates the row a cross-Studio paste registers, leaving the source Project alone", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const sourceBefore = await relations(a.projectId);
    const res = await paste(b.cookie, b.projectId, { urls: [img.url] });
    expect(res.status).toBe(200);
    const [row] = await ledger(b.studioId);
    expect(await relations(b.projectId)).toEqual([{ asset_id: row!.id, display_name: fileName(img.url) }]);
    expect(await relations(a.projectId)).toEqual(sourceBefore);
  });

  it("relates the row the target Studio already holds by hash", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const theirs = await asset(b.studioId, b.userId, { key: key("image"), hash: img.hash });
    const before = (await ledger(b.studioId)).length;
    expect((await paste(b.cookie, b.projectId, { urls: [img.url] })).status).toBe(200);
    expect((await relations(b.projectId)).map((r) => r.asset_id)).toEqual([theirs.id]);
    expect(await ledger(b.studioId)).toHaveLength(before);
  });

  it.each(["pair", "video alone"] as const)("relates a pasted video and not its cover (%s)", async (shape) => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    const body = shape === "pair" ? { pairs: [{ url: vid.url, cover: cover.url }] } : { urls: [vid.url] };
    expect((await paste(b.cookie, b.projectId, body)).status).toBe(200);
    const rows = await ledger(b.studioId);
    const videoRow = rows.find((r) => r.content_hash === vid.hash);
    expect(rows.some((r) => r.source === "cover")).toBe(true);
    expect((await relations(b.projectId)).map((r) => r.asset_id)).toEqual([videoRow!.id]);
  });

  it("still relates the video when its cover cannot be filed", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    await refusing("studio_assets", `NEW.source = 'cover' AND NEW.studio_id = '${b.studioId}'::uuid`, async () => {
      const res = await paste(b.cookie, b.projectId, { pairs: [{ url: vid.url, cover: cover.url }] });
      expect(res.status).toBe(200);
      expect((await res.json()).data.map[cover.url]).toBeNull();
    });
    const videoRow = (await ledger(b.studioId)).find((r) => r.content_hash === vid.hash);
    expect((await relations(b.projectId)).map((r) => r.asset_id)).toEqual([videoRow!.id]);
  });

  it("relates nothing for an address no ledger knows", async () => {
    const a = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const unknown = publicUrl(key("image"));
    const res = await paste(a.cookie, a.projectId, { urls: [unknown, img.url, "https://example.com/x.png"] });
    expect(res.status).toBe(200);
    expect((await relations(a.projectId)).map((r) => r.asset_id)).toEqual([img.id]);
  });

  it("keeps the first name and fills only a missing one", async () => {
    const a = await seedEditor();
    const named = await asset(a.studioId, a.userId, { key: key("image") });
    const unnamed = await asset(a.studioId, a.userId, { key: key("image") });
    await sql`INSERT INTO project_asset_refs (project_id, asset_id, display_name) VALUES (${a.projectId}, ${named.id}, 'cat.png'), (${a.projectId}, ${unnamed.id}, null)`;
    expect((await paste(a.cookie, a.projectId, { urls: [named.url, unnamed.url] })).status).toBe(200);
    const byId = new Map((await relations(a.projectId)).map((r) => [r.asset_id, r.display_name]));
    expect(byId.get(named.id)).toBe("cat.png");
    expect(byId.get(unnamed.id)).toBe(fileName(unnamed.url));
    expect(byId.size).toBe(2);
  });

  it("fails the paste when the relation cannot be written, and a retry writes it once", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    await refusing("project_asset_refs", `NEW.project_id = '${b.projectId}'::uuid`, async () => {
      const res = await paste(b.cookie, b.projectId, { urls: [img.url] });
      expect(res.status).toBeGreaterThanOrEqual(500);
    });
    const res = await paste(b.cookie, b.projectId, { urls: [img.url] });
    expect(res.status).toBe(200);
    expect(await relations(b.projectId)).toHaveLength(1);
    expect((await ledger(b.studioId)).filter((r) => r.content_hash === img.hash)).toHaveLength(1);
  });

  it("writes node history and relations together, and nothing for text alone", async () => {
    const a = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    const node = crypto.randomUUID();
    const text = crypto.randomUUID();
    const res = await paste(a.cookie, a.projectId, {
      urls: [img.url],
      history: [{ node_id: node, kind: "media", content: img.url }, { node_id: text, kind: "text", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(await history(a.projectId, node)).toHaveLength(1);
    expect((await relations(a.projectId)).map((r) => r.asset_id)).toEqual([img.id]);

    const b = await seedEditor();
    expect((await paste(b.cookie, b.projectId, { history: [{ node_id: crypto.randomUUID(), kind: "text", content: "hi" }] })).status).toBe(200);
    expect(await relations(b.projectId)).toEqual([]);
  });

  it("writes no relation when a full Studio refuses the paste", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const img = await asset(a.studioId, a.userId, { key: key("image") });
    await fill(b.studioId, b.userId);
    expect((await paste(b.cookie, b.projectId, { urls: [img.url] })).status).toBe(507);
    expect(await relations(b.projectId)).toEqual([]);
  });

  it("shows a cross-Project pasted video, without its cover, in the Project's video list", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    expect((await paste(b.cookie, b.projectId, { pairs: [{ url: vid.url, cover: cover.url }] })).status).toBe(200);
    for (const kind of ["video", "image"] as const) {
      const res = await app.request(`/api/v1/projects/${b.projectId}/assets?kind=${kind}`, { headers: { Cookie: b.cookie } });
      expect(res.status).toBe(200);
      const items = (await res.json()).data.items as Array<{ fileUrl: string }>;
      const videoRow = (await ledger(b.studioId)).find((r) => r.content_hash === vid.hash)!;
      expect(items.map((item) => item.fileUrl)).toEqual(kind === "video" ? [videoRow.file_url] : []);
    }
  });

  it("relates exactly the mapped main assets, never a cover, and repeats change nothing", async () => {
    const a = await seedEditor();
    const b = await seedEditor();
    const pool = [];
    for (let i = 0; i < 3; i++) pool.push(await asset(a.studioId, a.userId, { key: key("image") }));
    const cover = await asset(a.studioId, a.userId, { key: key("video", true), source: "cover" });
    const vid = await asset(a.studioId, a.userId, { key: key("video"), kind: "video", coverAssetId: cover.id });
    const unknown = publicUrl(key("image"));
    await fc.assert(fc.asyncProperty(
      fc.subarray([...pool.map((p) => p.url), unknown]), fc.boolean(),
      async (urls, withVideo) => {
        const body = { urls, pairs: withVideo ? [{ url: vid.url, cover: cover.url }] : [] };
        const before = await relations(b.projectId);
        const first = await paste(b.cookie, b.projectId, body);
        expect(first.status).toBe(200);
        const map = (await first.json()).data.map as Record<string, string | null>;
        const main = [...urls, ...(withVideo ? [vid.url] : [])].map((u) => map[u]).filter((u): u is string => typeof u === "string");
        const rows = await ledger(b.studioId);
        const mainIds = new Set(rows.filter((r) => main.includes(r.file_url)).map((r) => r.id));
        const after = await relations(b.projectId);
        const added = after.filter((r) => !before.some((x) => x.asset_id === r.asset_id)).map((r) => r.asset_id);
        for (const id of added) expect(mainIds.has(id)).toBe(true);
        for (const id of mainIds) expect(after.some((r) => r.asset_id === id)).toBe(true);
        expect(after.some((r) => rows.find((x) => x.id === r.asset_id)?.source === "cover")).toBe(false);
        const ledgerSize = rows.length;
        expect((await paste(b.cookie, b.projectId, body)).status).toBe(200);
        expect(await relations(b.projectId)).toEqual(after);
        expect(await ledger(b.studioId)).toHaveLength(ledgerSize);
      },
    ), { numRuns: 100 });
  });
});
