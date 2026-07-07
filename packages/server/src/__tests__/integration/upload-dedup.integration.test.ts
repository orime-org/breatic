// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Upload dedup ROUTE contract (#1609 asset slice 2, B.2) — the real Hono
 * app against real Postgres + Redis + the local storage adapter.
 *
 * Pins what unit mocks cannot:
 *   - the B.2 round trip: a hashed upload registers a ledger row; a
 *     second presign of the SAME bytes answers `alreadyExists` with the
 *     SAME fileUrl (same studio + same content = one URL); the dedup
 *     report lands the activity row without a new ledger row;
 *   - size distrust: a hash claim with a mismatched size is refused
 *     dedup and falls through to a normal presign (spec §8);
 *   - D9 attribution on the upload path: a personal-project collaborator
 *     dedups against THEIR OWN personal studio, not the owner's;
 *   - the authoritative upload cap (413) with the boundary allowed;
 *   - the hash-degrade path: an unhashed upload stays available but
 *     lands NO ledger row (untracked signal, plan §6);
 *   - a dedup report for content the studio never stored → 422.
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

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "upload-dedup-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh user + their personal studio (D9 needs it); returns both ids. */
async function insertUserWithPersonalStudio(): Promise<{
  userId: string;
  personalStudioId: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ud-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`ud-p-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  return { userId, personalStudioId: studios[0]!.id };
}

/** A project in `studioId` with `ownerUserId` as owner member. */
async function insertProject(
  studioId: string,
  ownerUserId: string,
): Promise<string> {
  const slug = `ud-proj-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${ownerUserId}, ${`P ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  const projectId = rows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerUserId}, 'owner', null)
  `;
  return projectId;
}

/** Add `userId` to `projectId` as an editor. */
async function addEditor(projectId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'editor', null)
  `;
}

/** Mint a real Redis session; returns the Cookie header value. */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `breatic_session=${token}`;
}

/** GET /assets/presign for `user` with declared size (+ optional hash). */
async function presign(
  cookie: string,
  projectId: string,
  size: number,
  hash?: string,
): Promise<Response> {
  const params = new URLSearchParams({
    filename: "photo.png",
    content_type: "image/png",
    project_id: projectId,
    size: String(size),
    ...(hash !== undefined && { hash }),
  });
  return app.request(`/api/v1/assets/presign?${params.toString()}`, {
    headers: { Cookie: cookie },
  });
}

/** Store real bytes for (user, project) and return { key, hash, size }. */
async function storeObject(
  userId: string,
  projectId: string,
): Promise<{ key: string; hash: string; size: number }> {
  const content = Buffer.from(`png-bytes-${crypto.randomUUID()}`);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const key = `${userId}/${projectId}/image/2026-07-07/${Date.now()}_${crypto.randomUUID()}.png`;
  const adapter = await getStorageAdapter();
  await adapter.upload(key, content, "image/png");
  return { key, hash, size: content.length };
}

/** POST /assets/uploaded (regular path). */
async function reportUploaded(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/v1/assets/uploaded", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Ledger row count for (studio, hash). */
async function ledgerCount(studioId: string, hash: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM studio_assets
    WHERE studio_id = ${studioId} AND content_hash = ${hash}
  `;
  return rows[0]!.n;
}

