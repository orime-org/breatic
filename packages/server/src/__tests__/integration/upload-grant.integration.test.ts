// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import { uploadGrantRepo } from "@breatic/domain";

const { issueGrant, consumeGrant, claimFinalize } = uploadGrantRepo;

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

/** A ledger row in `studioId`, for a consumed grant to point at; returns its id. */
async function insertAsset(studioId: string, userId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source,
       produced_by_user_id)
    VALUES
      (${studioId}, ${crypto.randomBytes(32).toString("hex")}, ${freshKey()},
       ${"https://cdn.example/x.png"}, 1, 'image/png', 'image', 'upload', ${userId})
    RETURNING id
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
    context: {},
  };
}

/** A fresh tenant-neutral storage key (design §3.1 format). */
function freshKey(): string {
  return `image/2026-07-25/${Date.now()}_${crypto.randomUUID()}.png`;
}

describe("upload-grant repo — issue (user-only ownership, no time limit)", () => {
  it("issues a live grant carrying the owner studio", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();

    const grant = await issueGrant(
      grantFields({ userId, studioId, storageKey, declaredSize: 1234 }),
    );
    expect(grant.storageKey).toBe(storageKey);
    expect(grant.consumedAt).toBeNull();
    expect(grant.declaredSize).toBe(1234);
    // The owner studio is READ OUT of the row, never supplied by the caller.
    expect(grant.studioId).toBe(studioId);
  });

  it("refuses a forged key that was never issued", async () => {
    const userId = await insertUser();
    expect(await consumeGrant({ storageKey: freshKey(), userId, assetId: crypto.randomUUID() })).toBe(false);
  });
});

describe("upload-grant repo — consume (single-shot anti-replay)", () => {
  it("consumes once (true), then a replay fails (false)", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);

    const first = await consumeGrant({ storageKey, userId, assetId });
    expect(first).toBe(true);

    // A replay of the same key is refused.
    expect(await consumeGrant({ storageKey, userId, assetId })).toBe(false);
  });

  it("does NOT consume for a foreign user", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const otherUserId = await insertUser();
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);

    expect(await consumeGrant({ storageKey, userId: otherUserId, assetId })).toBe(false);
    // The grant is still live: its own user can still consume it.
    expect(await consumeGrant({ storageKey, userId, assetId })).toBe(true);
  });

  it("INVARIANT — concurrent consume of one key: EXACTLY ONE wins", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);

    const RACERS = 16;
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => consumeGrant({ storageKey, userId, assetId })),
    );
    const wins = results.filter((r) => r === true).length;
    expect(wins).toBe(1);
  });
});

describe("upload-grant repo — a voided grant is dead", () => {
  it("refuses to be consumed once it is voided", async () => {
    // The sweep or an aborted report voids a grant when the upload it
    // authorised is over without an asset. The node has already been told it
    // failed by then, so a report arriving afterwards must not be able to
    // register anything against that key.
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);

    await sql`
      UPDATE upload_grants SET voided_at = now() WHERE storage_key = ${storageKey}
    `;

    expect(await consumeGrant({ storageKey, userId, assetId })).toBe(false);
  });
});

