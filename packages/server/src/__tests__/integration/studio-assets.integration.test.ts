// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Asset layer v1 — real-PG integration (spec 2026-07-04-asset-layer-v1).
 *
 * Pins the invariants unit mocks cannot:
 *   - within-studio dedup: two registers of one (studio, content_hash)
 *     yield ONE row (partial UNIQUE + ON CONFLICT DO NOTHING); the
 *     second is a dedup hit;
 *   - cross-studio: the same content in two studios stays two rows;
 *   - concurrent register of one (studio, hash) converges on one row;
 *   - usageByStudio sums a studio's live asset sizes;
 *   - resolveOwnerStudioId (D9) two-case attribution: personal-studio
 *     project → the ACTING user's own personal studio; team-studio
 *     project → the team studio regardless of who acted.
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
import { initCore, loadLocales } from "@breatic/core";
import { assetRepo, assetService } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "asset-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh user id. */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`asset-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** A user + their personal studio; returns both ids. */
async function insertUserWithPersonalStudio(): Promise<{
  userId: string;
  personalStudioId: string;
}> {
  const userId = await insertUser();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`asset-p-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  return { userId, personalStudioId: rows[0]!.id };
}

/** A team studio created by `ownerUserId`; returns its id. */
async function insertTeamStudio(ownerUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerUserId}, ${`asset-t-${seq++}`}, 'team', 'Team') RETURNING id
  `;
  return rows[0]!.id;
}

/** A project owned by `studioId`; returns its id. */
async function insertProjectInStudio(
  studioId: string,
  ownerUserId: string,
): Promise<string> {
  const slug = `asset-proj-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${ownerUserId}, ${`P ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  return rows[0]!.id;
}

/** A 64-char hex string standing in for a sha256 content hash. */
function fakeHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

const baseAsset = (studioId: string, contentHash: string, sizeBytes: number) => ({
  studioId,
  contentHash,
  storageKey: `u/p/image/2026-07-04/${crypto.randomUUID()}.png`,
  fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
  sizeBytes,
  mimeType: "image/png",
  kind: "image" as const,
  source: "upload" as const,
});

describe("asset repo — within-studio dedup", () => {
  it("registers once; a second (studio, hash) is a dedup hit → ONE row", async () => {
    const { personalStudioId } = await insertUserWithPersonalStudio();
    const hash = fakeHash();

    const first = await assetRepo.registerWithDedup(
      baseAsset(personalStudioId, hash, 100),
    );
    const second = await assetRepo.registerWithDedup(
      baseAsset(personalStudioId, hash, 100),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_assets
      WHERE studio_id = ${personalStudioId} AND content_hash = ${hash}
    `;
    expect(rows[0]!.n).toBe(1);
  });

  it("same content in two different studios stays two rows (within-studio only)", async () => {
    const a = await insertUserWithPersonalStudio();
    const b = await insertUserWithPersonalStudio();
    const hash = fakeHash();

    const ra = await assetRepo.registerWithDedup(baseAsset(a.personalStudioId, hash, 100));
    const rb = await assetRepo.registerWithDedup(baseAsset(b.personalStudioId, hash, 100));

    expect(ra.deduped).toBe(false);
    expect(rb.deduped).toBe(false);
    expect(ra.asset.id).not.toBe(rb.asset.id);
  });

  it("concurrent register of one (studio, hash) converges on ONE row", async () => {
    const { personalStudioId } = await insertUserWithPersonalStudio();
    const hash = fakeHash();

    const [x, y] = await Promise.all([
      assetRepo.registerWithDedup(baseAsset(personalStudioId, hash, 100)),
      assetRepo.registerWithDedup(baseAsset(personalStudioId, hash, 100)),
    ]);

    expect(x.asset.id).toBe(y.asset.id);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_assets
      WHERE studio_id = ${personalStudioId} AND content_hash = ${hash}
    `;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("asset repo — usageByStudio", () => {
  it("sums a studio's live asset sizes", async () => {
    const { personalStudioId } = await insertUserWithPersonalStudio();
    await assetRepo.registerWithDedup(baseAsset(personalStudioId, fakeHash(), 100));
    await assetRepo.registerWithDedup(baseAsset(personalStudioId, fakeHash(), 250));
    expect(await assetRepo.usageByStudio(personalStudioId)).toBe(350);
  });

  it("returns 0 for a studio with no assets", async () => {
    const { personalStudioId } = await insertUserWithPersonalStudio();
    expect(await assetRepo.usageByStudio(personalStudioId)).toBe(0);
  });
});

describe("asset service — resolveOwnerStudioId (D9 two-case)", () => {
  it("personal-studio project → the ACTING user's own personal studio", async () => {
    const owner = await insertUserWithPersonalStudio();
    const collaborator = await insertUserWithPersonalStudio();
    // Project belongs to the OWNER's personal studio.
    const projectId = await insertProjectInStudio(owner.personalStudioId, owner.userId);

    // The owner acting → owner's personal studio (= project studio here).
    expect(
      await assetService.resolveOwnerStudioId(projectId, owner.userId),
    ).toBe(owner.personalStudioId);
    // A collaborator acting → THEIR OWN personal studio, not the owner's.
    expect(
      await assetService.resolveOwnerStudioId(projectId, collaborator.userId),
    ).toBe(collaborator.personalStudioId);
  });

  it("team-studio project → the team studio regardless of who acted", async () => {
    const owner = await insertUserWithPersonalStudio();
    const outsider = await insertUserWithPersonalStudio();
    const teamStudioId = await insertTeamStudio(owner.userId);
    const projectId = await insertProjectInStudio(teamStudioId, owner.userId);

    expect(await assetService.resolveOwnerStudioId(projectId, owner.userId)).toBe(
      teamStudioId,
    );
    // A non-member outsider acting → still the team studio.
    expect(
      await assetService.resolveOwnerStudioId(projectId, outsider.userId),
    ).toBe(teamStudioId);
  });

  it("register() attributes a personal-project collaborator's asset to their own studio", async () => {
    const owner = await insertUserWithPersonalStudio();
    const collaborator = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(owner.personalStudioId, owner.userId);

    const { asset } = await assetService.register({
      projectId,
      actingUserId: collaborator.userId,
      contentHash: fakeHash(),
      storageKey: "k",
      fileUrl: "https://cdn/x.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(asset.studioId).toBe(collaborator.personalStudioId);
  });
});