describe("B.2 round trip — upload once, instant-dedup forever after", () => {
  it("register → presign same bytes answers alreadyExists with the SAME URL → dedup report records activity without a new row", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    const { key, hash, size } = await storeObject(userId, projectId);

    // 1. Regular hashed upload report → ledger row.
    const rep = await reportUploaded(cookie, {
      project_id: projectId,
      key,
      hash,
      kind: "image",
      metadata: { filename: "photo.png", size, mimeType: "image/png" },
    });
    expect(rep.status).toBe(200);
    const repBody = (await rep.json()) as { data: { fileUrl: string } };
    const originalUrl = repBody.data.fileUrl;
    expect(await ledgerCount(personalStudioId, hash)).toBe(1);
    const rows = await sql<
      { size_bytes: number; source: string; mime_type: string }[]
    >`
      SELECT size_bytes::int AS size_bytes, source, mime_type FROM studio_assets
      WHERE studio_id = ${personalStudioId} AND content_hash = ${hash}
    `;
    // Size comes from storage head(), not the client claim.
    expect(rows[0]!.size_bytes).toBe(size);
    expect(rows[0]!.source).toBe("upload");

    // 2. Presign the same bytes → instant dedup, SAME URL, no uploadUrl.
    const pre = await presign(cookie, projectId, size, hash);
    expect(pre.status).toBe(200);
    const preBody = (await pre.json()) as {
      data: { alreadyExists?: boolean; fileUrl?: string; uploadUrl?: string };
    };
    expect(preBody.data.alreadyExists).toBe(true);
    expect(preBody.data.fileUrl).toBe(originalUrl);
    expect(preBody.data.uploadUrl).toBeUndefined();

    // 3. Dedup report → 200 with the same URL, activity row, NO new ledger row.
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    const dedupRep = await reportUploaded(cookie, {
      project_id: projectId,
      dedup: true,
      hash,
      kind: "image",
    });
    expect(dedupRep.status).toBe(200);
    const dedupBody = (await dedupRep.json()) as { data: { fileUrl: string } };
    expect(dedupBody.data.fileUrl).toBe(originalUrl);
    expect(await ledgerCount(personalStudioId, hash)).toBe(1);
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });

  it("size distrust: a hash claim with a mismatched size falls through to a normal presign", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    const { key, hash, size } = await storeObject(userId, projectId);
    await reportUploaded(cookie, {
      project_id: projectId,
      key,
      hash,
      kind: "image",
    });

    const pre = await presign(cookie, projectId, size + 1, hash);
    expect(pre.status).toBe(200);
    const body = (await pre.json()) as {
      data: { alreadyExists?: boolean; uploadUrl?: string };
    };
    expect(body.data.alreadyExists).toBeUndefined();
    expect(typeof body.data.uploadUrl).toBe("string");
  });

  it("a dedup report for content the studio never stored → 422", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);

    const res = await reportUploaded(cookie, {
      project_id: projectId,
      dedup: true,
      hash: crypto.randomBytes(32).toString("hex"),
      kind: "image",
    });

    expect(res.status).toBe(422);
    expect(await ledgerCount(personalStudioId, "")).toBe(0);
  });
});

describe("D9 attribution on the upload path", () => {
  it("a personal-project collaborator dedups against THEIR OWN studio, not the owner's", async () => {
    const owner = await insertUserWithPersonalStudio();
    const collab = await insertUserWithPersonalStudio();
    const projectId = await insertProject(owner.personalStudioId, owner.userId);
    await addEditor(projectId, collab.userId);
    const ownerCookie = await loginCookie(owner.userId);
    const collabCookie = await loginCookie(collab.userId);

    // Owner uploads content C → row in OWNER's personal studio.
    const { key, hash, size } = await storeObject(owner.userId, projectId);
    await reportUploaded(ownerCookie, {
      project_id: projectId,
      key,
      hash,
      kind: "image",
    });
    expect(await ledgerCount(owner.personalStudioId, hash)).toBe(1);

    // The collaborator presigning the same bytes gets NO dedup (their own
    // personal studio holds nothing) → normal presign.
    const pre = await presign(collabCookie, projectId, size, hash);
    const body = (await pre.json()) as {
      data: { alreadyExists?: boolean; uploadUrl?: string };
    };
    expect(body.data.alreadyExists).toBeUndefined();
    expect(typeof body.data.uploadUrl).toBe("string");
  });
});

describe("upload cap (authoritative) + hash degrade", () => {
  it("rejects a presign over the 2 GiB cap with 413; the exact cap passes", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);

    const over = await presign(cookie, projectId, 2147483649);
    expect(over.status).toBe(413);

    const at = await presign(cookie, projectId, 2147483648);
    expect(at.status).toBe(200);
  });

  it("an unhashed upload (worker degrade) stays available but lands NO ledger row", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    const { key, hash } = await storeObject(userId, projectId);

    const res = await reportUploaded(cookie, {
      project_id: projectId,
      key,
      kind: "image",
    });

    expect(res.status).toBe(200);
    expect(await ledgerCount(personalStudioId, hash)).toBe(0);
  });
});
