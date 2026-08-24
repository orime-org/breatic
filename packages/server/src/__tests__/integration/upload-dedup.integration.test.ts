// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 *   - attribution on the upload path (#1839): a personal-project
 *     collaborator dedups against the PROJECT's studio, so one project is
 *     one dedup domain no matter who uploads;
 *   - the authoritative upload cap (413) with the boundary allowed;
 *   - "no hash, no upload" (#1826 §0 rule 4): an unhashed report is REFUSED
 *     (422) and lands no ledger row — replacing the retired availability-first
 *     degrade that let it through as "stored but untracked";
 *   - attribution comes from the GRANT, not the report's project_id (§2.2 v15):
 *     reporting with another studio's project cannot shift the storage cost;
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
  sessionCookieName,
  loadLocales,
  getStorageAdapter,
} from "@breatic/core";
import { assetService } from "@breatic/domain";
import { issueGrant } from "@server/modules/asset/upload-grant.repo.js";
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

/** A fresh user + their personal studio; returns both ids. */
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
  // Every studio has exactly one admin in production — a personal studio's
  // owner holds that row like any other studio's does. The fixture went
  // without it until #89 put a ceiling lookup on this path, which resolves a
  // studio through its CURRENT admin and rightly treats a studio with none as
  // corrupt.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studios[0]!.id}, ${userId}, 'admin')
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
  return `${sessionCookieName()}=${token}`;
}

/**
 * GET /assets/presign for `user` with declared size. The hash is MANDATORY on
 * the wire now ("no hash, no upload"), so it defaults to a well-formed filler
 * here: a caller that only cares about the size gate still gets past schema
 * validation, and nothing silently 422s for the wrong reason.
 */
