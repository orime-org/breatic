// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared Space snapshot storage against the real, separate Yjs database.
 *
 * Every Space uses the existing repository upsert policy. A late store keeps
 * the deletion marker and replaces the stored snapshot, so restoring a Space
 * reads that latest snapshot without a Timeline-specific SQL merge.
 */

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";

import { createTestDb, initCore, yjsDocuments } from "@breatic/core";
import { spaceContentDocName } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

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

interface PlacementFixture {
  clip: ClipFixture;
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
 * Add one fixture placement to the shared collaborative layout.
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
  document.transact(() => {
    const storedClip = new Y.Map<unknown>();
    document.getMap("clips").set(clip.id, storedClip);
    for (const [field, value] of Object.entries(clip)) storedClip.set(field, value);
  });
  return { clip };
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
 * Assert complete fixture placements and their source, including no extras.
 * @returns Nothing once both stored maps match the expected facts.
 * @throws {AssertionError} When the stored placements or source differ.
 */
function expectPlacements(document: Y.Doc, placements: readonly PlacementFixture[]): void {
  expect(document.getMap("clips").toJSON()).toEqual(
    Object.fromEntries(placements.map(({ clip }) => [clip.id, clip])),
  );
  expect(document.getMap("sources").toJSON()).toEqual({ [SOURCE.id]: SOURCE });
}

describe("Shared Space snapshot persistence in the real Yjs database", () => {
  it("stores late content without reviving a soft-deleted Timeline", async () => {
    const name = documentName();
    const seed = Y.encodeStateAsUpdate(initialTimeline());
    const first = trackedDocument(seed);
    const second = trackedDocument(seed);
    addPlacement(first, 0);
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
    expectPlacements(trackedDocument(after.data), [secondPlacement]);

    expect(await yjsRepo.restoreByName(name)).toBe(true);
    expectPlacements(await loadStored(name), [secondPlacement]);
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
