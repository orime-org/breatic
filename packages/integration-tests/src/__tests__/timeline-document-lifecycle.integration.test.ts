// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Real Yjs-database boundaries for empty Timeline upgrades and Project copies
 * (inner#1707): a copy keeps a target content that already exists and
 * publishes the target meta. A copy writes no Project media relation; the
 * server copies those in its own transaction (inner#2171).
 */

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";
import { createTestDb, encodeInitialMetaState, initCore, yjsDocuments } from "@breatic/core";
import { projectMetaDocName, timelineSpaceDocName } from "@breatic/shared";
import { initializeTimelineDocument, readTimelineDocument } from "@breatic/shared/space-content";
import type { TimelineSettings } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

const SETTINGS: TimelineSettings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const OTHER_SETTINGS: TimelineSettings = { width: 1280, height: 720, fps: { num: 25, den: 1 } };
const names = new Set<string>();
const documents = new Set<Y.Doc>();
let inspection: ReturnType<typeof createTestDb>;

beforeAll(() => {
  initCore(process.env);
  inspection = createTestDb(inject("YJS_DATABASE_URL"));
});

afterEach(async () => {
  try {
    if (names.size > 0) await inspection.db.delete(yjsDocuments).where(inArray(yjsDocuments.name, [...names]));
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
 * Decode a document owned by this test, including empty or unknown updates.
 * @returns The independently allocated Yjs document.
 * @throws {Error} When supplied bytes cannot be decoded.
 */
function decode(bytes?: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  documents.add(document);
  if (bytes !== undefined) Y.applyUpdate(document, bytes);
  return document;
}

/**
 * Prepare a valid seed with explicit service-owned defaults.
 * @returns A complete encoded Timeline document.
 * @throws {Error} When settings are invalid.
 */
function seed(settings: TimelineSettings = SETTINGS): Uint8Array {
  const document = decode();
  initializeTimelineDocument(document, settings);
  return Y.encodeStateAsUpdate(document);
}

/**
 * Track exactly the content or meta row created by a test.
 * @returns The same row name, registered for teardown.
 */
function own(name: string): string {
  names.add(name);
  return name;
}

/**
 * Require and decode persisted bytes without turning absent data into a seed.
 * @returns The actual encoded update.
 * @throws {Error} When the expected row is absent.
 */
function present(bytes: Uint8Array | null): Uint8Array {
  if (bytes === null) throw new Error("Expected stored document bytes");
  return bytes;
}

/**
 * Seed the source meta and its one Timeline for an isolated Project copy.
 * @returns Source and destination row identities plus the source update.
 * @throws {Error} When either seed cannot be persisted.
 */
async function copyFixture(): Promise<{
  sourceId: string; targetId: string; spaceId: string; sourceContent: string; targetContent: string;
  sourceMeta: string; targetMeta: string; bytes: Uint8Array;
}> {
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const spaceId = randomUUID();
  const sourceContent = own(timelineSpaceDocName(sourceId, spaceId));
  const targetContent = own(timelineSpaceDocName(targetId, spaceId));
  const sourceMeta = own(projectMetaDocName(sourceId));
  const targetMeta = own(projectMetaDocName(targetId));
  const bytes = seed();
  await yjsRepo.seedInitialState(sourceContent, bytes);
  await yjsRepo.seedInitialState(sourceMeta, encodeInitialMetaState({
    spaceId, kind: "timeline", name: "Timeline", createdBy: randomUUID(), ts: 1,
  }));
  return { sourceId, targetId, spaceId, sourceContent, targetContent, sourceMeta, targetMeta, bytes };
}

describe("Timeline initialization in the real Yjs database", () => {
  it("upgrades a truly empty live row and returns the complete persisted winner", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const empty = Y.encodeStateAsUpdate(decode());
    expect(Y.decodeUpdate(empty).structs).toEqual([]);
    expect(Y.decodeUpdate(empty).ds.clients.size).toBe(0);
    expect(await yjsRepo.seedInitialState(name, empty)).toBe(true);

    const loaded = present(await yjsRepo.loadTimelineDocData(name, seed()));
    expect(readTimelineDocument(decode(loaded))).toEqual({
      schemaVersion: 3, settings: SETTINGS,
      tracks: { "visual-1": { id: "visual-1", order: 0 } },
      clips: {}, sources: {},
    });
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(loaded));
  });

  it("keeps a delete-only update even though it has no structs or visible content", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const deleted = decode();
    deleted.getMap("legacy").set("key", "removed");
    deleted.getMap("legacy").delete("key");
    const bytes = Y.encodeStateAsUpdate(deleted, Y.encodeStateVector(deleted));
    expect(Y.decodeUpdate(bytes).structs).toEqual([]);
    expect(Y.decodeUpdate(bytes).ds.clients.size).toBe(1);
    await yjsRepo.seedInitialState(name, bytes);

    expect(Array.from(present(await yjsRepo.loadTimelineDocData(name, seed())))).toEqual(Array.from(bytes));
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(bytes));
  });

  it("preserves unknown nonempty content without selecting new defaults", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const unknown = decode();
    unknown.getMap("timeline").set("schemaVersion", 4);
    unknown.getMap("legacy").set("retained", "original data");
    const bytes = Y.encodeStateAsUpdate(unknown);
    await yjsRepo.seedInitialState(name, bytes);

    expect(Array.from(present(await yjsRepo.loadTimelineDocData(name, seed())))).toEqual(Array.from(bytes));
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(bytes));
  });

  it("preserves the existing V1 creation parameters", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const original = seed(OTHER_SETTINGS);
    await yjsRepo.seedInitialState(name, original);

    const loaded = present(await yjsRepo.loadTimelineDocData(name, seed()));
    expect(Array.from(loaded)).toEqual(Array.from(original));
    expect(readTimelineDocument(decode(loaded)).settings).toEqual(OTHER_SETTINGS);
  });

  it("keeps a stored version 1 document with a pixel clip as stored, and reads its clip as a frame offset (#1502 design §5)", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const old = decode();
    initializeTimelineDocument(old, SETTINGS);
    old.getMap("timeline").set("schemaVersion", 1);
    const sourceId = randomUUID();
    old.getMap("sources").set(sourceId, {
      id: sourceId, kind: "video", assetId: randomUUID(), timebase: SETTINGS.fps, extentFrames: 48, durationSeconds: "2", durationOrigin: "registered",
    });
    const clipId = randomUUID();
    const clip = new Y.Map<unknown>();
    old.getMap("clips").set(clipId, clip);
    for (const [key, value] of Object.entries({
      id: clipId, trackId: "visual-1", kind: "video", sourceId, startFrame: 0, sourceInFrame: 0, durationFrames: 48,
      rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { x: 192, y: -108, scaleX: 1, scaleY: 1, rotation: 0 },
    })) clip.set(key, value);
    const original = Y.encodeStateAsUpdate(old);
    await yjsRepo.seedInitialState(name, original);

    const loaded = present(await yjsRepo.loadTimelineDocData(name, seed()));
    expect(Array.from(loaded)).toEqual(Array.from(original));
    expect(readTimelineDocument(decode(loaded)).clips[clipId]!.transform).toEqual({ frameX: 0.1, frameY: -0.1, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it.each(["missing", "soft-deleted"] as const)("does not recreate a %s Timeline row", async (state) => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    const original = seed();
    if (state === "soft-deleted") {
      await yjsRepo.seedInitialState(name, original);
      expect(await yjsRepo.softDeleteByName(name)).toBe(true);
    }

    expect(await yjsRepo.loadTimelineDocData(name, seed(OTHER_SETTINGS))).toBeNull();
    expect(await yjsRepo.fetchDocData(name)).toBeNull();
    const rows = await inspection.client<{ data: Uint8Array; deletedAt: string | null }[]>`
      SELECT data, deleted_at::text AS "deletedAt" FROM yjs_documents WHERE name = ${name}
    `;
    expect(rows.map((row) => ({ data: Array.from(row.data), deleted: row.deletedAt !== null }))).toEqual(
      state === "missing" ? [] : [{ data: Array.from(original), deleted: true }],
    );
  });

  it("makes two actually contending upgraders return one persisted seed", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    await yjsRepo.seedInitialState(name, Y.encodeStateAsUpdate(decode()));
    const gate = await inspection.client.reserve();
    let pending = Promise.resolve<PromiseSettledResult<Uint8Array | null>[]>([]);
    let settled: PromiseSettledResult<Uint8Array | null>[] = [];
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${name} FOR UPDATE`;
      pending = Promise.allSettled([
        yjsRepo.loadTimelineDocData(name, seed()),
        yjsRepo.loadTimelineDocData(name, seed(OTHER_SETTINGS)),
      ]);
      await waitUntilBlockedOn(inspection.client, ["yjs_documents", "for update"], 2);
    } finally {
      try { await gate`ROLLBACK`; } finally { gate.release(); settled = await pending; }
    }

    const persisted = present(await yjsRepo.fetchDocData(name));
    expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") throw outcome.reason;
      expect(Array.from(present(outcome.value))).toEqual(Array.from(persisted));
    }
    expect([SETTINGS, OTHER_SETTINGS]).toContainEqual(readTimelineDocument(decode(persisted)).settings);
  });

  it("rereads a seed that another transaction committed while the loader waited", async () => {
    const name = own(timelineSpaceDocName(randomUUID(), randomUUID()));
    await yjsRepo.seedInitialState(name, Y.encodeStateAsUpdate(decode()));
    const winner = seed(OTHER_SETTINGS);
    const gate = await inspection.client.reserve();
    let pending = Promise.resolve<PromiseSettledResult<Uint8Array | null>[]>([]);
    let settled: PromiseSettledResult<Uint8Array | null>[] = [];
    let committed = false;
    try {
      await gate`BEGIN`;
      await gate`UPDATE yjs_documents SET data = ${Buffer.from(winner)} WHERE name = ${name}`;
      pending = Promise.allSettled([yjsRepo.loadTimelineDocData(name, seed())]);
      await waitUntilBlockedOn(inspection.client, ["yjs_documents", "for update"], 1);
      await gate`COMMIT`;
      committed = true;
    } finally {
      try { if (!committed) await gate`ROLLBACK`; } finally { gate.release(); settled = await pending; }
    }

    expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled"]);
    const outcome = settled[0];
    if (outcome === undefined || outcome.status !== "fulfilled") throw new Error("Expected a completed load");
    expect(Array.from(present(outcome.value))).toEqual(Array.from(winner));
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(winner));
  });
});

describe("Project copy in the real Yjs database", () => {
  it("keeps an existing target content and publishes the target meta", async () => {
    const fixture = await copyFixture();
    const winner = seed(OTHER_SETTINGS);
    await yjsRepo.seedInitialState(fixture.targetContent, winner);

    await yjsRepo.duplicateByProjectPrefix(fixture.sourceId, fixture.targetId);

    expect(Array.from(present(await yjsRepo.fetchDocData(fixture.targetContent)))).toEqual(Array.from(winner));
    const meta = decode(present(await yjsRepo.fetchDocData(fixture.targetMeta)));
    expect([...meta.getMap("spaces").keys()]).toEqual([fixture.spaceId]);
  });
});