async function presign(
  cookie: string,
  projectId: string,
  size: number,
  hash: string = "a".repeat(64),
): Promise<Response> {
  const params = new URLSearchParams({
    filename: "photo.png",
    content_type: "image/png",
    project_id: projectId,
    size: String(size),
    hash,
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
  const size = content.length;
  // Mirror what /presign does (#1826): a tenant-neutral key + an upload grant
  // (the anti-spoof ledger row the /uploaded endpoint re-checks). Without the
  // grant, the regular-path report is rejected 422.
  const key = `image/2026-07-25/${Date.now()}_${crypto.randomUUID()}.png`;
  const studioId = await assetService.resolveOwnerStudioId(projectId);
  await issueGrant({
    userId,
    studioId,
    contentHash: hash,
    storageKey: key,
    declaredSize: size,
  });
  const adapter = await getStorageAdapter();
  await adapter.upload(key, content, "image/png");
  return { key, hash, size };
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

describe("attribution on the upload path (#1839)", () => {
  it("a personal-project collaborator dedups against the PROJECT's studio", async () => {
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

    // The collaborator presigning the same bytes NOW HITS dedup: the dedup
    // domain is the PROJECT's studio, and the owner already registered this
    // content there. Under the superseded rule this was a miss — each
    // collaborator had a private dedup domain, so one project stored the
    // same bytes once per person. Removing that duplication is the point
    // of #1839.
    const pre = await presign(collabCookie, projectId, size, hash);
    const body = (await pre.json()) as {
      data: { alreadyExists?: boolean; uploadUrl?: string };
    };
    expect(body.data.alreadyExists).toBe(true);
    // A hit means no upload URL is issued — the client reuses the canonical
    // asset instead of storing a second copy.
    expect(body.data.uploadUrl).toBeUndefined();
    // And still exactly ONE ledger row for that content in the project's
    // studio (not a second one under the collaborator's).
    expect(await ledgerCount(owner.personalStudioId, hash)).toBe(1);
    expect(await ledgerCount(collab.personalStudioId, hash)).toBe(0);
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

  it("an unhashed report is REFUSED (no hash, no upload) and lands NO ledger row", async () => {
    // User decision 2026-07-26, replacing the old availability-first rule that
    // let a hashless upload through as "stored but untracked". Untracked is not
    // a usable state: the object counts against nothing, dedups with nothing,
    // and — the reason it had to go — whatever pinned its URL would 404 once
    // the offline GC reclaimed the row-less object. The client refuses to
    // upload without a hash; the server enforces it independently.
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    const { key, hash } = await storeObject(userId, projectId);

    const res = await reportUploaded(cookie, {
      project_id: projectId,
      key,
      kind: "image",
    });

    expect(res.status).toBe(422);
    expect(await ledgerCount(personalStudioId, hash)).toBe(0);
  });
});

describe("anti-spoof: upload-grant ledger (#1826) — critical path #2/#3", () => {
  it("a forged key never issued by presign → /uploaded 422 (no ledger row)", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    // A key with NO grant row (never minted by presign).
    const res = await reportUploaded(cookie, {
      project_id: projectId,
      key: "image/2026-07-25/forged.png",
      hash: "a".repeat(64),
      kind: "image",
    });
    expect(res.status).toBe(422);
    expect(await ledgerCount(personalStudioId, "a".repeat(64))).toBe(0);
  });

  it("a consumed key replayed → 422 (single-shot anti-replay), never double-registers", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);
    const { key, hash } = await storeObject(userId, projectId);

    const first = await reportUploaded(cookie, { project_id: projectId, key, hash, kind: "image" });
    expect(first.status).toBe(200);
    // Replaying the SAME key (the grant is already consumed) is refused.
    const replay = await reportUploaded(cookie, { project_id: projectId, key, hash, kind: "image" });
    expect(replay.status).toBe(422);
    // Exactly one ledger row — the replay never double-registered.
    expect(await ledgerCount(personalStudioId, hash)).toBe(1);
  });

  it("another user reporting my key → 422 (ownership is user-only, not studio)", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProject(personalStudioId, userId);
    const { key, hash } = await storeObject(userId, projectId);

    // A different editor of the SAME project reports the key issued to userId —
    // the grant is bound to userId, so the foreign report is rejected.
    const { userId: otherUserId } = await insertUserWithPersonalStudio();
    await addEditor(projectId, otherUserId);
    const otherCookie = await loginCookie(otherUserId);
    const res = await reportUploaded(otherCookie, {
      project_id: projectId,
      key,
      hash,
      kind: "image",
    });
    expect(res.status).toBe(422);
  });
});

describe("attribution is taken from the GRANT, not the report's project (#1826 §2.2 v15 / H7)", () => {
  it("reporting with a DIFFERENT studio's project still charges the studio the key was issued to", async () => {
    // A member of two studios: their own personal studio (where the key gets
    // issued) and a team studio they also belong to. Presign inside the
    // personal project, then report completion pointing at the TEAM project.
    // The asset must land on the PERSONAL studio — otherwise anyone in two
    // studios could shift their storage cost onto the team.
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const personalProject = await insertProject(personalStudioId, userId);
    const cookie = await loginCookie(userId);

    const teamStudios = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${`ud-team-${seq++}`}, 'team', 'Team') RETURNING id
    `;
    const teamStudioId = teamStudios[0]!.id;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${teamStudioId}, ${userId}, 'admin')
    `;
    const teamProject = await insertProject(teamStudioId, userId);

    // Key issued against the PERSONAL project.
    const { key, hash, size } = await storeObject(userId, personalProject);

    // Report it against the TEAM project.
    const res = await reportUploaded(cookie, {
      project_id: teamProject,
      key,
      hash,
      kind: "image",
      metadata: { filename: "x.png", size, mimeType: "image/png" },
    });
    expect(res.status).toBe(200);

    // Attribution followed the grant, not the report.
    expect(await ledgerCount(personalStudioId, hash)).toBe(1);
    expect(await ledgerCount(teamStudioId, hash)).toBe(0);
  });
});
