// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Upload-grant ledger — real-PG integration (#1826, design §2.2 / §3.2).
 *
 * The upload-grant table is the anti-spoof authority that REPLACES the
 * prefix-based `isOwnedKey`. When /presign issues a storage key K, it writes
 * one grant row (user + owner studio + declared content_hash + K); the two
 * upload endpoints later re-check it:
 *   - /local-upload (write-time gate): find a LIVE grant (issued to this user,
 *     NOT yet consumed) → allow the disk write; it does NOT consume (a local
 *     upload is a two-hop PUT-then-report against ONE grant — consuming on the
 *     first hop would 422 the second).
 *   - /uploaded (registration terminal): find + INSERT studio_assets + mark
 *     consumed exactly once (anti-replay).
 *
 * Ownership is (storage_key, user) ONLY — the storage key is globally unique so
 * it locates the row, and user_id decides ownership. The owner studio is READ
 * OUT of that row (recorded at presign), not a query condition: /local-upload
 * is a bare byte PUT with no project/studio.
 *
 * Invariants pinned here (design §10 acceptance #2 — anti-spoof critical path):
 *   - ownership: a grant resolves ONLY for its own user; a forged or foreign
 *     key never resolves; the owner studio comes back on the row;
 *   - no time limit (v11): a grant has no expiry — ownership + not-consumed;
 *   - content_hash NOT NULL (#1826 §0 rule 4): presign refuses a request
 *     without one, so no grant can exist without a hash. AUTHENTICATION still
 *     never reads it — that is (key, user, not-consumed), which is what lets
 *     /local-upload authorise a write with no hash in scope;
 *   - an /uploaded REPORT, which does carry a hash, must MATCH the grant's
 *     (Gate-2 R7): one grant authorises one upload of one piece of content,
 *     so two concurrent reports cannot register two rows against one key;
 *   - find does NOT consume (two-hop local safe);
 *   - consume is single-shot (anti-replay): a replay of a consumed key fails;
 *   - CONCURRENT consume of one key: EXACTLY ONE caller wins (CAS invariant);
 *   - storage_key is unique (a key is issued at most once).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  inject,
  vi,
} from "vitest";

// `assetUpload.service` reaches @breatic/domain, whose barrel pulls in the AI
// SDK (and transitively an OpenTelemetry build vitest cannot resolve). Stub it
// exactly as the sibling integration suites do — nothing here calls a model.
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
import { initCore } from "@breatic/core";
import {
  issueGrant,
  findLiveGrant,
  consumeGrant,
} from "@server/modules/asset/upload-grant.repo.js";
import { resolveGrantForReport } from "@server/modules/asset/assetUpload.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "upload-grant-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh verified user; returns the id. */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`grant-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** A personal studio created by `ownerUserId`; returns its id. */
async function insertStudio(ownerUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerUserId}, ${`grant-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  return rows[0]!.id;
}

/** A 64-char hex sha256 stand-in. */
function fakeHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** A fresh tenant-neutral storage key (design §3.1 format). */
function freshKey(): string {
  return `image/2026-07-25/${Date.now()}_${crypto.randomUUID()}.png`;
}

describe("upload-grant repo — issue + find (user-only ownership, no time limit)", () => {
  it("issues a grant that resolves for its own user + carries the owner studio", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();

    const grant = await issueGrant({
      userId,
      studioId,
      contentHash: fakeHash(),
      storageKey,
      declaredSize: 1234,
    });
    expect(grant.storageKey).toBe(storageKey);
    expect(grant.consumedAt).toBeNull();

    const live = await findLiveGrant({ storageKey, userId });
    expect(live).not.toBeNull();
    expect(live!.id).toBe(grant.id);
    expect(live!.declaredSize).toBe(1234);
    // The owner studio is READ OUT of the row (recorded at presign), not supplied.
    expect(live!.studioId).toBe(studioId);
  });

  it("does NOT resolve for a different user (forged ownership)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const otherUserId = await insertUser();
    const storageKey = freshKey();
    await issueGrant({
      userId,
      studioId,
      contentHash: fakeHash(),
      storageKey,
      declaredSize: 1,
    });

    const live = await findLiveGrant({ storageKey, userId: otherUserId });
    expect(live).toBeNull();
  });

  it("does NOT resolve a forged key that was never issued", async () => {
    const userId = await insertUser();
    const live = await findLiveGrant({ storageKey: freshKey(), userId });
    expect(live).toBeNull();
  });

  it("find does NOT consume — repeated finds keep resolving (two-hop local safe)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 });

    const a = await findLiveGrant({ storageKey, userId });
    const b = await findLiveGrant({ storageKey, userId });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.consumedAt).toBeNull();
  });
});

