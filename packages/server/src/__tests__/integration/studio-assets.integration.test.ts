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
 *   - resolveOwnerStudioId (#1839): attribution is the PROJECT's studio,
 *     personal and team alike — who acted never enters into it;
 *   - produced_by_user_id records who FIRST brought the content in, and a
 *     dedup hit keeps that original producer.
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
import fc from "fast-check";
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
  lastFixtureUserId = userId;
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

/**
 * The producer used by fixtures whose subject is studio-level dedup rather
 * than who uploaded. Set by `insertUserWithPersonalStudio`, so every fixture
 * asset points at a real user row (the FK requires one) without each call
 * site having to thread an id it does not care about. Tests that DO care
 * pass `producedBy` explicitly.
 */
let lastFixtureUserId = "";

const baseAsset = (
  studioId: string,
  contentHash: string,
  sizeBytes: number,
  producedBy?: string,
) => ({
  studioId,
  producedByUserId: producedBy ?? lastFixtureUserId,
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

describe("asset repo — usageByStudios (batch SUM, account roll-up #1826 §5.3)", () => {
  it("returns 0 for an empty studio-id list (no query)", async () => {
    expect(await assetRepo.usageByStudios([])).toBe(0);
  });

  it("sums live asset sizes across several studios", async () => {
    const a = await insertUserWithPersonalStudio();
    const b = await insertUserWithPersonalStudio();
    await assetRepo.registerWithDedup(baseAsset(a.personalStudioId, fakeHash(), 100));
    await assetRepo.registerWithDedup(baseAsset(a.personalStudioId, fakeHash(), 40));
    await assetRepo.registerWithDedup(baseAsset(b.personalStudioId, fakeHash(), 250));
    expect(
      await assetRepo.usageByStudios([a.personalStudioId, b.personalStudioId]),
    ).toBe(390);
  });

  it("DOUBLE-COUNTS the same content living in two studios (raw SUM, §5.3)", async () => {
    // Dedup is per-studio, so identical content is TWO physical rows across
    // two studios — the account roll-up counts each (no cross-studio dedup).
    const a = await insertUserWithPersonalStudio();
    const b = await insertUserWithPersonalStudio();
    const sharedHash = fakeHash();
    await assetRepo.registerWithDedup(baseAsset(a.personalStudioId, sharedHash, 100));
    await assetRepo.registerWithDedup(baseAsset(b.personalStudioId, sharedHash, 100));
    expect(
      await assetRepo.usageByStudios([a.personalStudioId, b.personalStudioId]),
    ).toBe(200);
  });

  it("ignores studios not in the list", async () => {
    const a = await insertUserWithPersonalStudio();
    const b = await insertUserWithPersonalStudio();
    await assetRepo.registerWithDedup(baseAsset(a.personalStudioId, fakeHash(), 100));
    await assetRepo.registerWithDedup(baseAsset(b.personalStudioId, fakeHash(), 999));
    expect(await assetRepo.usageByStudios([a.personalStudioId])).toBe(100);
  });

  it("property: batch equals the sum of per-studio usage (algebraic identity)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 5 }),
        async (sizes) => {
          // One studio per size, each holding a single asset of that size.
          const ids: string[] = [];
          for (const size of sizes) {
            const s = await insertUserWithPersonalStudio();
            await assetRepo.registerWithDedup(
              baseAsset(s.personalStudioId, fakeHash(), size),
            );
            ids.push(s.personalStudioId);
          }
          const batch = await assetRepo.usageByStudios(ids);
          let sumOfSingles = 0;
          for (const id of ids) sumOfSingles += await assetRepo.usageByStudio(id);
          expect(batch).toBe(sumOfSingles);
          expect(batch).toBe(sizes.reduce((t, n) => t + n, 0));
        },
      ),
      { numRuns: 12 },
    );
  });
});

