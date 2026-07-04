// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test — the yjs two-DB cutover against REAL Postgres.
 *
 * After the cutover the `yjs_documents` repo lives in `@breatic/collab`
 * and targets a SEPARATE database (`yjsDb` / YJS_DATABASE_URL). This
 * pins the load-bearing behaviour the cutover depends on, against a real
 * second PG database (global-setup creates `breatic_yjs_test` in the same
 * container + migrates it):
 *
 *   - repo round-trip on the yjs DB (fetch / upsert / soft-delete /
 *     restore / seed) — recreated from the old core-repo test;
 *   - the delete cascade (softDeleteByProjectPrefix) makes meta + every
 *     space doc unloadable (invariant 2's yjs side; the auth-gate side
 *     is covered by collab/auth tests);
 *   - duplicate integrity: prefix-rewrite (with the load-bearing ::int
 *     cast), meta `DO UPDATE` winning over a racing lazy-seed, canvas
 *     `DO NOTHING` idempotency on redelivery, originals untouched;
 *   - CROSS-DB CANARY: a business-DB transaction ROLLBACK does not roll
 *     back an already-committed yjs-DB write — proving the two are
 *     genuinely separate databases (and doubling as the
 *     YJS_DATABASE_URL==DATABASE_URL misconfig detector: under a
 *     same-db misconfig this test would fail).
 *
 * The repo binds the env-bound `yjsDb` singleton (initCore'd to the
 * container); a separate `createTestDb(yjsUrl)` reads raw row state.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  inject,
} from "vitest";
import { eq, like, or } from "drizzle-orm";

import {
  initCore,
  yjsDocuments,
  createTestDb,
  db as coreDb,
  encodeInitialMetaState,
} from "@breatic/core";
import * as yjsRepo from "@breatic/collab/src/services/yjs-documents.repo.js";

initCore(process.env);

const TEST_PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_DUP_PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const META = `project-${TEST_PID}/meta`;
const CANVAS = `project-${TEST_PID}/canvas-${SID}`;

let pgClient: ReturnType<typeof createTestDb>["client"];
let yjsTestDb: ReturnType<typeof createTestDb>["db"];

/** Delete only this suite's rows from the yjs DB so it can't collide. */
async function cleanup(): Promise<void> {
  await yjsTestDb
    .delete(yjsDocuments)
    .where(
      or(
        like(yjsDocuments.name, `project-${TEST_PID}/%`),
        like(yjsDocuments.name, `project-${TEST_DUP_PID}/%`),
      ),
    );
}

/** Read the raw yjs row (including `deletedAt`) for a doc name, or null. */
async function rawRow(name: string): Promise<{ deletedAt: Date | null } | null> {
  const rows = await yjsTestDb
    .select()
    .from(yjsDocuments)
    .where(eq(yjsDocuments.name, name))
    .limit(1);
  return rows[0] ?? null;
}

beforeAll(() => {
  // The raw read/seed client points at the SEPARATE yjs database.
  ({ db: yjsTestDb, client: pgClient } = createTestDb(inject("YJS_DATABASE_URL")));
});

afterAll(async () => {
  await cleanup();
  await pgClient.end();
});

beforeEach(cleanup);

describe("yjs repo against the separate yjs DB", () => {
  it("fetch returns stored bytes, then null once soft-deleted", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1, 2, 3, 4]));
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([1, 2, 3, 4]);

    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsRepo.fetchDocData(CANVAS)).toBeNull();
  });

  it("upsert resurrects a soft-deleted row (clears deleted_at)", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    await yjsRepo.softDeleteByName(CANVAS);
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([9, 9]));
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([9, 9]);
    expect((await rawRow(CANVAS))?.deletedAt).toBeNull();
  });

  it("softDeleteByName is idempotent (second call returns false)", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(false);
  });

  it("restoreByName clears deleted_at so fetch sees the row again", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([7]));
    await yjsRepo.softDeleteByName(CANVAS);
    await yjsRepo.restoreByName(CANVAS);
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([7]);
  });

  it("seedInitialState inserts once and is idempotent under a race (DO NOTHING)", async () => {
    const bytes = encodeInitialMetaState({
      spaceId: SID,
      kind: "canvas",
      name: "Canvas",
      createdBy: "system",
      creatorName: "system",
      creatorAvatarUrl: null,
      ts: 1,
    });
    expect(await yjsRepo.seedInitialState(META, bytes)).toBe(true);
    // Second seed (lazy-seed race loser) does NOT overwrite + reports false.
    expect(await yjsRepo.seedInitialState(META, new Uint8Array([0]))).toBe(false);
    expect(Array.from((await yjsRepo.fetchDocData(META))!)).toEqual(Array.from(bytes));
  });
});

describe("delete cascade (invariant 2 — yjs side)", () => {
  it("softDeleteByProjectPrefix makes meta + every space doc unloadable", async () => {
    await yjsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2]));

    await yjsRepo.softDeleteByProjectPrefix(TEST_PID);

    expect(await yjsRepo.fetchDocData(META)).toBeNull();
    expect(await yjsRepo.fetchDocData(CANVAS)).toBeNull();
  });

  it("is idempotent on redelivery (deleted_at IS NULL guard)", async () => {
    await yjsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsRepo.softDeleteByProjectPrefix(TEST_PID);
    // Redelivery: a safe no-op (does not throw, stays deleted).
    await yjsRepo.softDeleteByProjectPrefix(TEST_PID);
    expect(await yjsRepo.fetchDocData(META)).toBeNull();
  });
});

describe("duplicate integrity", () => {
  const DUP_META = `project-${TEST_DUP_PID}/meta`;
  const DUP_CANVAS = `project-${TEST_DUP_PID}/canvas-${SID}`;

  it("copies every doc to the new id with the prefix rewritten, originals intact", async () => {
    await yjsRepo.upsertDocData(META, new Uint8Array([1, 1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual([1, 1]);
    expect(Array.from((await yjsRepo.fetchDocData(DUP_CANVAS))!)).toEqual([2, 2]);
    // Source untouched.
    expect(Array.from((await yjsRepo.fetchDocData(META))!)).toEqual([1, 1]);
  });

  it("meta DO UPDATE wins over a racing lazy-seed; redelivery is idempotent", async () => {
    await yjsRepo.upsertDocData(META, new Uint8Array([1, 1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));
    // Simulate a lazy-seed having already written a DEFAULT meta at the
    // new project id before the duplicate command is consumed.
    await yjsRepo.seedInitialState(DUP_META, new Uint8Array([255]));

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    // The source meta must WIN (DO UPDATE), not the lazy-seeded default.
    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual([1, 1]);

    // Redelivery copies nothing new (canvas DO NOTHING) and re-writes the
    // same source meta — net unchanged.
    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);
    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual([1, 1]);
    expect(Array.from((await yjsRepo.fetchDocData(DUP_CANVAS))!)).toEqual([2, 2]);
  });
});

describe("cross-DB isolation (canary + misconfig detector)", () => {
  it("a business-tx ROLLBACK does not roll back an already-committed yjs write", async () => {
    await expect(
      coreDb.transaction(async () => {
        // This write goes to the SEPARATE yjs DB, outside the business tx.
        await yjsRepo.upsertDocData(CANVAS, new Uint8Array([42]));
        throw new Error("force business rollback");
      }),
    ).rejects.toThrow("force business rollback");

    // The yjs write survived the business rollback — proves two separate
    // databases (would FAIL under a YJS_DATABASE_URL==DATABASE_URL misconfig).
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([42]);
  });
});