describe("upload-grant repo — the permission to finish an upload", () => {
  // What this stops is a replay of a ticket still inside its window. Measured
  // on real workerd (design §6.4): completing the same uploadId twice throws,
  // but opening a NEW multipart upload on a key already registered and
  // completing that one silently overwrites the object — and dedup means the
  // bytes another member of the studio sees are the ones written over.
  //
  // The uploadId is what separates the two: a replay has to open its own
  // upload and so brings a new one, while a retry of the same delivery brings
  // the one the browser already holds.

  it("lets the first asker through and records which upload it was", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toEqual({
      granted: true,
      assetSource: null,
      projectId: null,
      spaceId: null,
      spaceUploadId: null,
      spaceUploadTarget: null,
    });
    const rows = await sql<{ finalizing_upload_id: string | null }[]>`
      SELECT finalizing_upload_id FROM upload_grants WHERE storage_key = ${storageKey}
    `;
    expect(rows[0]!.finalizing_upload_id).toBe("upload-a");
  });

  it.each(["document", "timeline"] as const)(
    "hands back the %s placeholder the upload is for, so the finish can tell it without reading the grant again (inner#1709 design §4.1)",
    async (target) => {
      const userId = await insertUser();
      const studioId = await insertStudio(userId);
      const storageKey = freshKey();
      await issueGrant({
        ...grantFields({ userId, studioId, storageKey, declaredSize: 1 }),
        context: { spaceUploadId: "u1", spaceUploadTarget: target },
      });

      expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toMatchObject({
        granted: true, spaceUploadId: "u1", spaceUploadTarget: target,
      });
      const rows = await sql<{ space_upload_id: string | null; space_upload_target: string | null }[]>`
        SELECT space_upload_id, space_upload_target FROM upload_grants WHERE storage_key = ${storageKey}
      `;
      expect(rows).toEqual([{ space_upload_id: "u1", space_upload_target: target }]);
    },
  );

  it("lets the same upload ask again, so three deliveries all get through", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toEqual({
        granted: true,
        assetSource: null,
        projectId: null,
        spaceId: null,
        spaceUploadId: null,
      spaceUploadTarget: null,
      });
    }
  });

  it("refuses a different upload on a key somebody is already finishing", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    await claimFinalize({ storageKey, uploadId: "upload-a" });

    expect(await claimFinalize({ storageKey, uploadId: "upload-b" })).toEqual({
      granted: false,
      reason: "in_flight",
    });
  });

  it("still lets its own upload through after the key is registered", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);
    await claimFinalize({ storageKey, uploadId: "upload-a" });
    await consumeGrant({ storageKey, userId, assetId });

    // Registration is not what ends this upload's claim on the key — the
    // browser may not have heard the answer, and its retry brings the same
    // uploadId. R2 refuses a second complete on that id rather than writing
    // anything, and the report it then repeats is answered from the ledger,
    // so this delivery finishes with the URL that was actually registered
    // instead of one guessed from the key.
    expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toEqual({
      granted: true,
      assetSource: null,
      projectId: null,
      spaceId: null,
      spaceUploadId: null,
      spaceUploadTarget: null,
    });
  });

  // The finish decides off it whether to read the media now (#299), and the
  // grant is the one place it was written by our server.
  it("hands back what the grant says the upload is", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant({
      ...grantFields({ userId, studioId, storageKey, declaredSize: 1 }),
      context: { assetSource: "project_cover" },
    });

    expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toEqual({
      granted: true,
      assetSource: "project_cover",
      projectId: null,
      spaceId: null,
      spaceUploadId: null,
      spaceUploadTarget: null,
    });
  });

  it("refuses a different upload once the key is registered", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    const assetId = await insertAsset(studioId, userId);
    await claimFinalize({ storageKey, uploadId: "upload-a" });
    await consumeGrant({ storageKey, userId, assetId });

    // A replay: it had to open its own multipart upload, and completing that
    // one WOULD overwrite the object the ledger describes.
    expect(await claimFinalize({ storageKey, uploadId: "upload-b" })).toEqual({
      granted: false,
      reason: "already_registered",
    });
  });

  it("refuses on a voided grant", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    await sql`
      UPDATE upload_grants SET voided_at = now() WHERE storage_key = ${storageKey}
    `;

    expect(await claimFinalize({ storageKey, uploadId: "upload-a" })).toEqual({
      granted: false,
      reason: "no_grant",
    });
  });

  it("refuses a key that was never issued", async () => {
    expect(
      await claimFinalize({ storageKey: freshKey(), uploadId: "upload-a" }),
    ).toEqual({ granted: false, reason: "no_grant" });
  });

  it("INVARIANT — concurrent claims by different uploads: EXACTLY ONE wins", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));

    const RACERS = 16;
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        claimFinalize({ storageKey, uploadId: `upload-${i}` }),
      ),
    );
    expect(results.filter((r) => r.granted).length).toBe(1);
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

/**
 * Read a grant's state columns, timestamps as full-precision text.
 * @param storageKey - The grant's key.
 * @returns The row, or undefined when no grant has the key.
 */
async function stateOf(storageKey: string): Promise<
  | { consumed_at: string | null; voided_at: string | null; asset_id: string | null; failure_reason: string | null }
  | undefined
> {
  const rows = await sql<
    { consumed_at: string | null; voided_at: string | null; asset_id: string | null; failure_reason: string | null }[]
  >`
    SELECT consumed_at::text AS consumed_at, voided_at::text AS voided_at, asset_id, failure_reason
    FROM upload_grants WHERE storage_key = ${storageKey}
  `;
  return rows[0];
}

describe("T36: completeTransferGrant completes only a live transfer grant (inner#1006 §4.3)", () => {
  /**
   * A transfer key in the design's format.
   * @returns A fresh key under `transfer/`.
   */
  function transferKey(): string {
    return `transfer/2026-10-24/${Date.now()}_${crypto.randomUUID()}.transfer`;
  }

  it("(a) leaves a voided transfer grant voided and answers failure", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = transferKey();
    await issueGrant({
      ...grantFields({ userId, studioId, storageKey, declaredSize: 1500019 }),
      context: { assetSource: "transfer", derived: true, filename: "body.transfer" },
    });
    await claimFinalize({ storageKey, uploadId: "upload-t36a" });
    expect(await uploadGrantRepo.voidGrant(storageKey, "unsupported_type")).toBe(true);
    const before = await stateOf(storageKey);

    expect(await uploadGrantRepo.completeTransferGrant(storageKey)).toBe(false);

    expect(await stateOf(storageKey)).toEqual(before);
    expect(before!.consumed_at).toBeNull();
  });

  it("(b) leaves an ordinary finishing grant unconsumed and answers failure", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    const storageKey = freshKey();
    await issueGrant(grantFields({ userId, studioId, storageKey, declaredSize: 1 }));
    await claimFinalize({ storageKey, uploadId: "upload-t36b" });
    const before = await stateOf(storageKey);

    expect(await uploadGrantRepo.completeTransferGrant(storageKey)).toBe(false);

    expect(await stateOf(storageKey)).toEqual(before);
    expect(before!.consumed_at).toBeNull();
  });

  it("(c) answers failure for a key never issued and writes no row", async () => {
    const storageKey = transferKey();

    expect(await uploadGrantRepo.completeTransferGrant(storageKey)).toBe(false);

    expect(await stateOf(storageKey)).toBeUndefined();
  });
});