describe("upload-grant repo — the anti-spoof check never reads content_hash", () => {
  it("authenticates + consumes purely on (storage_key, user), whatever the hash is", async () => {
    // content_hash is NOT NULL since #1826 §0 rule 4 ("no hash, no upload" —
    // presign refuses a hashless request, so a grant can never exist without
    // one). What this pins is that the hash plays NO part in authenticity:
    // ownership is (storage_key, user_id, not-consumed) only, which is exactly
    // what lets /local-upload — a bare byte PUT with no project or studio in
    // scope — authorise a write.
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    const contentHash = "d".repeat(64);

    const grant = await issueGrant({
      userId,
      studioId,
      contentHash,
      storageKey,
      declaredSize: 42,
    });
    expect(grant.contentHash).toBe(contentHash);

    // Resolves without the caller supplying (or knowing) the hash.
    const live = await findLiveGrant({ storageKey, userId });
    expect(live).not.toBeNull();

    // …and still consumes exactly once.
    expect(await consumeGrant({ storageKey, userId })).toBe(true);
    expect(await consumeGrant({ storageKey, userId })).toBe(false);
  });
});

describe("upload-grant — a REPORT is bound to the content the grant was issued for (Gate-2 R7)", () => {
  // Authenticity (above) is (key, user, not-consumed) — /local-upload has no
  // hash to offer. But /uploaded DOES carry one, and a grant authorises ONE
  // upload of ONE piece of content: the hash declared at presign. Without this
  // binding, two concurrent reports on a single key could register TWO rows
  // with DIFFERENT hashes, and the second (a dedup hit against some other
  // existing row) would queue the key for offline reclaim WHILE the first
  // report's row is live and a node is pinned to it → a constructible 404.
  it("resolves when the report's hash matches the hash the grant was issued for", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    const contentHash = "e".repeat(64);
    await issueGrant({ userId, studioId, contentHash, storageKey, declaredSize: 7 });

    const resolved = await resolveGrantForReport({
      storageKey,
      actingUserId: userId,
      contentHash,
    });
    expect(resolved).toBe(studioId);
  });

  it("refuses a report whose hash differs from the grant's — one grant, one content", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({
      userId,
      studioId,
      contentHash: "e".repeat(64),
      storageKey,
      declaredSize: 7,
    });

    const resolved = await resolveGrantForReport({
      storageKey,
      actingUserId: userId,
      contentHash: "f".repeat(64),
    });
    expect(resolved).toBeNull();
  });

  it("still refuses a foreign user even when the hash matches", async () => {
    const userId = await insertUser();
    const intruderId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    const contentHash = "e".repeat(64);
    await issueGrant({ userId, studioId, contentHash, storageKey, declaredSize: 7 });

    const resolved = await resolveGrantForReport({
      storageKey,
      actingUserId: intruderId,
      contentHash,
    });
    expect(resolved).toBeNull();
  });
});

describe("upload-grant repo — consume (single-shot anti-replay)", () => {
  it("consumes once (true), then a replay fails (false) and find stops resolving", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 });

    const first = await consumeGrant({ storageKey, userId });
    expect(first).toBe(true);

    // After consumption a live find no longer resolves.
    expect(await findLiveGrant({ storageKey, userId })).toBeNull();

    // A replay of the same key is refused.
    expect(await consumeGrant({ storageKey, userId })).toBe(false);
  });

  it("does NOT consume for a foreign user", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const otherUserId = await insertUser();
    const storageKey = freshKey();
    await issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 });

    expect(await consumeGrant({ storageKey, userId: otherUserId })).toBe(false);
    // The grant is still live (the foreign attempt did not consume it).
    expect(await findLiveGrant({ storageKey, userId })).not.toBeNull();
  });

  it("INVARIANT — concurrent consume of one key: EXACTLY ONE wins", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 });

    const RACERS = 16;
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => consumeGrant({ storageKey, userId })),
    );
    const wins = results.filter((r) => r === true).length;
    expect(wins).toBe(1);
  });
});

describe("upload-grant repo — storage_key uniqueness", () => {
  it("rejects issuing the same storage_key twice (a key is issued at most once)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 });

    await expect(
      issueGrant({ userId, studioId, contentHash: fakeHash(), storageKey, declaredSize: 1 }),
    ).rejects.toThrow();
  });
});
