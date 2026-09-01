// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload-grant ledger — real-PG integration (#1826 §2.2 / §3.2, #173).
 *
 * The grant is the anti-spoof authority that replaced the prefix-based
 * `isOwnedKey`. The ticket endpoint mints a storage key K and writes one row
 * for it; later paths re-check that row rather than reading anything out of
 * the key itself.
 *
 * Ownership is (storage_key, user) ONLY — the storage key is globally unique
 * so it locates the row, and user_id decides ownership. The owner studio is
 * READ OUT of that row (recorded when the ticket was signed), never supplied
 * by the caller: that is what stops a member of two studios from charging one
 * studio's upload to the other.
 *
 * Invariants pinned here (anti-spoof critical path):
 *   - ownership: a grant resolves ONLY for its own user; a forged or foreign
 *     key never resolves; the owner studio comes back on the row;
 *   - find does NOT consume, so a path may check before it acts;
 *   - consume is single-shot (anti-replay): a replay of a consumed key fails;
 *   - CONCURRENT consume of one key: EXACTLY ONE caller wins (CAS invariant);
 *   - a VOIDED grant is as dead as a consumed one — the upload it authorised
 *     was already declared over, and the node was told so;
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
// SDK. `ai` is stubbed: the real SDK is replaced with a double that reaches
// no network, so this suite needs no API key and the SDK stays out of its
// module graph.
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
  // Every studio has exactly one admin in production — a personal studio's
  // owner holds that row like any other studio's does. The fixture went
  // without it until #89 put a ceiling lookup on this path, which resolves a
  // studio through its CURRENT admin and rightly treats a studio with none as
  // corrupt.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${rows[0]!.id}, ${ownerUserId}, 'admin')
  `;
  return rows[0]!.id;
}

/**
 * A grant's fields, with the parts a test varies. The expiry and the lease gen
 * are required on every row and play no part in ownership, so they get plain
 * values here.
 */
function grantFields(over: {
  userId: string;
  studioId: string;
  storageKey: string;
  declaredSize: number;
}): Parameters<typeof issueGrant>[0] {
  return {
    ...over,
    expiresAt: new Date(Date.now() + 300_000),
    leaseGen: 1,
    context: {},
  };
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

    const grant = await issueGrant(
      grantFields({ userId, studioId, storageKey, declaredSize: 1234 }),
    );
    expect(grant.storageKey).toBe(storageKey);
    expect(grant.consumedAt).toBeNull();

    const live = await findLiveGrant({ storageKey, userId });
    expect(live).not.toBeNull();
    expect(live!.id).toBe(grant.id);
    expect(live!.declaredSize).toBe(1234);
    // The owner studio is READ OUT of the row, never supplied by the caller.
    expect(live!.studioId).toBe(studioId);
  });

  it("does NOT resolve for a different user (forged ownership)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const otherUserId = await insertUser();
    const storageKey = freshKey();
    await issueGrant(
      grantFields({ userId, studioId, storageKey, declaredSize: 1 }),
    );

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
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    const a = await findLiveGrant({ storageKey, userId });
    const b = await findLiveGrant({ storageKey, userId });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.consumedAt).toBeNull();
  });
});

describe("upload-grant repo — consume (single-shot anti-replay)", () => {
  it("consumes once (true), then a replay fails (false) and find stops resolving", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

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
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    expect(await consumeGrant({ storageKey, userId: otherUserId })).toBe(false);
    // The grant is still live (the foreign attempt did not consume it).
    expect(await findLiveGrant({ storageKey, userId })).not.toBeNull();
  });

  it("INVARIANT — concurrent consume of one key: EXACTLY ONE wins", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    const RACERS = 16;
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => consumeGrant({ storageKey, userId })),
    );
    const wins = results.filter((r) => r === true).length;
    expect(wins).toBe(1);
  });
});

describe("upload-grant repo — a voided grant is dead", () => {
  it("stops resolving and refuses to be consumed once it is voided", async () => {
    // The sweep or an aborted report voids a grant when the upload it
    // authorised is over without an asset. The node has already been told it
    // failed by then, so a report arriving afterwards must not be able to
    // register anything against that key.
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    await sql`
      UPDATE upload_grants SET voided_at = now() WHERE storage_key = ${storageKey}
    `;

    expect(await findLiveGrant({ storageKey, userId })).toBeNull();
    expect(await consumeGrant({ storageKey, userId })).toBe(false);
  });
});

describe("upload-grant repo — storage_key uniqueness", () => {
  it("rejects issuing the same storage_key twice (a key is issued at most once)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    await expect(
      issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 })),
    ).rejects.toThrow();
  });
});