describe("asset service — resolveOwnerStudioId (#1839: the project's studio, always)", () => {
  it("personal-studio project → the PROJECT's studio, whoever acted", async () => {
    const owner = await insertUserWithPersonalStudio();
    const collaborator = await insertUserWithPersonalStudio();
    // Project belongs to the OWNER's personal studio.
    const projectId = await insertProjectInStudio(owner.personalStudioId, owner.userId);

    expect(await assetService.resolveOwnerStudioId(projectId)).toBe(
      owner.personalStudioId,
    );
    // Attribution no longer depends on the acting user at all — the
    // collaborator's output belongs to the project's studio, same as the
    // owner's. This is what makes dedup a single domain per studio.
    void collaborator;
  });

  it("team-studio project → the team studio, whoever acted", async () => {
    const owner = await insertUserWithPersonalStudio();
    const teamStudioId = await insertTeamStudio(owner.userId);
    const projectId = await insertProjectInStudio(teamStudioId, owner.userId);

    expect(await assetService.resolveOwnerStudioId(projectId)).toBe(teamStudioId);
  });

  it("register() attributes a personal-project collaborator's asset to the PROJECT's studio", async () => {
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
    // Owned by the project's studio ...
    expect(asset.studioId).toBe(owner.personalStudioId);
    // ... while the producer is still recorded, on its own column.
    expect(asset.producedByUserId).toBe(collaborator.userId);
  });

  it("a dedup hit keeps the FIRST producer, not the later uploader", async () => {
    const owner = await insertUserWithPersonalStudio();
    const collaborator = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(owner.personalStudioId, owner.userId);
    const hash = fakeHash();

    const first = await assetService.register({
      projectId,
      actingUserId: collaborator.userId,
      contentHash: hash,
      storageKey: "k1",
      fileUrl: "https://cdn/1.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(first.deduped).toBe(false);

    // Same bytes, same studio (because same project), different actor.
    const second = await assetService.register({
      projectId,
      actingUserId: owner.userId,
      contentHash: hash,
      storageKey: "k2",
      fileUrl: "https://cdn/2.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(second.deduped).toBe(true);
    // The winning row is the first one — producer unchanged.
    expect(second.asset.producedByUserId).toBe(collaborator.userId);
    expect(second.asset.storageKey).toBe("k1");
  });
});

describe("storage reclaim queue — dedup losers are QUEUED, never deleted (#1826 §2.3, v15)", () => {
  /** Rows queued for offline reclaim in this studio. */
  async function queued(
    studioId: string,
  ): Promise<
    { storage_key: string; kept_storage_key: string; source: string; reclaimed_at: Date | null }[]
  > {
    return sql<
      { storage_key: string; kept_storage_key: string; source: string; reclaimed_at: Date | null }[]
    >`
      SELECT storage_key, kept_storage_key, source, reclaimed_at
      FROM storage_reclaim_queue WHERE studio_id = ${studioId}
      ORDER BY created_at
    `;
  }

  it("a dedup hit queues THIS upload's key for reclaim, pointing at the winner", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(personalStudioId, userId);
    const hash = fakeHash();

    const first = await assetService.register({
      projectId,
      actingUserId: userId,
      contentHash: hash,
      storageKey: "image/2026-07-26/winner.png",
      fileUrl: "https://cdn/winner.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(first.deduped).toBe(false);
    // Nothing redundant yet — the first copy IS the live one.
    expect(await queued(personalStudioId)).toHaveLength(0);

    // Same content, different key (a concurrent/retried upload).
    const second = await assetService.register({
      projectId,
      actingUserId: userId,
      contentHash: hash,
      storageKey: "image/2026-07-26/loser.png",
      fileUrl: "https://cdn/loser.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(second.deduped).toBe(true);
    // The ledger still holds exactly one row — the winner.
    expect(second.asset.storageKey).toBe("image/2026-07-26/winner.png");

    // ...and THIS upload's now-redundant object is queued for offline reclaim,
    // with the winner recorded as the safety rail. Runtime deleted nothing.
    const rows = await queued(personalStudioId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storage_key).toBe("image/2026-07-26/loser.png");
    expect(rows[0]!.kept_storage_key).toBe("image/2026-07-26/winner.png");
    expect(rows[0]!.source).toBe("upload");
    expect(rows[0]!.reclaimed_at).toBeNull();
  });

  it("INVARIANT — a key that still has a LIVE ledger row is NEVER queued (Gate-2 R7)", async () => {
    // The offline job deletes what this queue lists, so the queue's core
    // property is "nothing live points at these objects". The self-reclaim
    // guard only compares the victim against the WINNER's key, which does not
    // cover a key that won its own registration under a DIFFERENT hash. The
    // grant-to-hash binding makes that unreachable through the upload route;
    // this pins it at the queue itself, atomically, for every present and
    // future caller — the last line before an offline job deletes live bytes.
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(personalStudioId, userId);
    const sharedKey = "image/2026-07-26/still-referenced.png";

    // This key wins its own registration under hash A → it is LIVE.
    const live = await assetService.register({
      projectId,
      actingUserId: userId,
      contentHash: fakeHash(),
      storageKey: sharedKey,
      fileUrl: "https://cdn/still-referenced.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(live.deduped).toBe(false);

    // Some other content already occupies hash B in this studio.
    const otherHash = fakeHash();
    await assetService.register({
      projectId,
      actingUserId: userId,
      contentHash: otherHash,
      storageKey: "image/2026-07-26/unrelated-winner.png",
      fileUrl: "https://cdn/unrelated-winner.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });

    // Now register the SAME key against hash B → dedup hit → the queue would
    // normally take sharedKey as the loser. It must refuse: sharedKey is live.
    const dedupHit = await assetService.register({
      projectId,
      actingUserId: userId,
      contentHash: otherHash,
      storageKey: sharedKey,
      fileUrl: "https://cdn/still-referenced.png",
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    expect(dedupHit.deduped).toBe(true);
    // Refusing to queue is NOT a failure — the registration stands.
    expect(dedupHit.reclaimQueueFailed).toBeUndefined();

    const rows = await queued(personalStudioId);
    expect(rows.map((r) => r.storage_key)).not.toContain(sharedKey);
  });

  it("re-reporting the same redundant key does not queue it twice (idempotent)", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(personalStudioId, userId);
    const hash = fakeHash();
    const base = {
      projectId,
      actingUserId: userId,
      contentHash: hash,
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image" as const,
      source: "upload" as const,
    };

    await assetService.register({
      ...base,
      storageKey: "image/2026-07-26/w2.png",
      fileUrl: "https://cdn/w2.png",
    });
    // The same losing key reported twice (client retry after a lost response).
    await assetService.register({
      ...base,
      storageKey: "image/2026-07-26/l2.png",
      fileUrl: "https://cdn/l2.png",
    });
    await assetService.register({
      ...base,
      storageKey: "image/2026-07-26/l2.png",
      fileUrl: "https://cdn/l2.png",
    });

    expect(await queued(personalStudioId)).toHaveLength(1);
  });

  it("a reclaim-queue insert failure does NOT fail the registration (H10 — bookkeeping never breaks a completed upload)", async () => {
    // The ledger row is already committed by the time we queue; the queue is a
    // work list for an OFFLINE job. Letting its insert throw would report a
    // fully successful upload as failed (422 / markFailed + no charge) over a
    // row no user ever sees. The failure surfaces as a flag instead.
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(personalStudioId, userId);
    const hash = fakeHash();
    const base = {
      projectId,
      actingUserId: userId,
      contentHash: hash,
      sizeBytes: 100,
      mimeType: "image/png",
      kind: "image" as const,
      source: "upload" as const,
    };
    await assetService.register({
      ...base,
      storageKey: "image/2026-07-26/w-h10.png",
      fileUrl: "https://cdn/w-h10.png",
    });

    // Break the queue insert: drop its FK target expectation by using a studio
    // that does not exist is impossible here (studioId is derived), so instead
    // make the UNIQUE index reject via an oversized key is also unrealistic —
    // simulate the real class of failure (a transient DB error) by racing the
    // queue table into a state where the insert violates its NOT NULL: null the
    // column the repo writes. The simplest faithful stand-in: temporarily rename
    // the table so the INSERT errors, then restore it.
    await sql`ALTER TABLE storage_reclaim_queue RENAME TO storage_reclaim_queue_tmp`;
    try {
      const second = await assetService.register({
        ...base,
        storageKey: "image/2026-07-26/l-h10.png",
        fileUrl: "https://cdn/l-h10.png",
      });
      // Registration SUCCEEDED and deduped, despite the queue being unusable.
      expect(second.deduped).toBe(true);
      expect(second.asset.storageKey).toBe("image/2026-07-26/w-h10.png");
      expect(second.reclaimQueueFailed).toBe(true);
    } finally {
      await sql`ALTER TABLE storage_reclaim_queue_tmp RENAME TO storage_reclaim_queue`;
    }
  });

  it("an AI-generated duplicate is queued with source='ai'", async () => {
    const { userId, personalStudioId } = await insertUserWithPersonalStudio();
    const projectId = await insertProjectInStudio(personalStudioId, userId);
    const hash = fakeHash();
    const base = {
      projectId,
      actingUserId: userId,
      contentHash: hash,
      sizeBytes: 100,
      mimeType: "video/mp4",
      kind: "video" as const,
      source: "ai" as const,
    };

    await assetService.register({
      ...base,
      storageKey: "video/2026-07-26/w3.mp4",
      fileUrl: "https://cdn/w3.mp4",
    });
    await assetService.register({
      ...base,
      storageKey: "video/2026-07-26/l3.mp4",
      fileUrl: "https://cdn/l3.mp4",
    });

    const rows = await queued(personalStudioId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("ai");
  });
});