describe("upload_grants names the Space placeholder an upload lands in (inner#1709 design §4.1)", () => {
  const MIGRATIONS = new URL("../../../../core/src/db/migrations/", import.meta.url);

  class Rollback extends Error {}

  /**
   * Run `body` in a transaction that is always rolled back.
   * @param body - Seeds, replays and reads.
   */
  async function rolledBack(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    await sql
      .begin(async (tx) => {
        await body(tx);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  /**
   * The one migration that introduces `space_upload_target`.
   * @returns Its SQL.
   */
  async function placeholderMigration(): Promise<string> {
    const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
    const found: { name: string; text: string }[] = [];
    for (const name of files) {
      const text = await readFile(new URL(name, MIGRATIONS), "utf8");
      if (text.includes("space_upload_target")) found.push({ name, text });
    }
    expect(found.map((f) => f.name)).toHaveLength(1);
    return found[0]!.text;
  }

  it("keeps the placeholder in space_upload_id and its Space type in space_upload_target, with no document_upload_id left", async () => {
    const columns = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'upload_grants'
        AND column_name IN ('document_upload_id', 'space_upload_id', 'space_upload_target')
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "space_upload_id", data_type: "text" },
      { column_name: "space_upload_target", data_type: "text" },
    ]);
  });

  it.each([
    ["a placeholder without its Space type", "u1", null],
    ["a Space type without a placeholder", null, "timeline"],
  ])("refuses a grant row naming %s", async (_label, uploadId, target) => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    await expect(sql`
      INSERT INTO upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, space_upload_id, space_upload_target)
      VALUES (${userId}, ${studioId}, ${freshKey()}, 1, now() + interval '5 minutes', ${uploadId}, ${target})
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a grant row naming both or neither", async () => {
    const userId = await insertUser();
    const studioId = await insertStudio(userId);
    for (const [uploadId, target] of [["u1", "document"], ["u2", "timeline"], [null, null]] as const) {
      const storageKey = freshKey();
      await sql`
        INSERT INTO upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, space_upload_id, space_upload_target)
        VALUES (${userId}, ${studioId}, ${storageKey}, 1, now() + interval '5 minutes', ${uploadId}, ${target})
      `;
      const rows = await sql<{ space_upload_id: string | null; space_upload_target: string | null }[]>`
        SELECT space_upload_id, space_upload_target FROM upload_grants WHERE storage_key = ${storageKey}
      `;
      expect(rows).toEqual([{ space_upload_id: uploadId, space_upload_target: target }]);
    }
  });

  it("moves every existing Document block upload to space_upload_id with the Document target, and leaves other grants without one", async () => {
    const migration = await placeholderMigration();
    await rolledBack(async (tx) => {
      // The table as it stood before the migration: the migrated one with the Document block column back in place.
      await tx.unsafe(`
        CREATE SCHEMA grant_migration_1709;
        CREATE TABLE grant_migration_1709.upload_grants (LIKE public.upload_grants INCLUDING DEFAULTS);
        ALTER TABLE grant_migration_1709.upload_grants DROP COLUMN space_upload_target;
        ALTER TABLE grant_migration_1709.upload_grants RENAME COLUMN space_upload_id TO document_upload_id;
      `);
      const block = crypto.randomUUID();
      await tx.unsafe(`
        INSERT INTO grant_migration_1709.upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, document_upload_id)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'block', 1, now(), '${block}'),
               (gen_random_uuid(), gen_random_uuid(), 'node', 1, now(), NULL);
      `);
      await tx.unsafe("SET LOCAL search_path TO grant_migration_1709");
      await tx.unsafe(migration);
      const rows = await tx.unsafe<{ storage_key: string; space_upload_id: string | null; space_upload_target: string | null }[]>(
        "SELECT storage_key, space_upload_id, space_upload_target FROM grant_migration_1709.upload_grants ORDER BY storage_key",
      );
      expect([...rows]).toEqual([
        { storage_key: "block", space_upload_id: block, space_upload_target: "document" },
        { storage_key: "node", space_upload_id: null, space_upload_target: null },
      ]);
    });
  });
});
