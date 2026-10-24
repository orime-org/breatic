// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Timeline snapshot persistence against the real, separate Yjs database.
 *
 * Two independently edited documents can reach storage before their updates
 * have relayed to each other. A confirmed update and its delete set must
 * survive the later stale snapshot (inner#1707). The repository is driven
 * directly, so neither Redis nor a simulated persistence layer can make the
 * assertions pass. The canonical server lock probe is reused here, which
 * places this test in the cross-service integration package.
 */

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";

import { createTestDb, initCore, yjsDocuments } from "@breatic/core";
import { spaceContentDocName } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

const SOURCE = {
  id: "169c5570-df77-4e22-8727-8554f93c56b5",
  kind: "video",
  assetId: "67ac0a96-4c1b-4713-8f39-bbc761e6f777",
  timebase: { num: 24, den: 1 },
  extentFrames: 240,
  durationSeconds: "10",
  durationOrigin: "registered",
} as const;

interface ClipFixture {
  id: string;
  trackId: string;
  kind: "video";
  sourceId: string;
  startFrame: number;
  sourceInFrame: number;
  durationFrames: number;
  rate: { num: number; den: number };
  gain: number;
  mute: boolean;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
}

interface EditFixture {
  version: 1;
  actionId: string;
  operation: "add_video";
  effect: "applied";
  targetClipIds: string[];
  parameters: { source: typeof SOURCE; clip: ClipFixture };
}

interface PlacementFixture {
  clip: ClipFixture;
  record: EditFixture;
}

let inspection: ReturnType<typeof createTestDb>;
const documents = new Set<Y.Doc>();
const names = new Set<string>();

beforeAll(() => {
  initCore(process.env);
  inspection = createTestDb(inject("YJS_DATABASE_URL"));
});

afterEach(async () => {
  try {
    if (names.size > 0) {
      await inspection.db.delete(yjsDocuments).where(inArray(yjsDocuments.name, [...names]));
    }
  } finally {
    names.clear();
    for (const document of documents) document.destroy();
    documents.clear();
  }
});

afterAll(async () => {
  await inspection.client.end();
});

/**
 * Allocate a document owned by this test and release it during teardown.
 * @returns The independent document, optionally restored from supplied bytes.
 * @throws {Error} When the supplied update cannot be decoded.
 */
function trackedDocument(bytes?: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  documents.add(document);
  if (bytes !== undefined) Y.applyUpdate(document, bytes);
  return document;
}

/**
 * Build a shared seed from which separate instances can diverge.
 * @returns An initial Timeline document with one visual track and a source.
 */
function initialTimeline(): Y.Doc {
  const document = trackedDocument();
  document.getMap("timeline").set("schemaVersion", 1);
  document.getMap("timeline").set("settings", {
    width: 1920,
    height: 1080,
    fps: { num: 24, den: 1 },
  });
  const track = new Y.Map<unknown>();
  document.getMap("tracks").set("visual-1", track);
  track.set("id", "visual-1");
  track.set("kind", "visual");
  track.set("order", 0);
  document.getMap("sources").set(SOURCE.id, SOURCE);
  return document;
}

/**
 * Allocate an isolated row name that teardown can remove precisely.
 * @returns The named content document in the requested Space namespace.
 */
function documentName(kind: "timeline" | "canvas" | "document" = "timeline"): string {
  const name = spaceContentDocName(randomUUID(), randomUUID(), kind);
  names.add(name);
  return name;
}

/**
 * Add one fixture placement and its immutable record in the same transaction.
 * @returns The exact inputs later expected from the stored document.
 */
function addPlacement(document: Y.Doc, startFrame: number, clipId: string = randomUUID()): PlacementFixture {
  const clip: ClipFixture = {
    id: clipId,
    trackId: "visual-1",
    kind: "video",
    sourceId: SOURCE.id,
    startFrame,
    sourceInFrame: 0,
    durationFrames: 24,
    rate: { num: 1, den: 1 },
    gain: 1,
    mute: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };
  const record: EditFixture = {
    version: 1,
    actionId: randomUUID(),
    operation: "add_video",
    effect: "applied",
    targetClipIds: [clip.id],
    parameters: { source: SOURCE, clip },
  };
  document.transact(() => {
    const storedClip = new Y.Map<unknown>();
    document.getMap("clips").set(clip.id, storedClip);
    for (const [field, value] of Object.entries(clip)) storedClip.set(field, value);
    document.getMap("nativeEdits").set(record.actionId, record);
  });
  return { clip, record };
}

/**
 * Read the real repository result into a separately owned document.
 * @returns The decoded live database bytes.
 * @throws {Error} When the row is absent or the update cannot be decoded.
 */
async function loadStored(name: string): Promise<Y.Doc> {
  const bytes = await yjsRepo.fetchDocData(name);
  if (bytes === null) throw new Error(`Expected a live persisted document: ${name}`);
  return trackedDocument(bytes);
}

/**
 * Assert full fixture layouts and full immutable records, including no extras.
 * @returns Nothing once both stored maps match the expected facts.
 * @throws {AssertionError} When the stored layouts or records differ.
 */
function expectPlacements(document: Y.Doc, placements: readonly PlacementFixture[]): void {
  expect(document.getMap("clips").toJSON()).toEqual(
    Object.fromEntries(placements.map(({ clip }) => [clip.id, clip])),
  );
  expect(document.getMap("nativeEdits").toJSON()).toEqual(
    Object.fromEntries(placements.map(({ record }) => [record.actionId, record])),
  );
}

describe("Timeline snapshot persistence in the real Yjs database", () => {
  it.each(["first-then-second", "second-then-first"] as const)(
    "retains both independently edited snapshots when stored %s",
    async (order) => {
      const name = documentName();
      const seed = Y.encodeStateAsUpdate(initialTimeline());
      const first = trackedDocument(seed);
      const second = trackedDocument(seed);
      const firstPlacement = addPlacement(first, 0);
      const secondPlacement = addPlacement(second, 24);
      expect(await yjsRepo.seedInitialState(name, seed)).toBe(true);

      const updates = [Y.encodeStateAsUpdate(first), Y.encodeStateAsUpdate(second)];
      if (order === "second-then-first") updates.reverse();
      for (const update of updates) await yjsRepo.upsertDocData(name, update);

      expectPlacements(await loadStored(name), [firstPlacement, secondPlacement]);
    },
  );

  it("merges two writers observed waiting at the same row lock", async () => {
    const name = documentName();
    const seed = Y.encodeStateAsUpdate(initialTimeline());
    const first = trackedDocument(seed);
    const second = trackedDocument(seed);
    const firstPlacement = addPlacement(first, 0);
    const secondPlacement = addPlacement(second, 24);
    expect(await yjsRepo.seedInitialState(name, seed)).toBe(true);

    const gate = await inspection.client.reserve();
    let pending = Promise.resolve<PromiseSettledResult<void>[]>([]);
    let settled: PromiseSettledResult<void>[] = [];
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${name} FOR UPDATE`;
      pending = Promise.allSettled([
        yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(first)),
        yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(second)),
      ]);
      // Two parked statements prove two independent writer connections reached
      // the required read lock; an INSERT/UPDATE wait is not that observation.
      await waitUntilBlockedOn(inspection.client, ["yjs_documents", "for update"], 2);
    } finally {
      try {
        await gate`ROLLBACK`;
      } finally {
        gate.release();
        settled = await pending;
      }
    }

    expect(settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    expectPlacements(await loadStored(name), [firstPlacement, secondPlacement]);
  });

  it("preserves a pure deletion when a previously stored full snapshot arrives late", async () => {
    const name = documentName();
    const document = initialTimeline();
    const placement = addPlacement(document, 0);
    const stale = Y.encodeStateAsUpdate(document);
    await yjsRepo.upsertDocData(name, stale);

    const vectorBefore = Y.encodeStateVector(document);
    document.getMap("clips").delete(placement.clip.id);
    expect(Y.encodeStateVector(document)).toEqual(vectorBefore);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(document));
    expect((await loadStored(name)).getMap("clips").toJSON()).toEqual({});
    await yjsRepo.upsertDocData(name, stale);

    const stored = await loadStored(name);
    expect(stored.getMap("clips").toJSON()).toEqual({});
    expect(stored.getMap("nativeEdits").toJSON()).toEqual({
      [placement.record.actionId]: placement.record,
    });
  });

  it("keeps a later intentional set after an earlier deletion", async () => {
    const name = documentName();
    const document = initialTimeline();
    const original = addPlacement(document, 0);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(document));
    document.getMap("clips").delete(original.clip.id);
    const deleted = Y.encodeStateAsUpdate(document);
    await yjsRepo.upsertDocData(name, deleted);

    const later = trackedDocument(deleted);
    const restored = addPlacement(later, 72, original.clip.id);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(later));
    await yjsRepo.upsertDocData(name, deleted);

    const stored = await loadStored(name);
    expect(stored.getMap("clips").toJSON()).toEqual({ [restored.clip.id]: restored.clip });
    expect(stored.getMap("nativeEdits").toJSON()).toEqual({
      [original.record.actionId]: original.record,
      [restored.record.actionId]: restored.record,
    });
  });

  it("does not duplicate layouts or records when the same stale snapshots are retried", async () => {
    const name = documentName();
    const seed = Y.encodeStateAsUpdate(initialTimeline());
    const first = trackedDocument(seed);
    const second = trackedDocument(seed);
    const firstPlacement = addPlacement(first, 0);
    const secondPlacement = addPlacement(second, 24);
    for (const document of [first, second, first, second]) {
      await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(document));
    }

    expectPlacements(await loadStored(name), [firstPlacement, secondPlacement]);
  });

  it("merges late content without reviving a soft-deleted Timeline", async () => {
    const name = documentName();
    const seed = Y.encodeStateAsUpdate(initialTimeline());
    const first = trackedDocument(seed);
    const second = trackedDocument(seed);
    const firstPlacement = addPlacement(first, 0);
    const secondPlacement = addPlacement(second, 24);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(first));
    expect(await yjsRepo.softDeleteByName(name)).toBe(true);
    const [before] = await inspection.client<{ deletedAt: string }[]>`
      SELECT deleted_at::text AS "deletedAt" FROM yjs_documents WHERE name = ${name}
    `;
    if (before === undefined || typeof before.deletedAt !== "string") {
      throw new Error("Expected the persisted soft-delete timestamp before the late store");
    }

    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(second));

    expect(await yjsRepo.fetchDocData(name)).toBeNull();
    const [after] = await inspection.client<{ deletedAt: string; data: Uint8Array }[]>`
      SELECT deleted_at::text AS "deletedAt", data FROM yjs_documents WHERE name = ${name}
    `;
    if (after === undefined) throw new Error("The soft-deleted row must be retained");
    expect(after.deletedAt).toBe(before.deletedAt);
    expectPlacements(trackedDocument(after.data), [firstPlacement, secondPlacement]);

    expect(await yjsRepo.restoreByName(name)).toBe(true);
    expectPlacements(await loadStored(name), [firstPlacement, secondPlacement]);
  });

  it.each(["canvas", "document"] as const)("keeps the existing %s replacement policy", async (kind) => {
    const name = documentName(kind);
    const first = trackedDocument();
    const second = trackedDocument();
    first.getMap("payload").set("first", "earlier snapshot");
    second.getMap("payload").set("second", "replacement snapshot");

    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(first));
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(second));

    expect((await loadStored(name)).getMap("payload").toJSON()).toEqual({
      second: "replacement snapshot",
    });
  });
});
