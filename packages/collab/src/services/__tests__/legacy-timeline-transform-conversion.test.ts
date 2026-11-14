// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1502 design §5: when collab loads a Timeline document, clips whose transform is stored in canvas pixels (`x`, `y`,
 * the format before #1502) are stored again as offsets in frame widths and heights (`frameX`, `frameY`) of the
 * document's current frame, and a version 1 document becomes version 2, under a per-document lock, in one
 * transaction, without moving any layer on screen.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { initializeTimelineDocument, readTimelineDocument } from "@breatic/shared/space-content";

import {
  LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN,
  convertStoredTimelineTransformsOnLoad,
} from "@collab/services/legacy-timeline-transform-conversion.js";

vi.mock("@breatic/core", () => ({ env: { ENV: "test" } }));

const NAME = "project-p/timeline-s";
const SOURCE = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "video" as const,
  assetId: "20000000-0000-4000-8000-000000000001",
  timebase: { num: 24, den: 1 },
  extentFrames: 48,
  durationSeconds: "2",
  durationOrigin: "registered" as const,
};
const PIXEL_CLIP = "30000000-0000-4000-8000-000000000001";
const FRACTION_CLIP = "30000000-0000-4000-8000-000000000002";
const LATE_CLIP = "30000000-0000-4000-8000-000000000003";
const SCALE = { scaleX: 0.5, scaleY: 2, rotation: 30 };
const FRAMES = {
  "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 }, "4:5": { width: 1080, height: 1350 }, "2:3": { width: 1080, height: 1620 },
  "21:9": { width: 2520, height: 1080 },
} as const;

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.restoreAllMocks();
});

/**
 * A seeded Timeline document at a stored schema version and frame.
 * @param version - The stored `schemaVersion`.
 * @param frame - The stored frame size.
 * @param frame.width - Frame width.
 * @param frame.height - Frame height.
 * @returns The document.
 */
function timelineDoc(version: 1 | 2, frame: { width: number; height: number } = FRAMES["16:9"]): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  initializeTimelineDocument(doc, { ...frame, fps: { num: 24, den: 1 } });
  doc.getMap("timeline").set("schemaVersion", version);
  doc.getMap("sources").set(SOURCE.id, SOURCE);
  return doc;
}

/**
 * Store a clip record the way a writer does, its transform in the given stored format.
 * @param doc - The document.
 * @param id - The clip id.
 * @param transform - `{ x, y }` for the pixel format, `{ frameX, frameY }` for the fraction format.
 * @returns The record.
 */
function storeClip(doc: Y.Doc, id: string, transform: Record<string, number>): Y.Map<unknown> {
  const record = new Y.Map<unknown>();
  doc.transact(() => {
    doc.getMap("clips").set(id, record);
    for (const [key, value] of Object.entries({
      id, trackId: "visual-1", kind: "video", sourceId: SOURCE.id, startFrame: 0, sourceInFrame: 0, durationFrames: 48,
      rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { ...transform, ...SCALE },
    })) record.set(key, value);
  }, "peer");
  return record;
}

/**
 * A copy of a document, as a second instance or a later load holds it.
 * @param doc - The original.
 * @returns The copy.
 */
function copyOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  docs.push(copy);
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/**
 * A clip's stored transform.
 * @param doc - The document.
 * @param id - The clip id.
 * @returns The stored value.
 */
function storedTransform(doc: Y.Doc, id: string): unknown {
  return (doc.getMap("clips").get(id) as Y.Map<unknown>).get("transform");
}

/**
 * Every update a document emits from now on, with its origin.
 * @param doc - The document.
 * @returns The list, filled as updates arrive.
 */
function recordUpdates(doc: Y.Doc): unknown[] {
  const origins: unknown[] = [];
  doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
  return origins;
}

/**
 * Run the on-load conversion with a lock that is always free and nothing stored again.
 * @param document - The loaded document.
 * @param takeLock - The lock, when a case watches it.
 * @returns How many clips this instance converted.
 */
function convert(document: Y.Doc, takeLock: (key: string) => Promise<boolean> = async () => true): Promise<number> {
  return convertStoredTimelineTransformsOnLoad({ documentName: NAME, document, takeLock, readStored: async () => null });
}

describe("which loaded Timeline documents are converted (#1502 design §5)", () => {
  it("does not take the lock or write for a version 2 document without pixel clips", async () => {
    const doc = timelineDoc(2);
    storeClip(doc, FRACTION_CLIP, { frameX: 0.35, frameY: -0.35 });
    const before = Y.encodeStateAsUpdate(doc);
    const updates = recordUpdates(doc);
    const takeLock = vi.fn(async () => true);

    expect(await convert(doc, takeLock)).toBe(0);

    expect(takeLock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("does not take the lock for a document that holds no Timeline content", async () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const takeLock = vi.fn(async () => true);

    expect(await convert(doc, takeLock)).toBe(0);

    expect(takeLock).not.toHaveBeenCalled();
    expect(doc.share.has("timeline")).toBe(false);
  });

  it("writes schemaVersion 2 to a version 1 document even when it holds no pixel clip, in one transaction", async () => {
    const doc = timelineDoc(1);
    const updates = recordUpdates(doc);
    const takeLock = vi.fn(async () => true);

    expect(await convert(doc, takeLock)).toBe(0);

    expect(takeLock).toHaveBeenCalledTimes(1);
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(updates).toEqual([LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN]);
  });
});

describe("converting pixel clips on load (#1502 design §5)", () => {
  it("stores pixel clips as offsets of the current frame and version 2 in one transaction, leaving fraction clips alone", async () => {
    const doc = timelineDoc(1, FRAMES["9:16"]);
    storeClip(doc, PIXEL_CLIP, { x: 108, y: -192 });
    storeClip(doc, FRACTION_CLIP, { frameX: 0.35, frameY: -0.35 });
    const updates = recordUpdates(doc);

    expect(await convert(doc)).toBe(1);

    expect(storedTransform(doc, PIXEL_CLIP)).toEqual({ frameX: 0.1, frameY: -0.1, ...SCALE });
    expect(storedTransform(doc, FRACTION_CLIP)).toEqual({ frameX: 0.35, frameY: -0.35, ...SCALE });
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(updates).toEqual([LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN]);
  });

  it("moves no layer: the document reads the same before and after", async () => {
    const doc = timelineDoc(1);
    storeClip(doc, PIXEL_CLIP, { x: 480, y: -270 });
    storeClip(doc, FRACTION_CLIP, { frameX: 0.35, frameY: -0.35 });
    const shown = readTimelineDocument(doc).clips;

    await convert(doc);

    expect(readTimelineDocument(doc).clips).toEqual(shown);
  });

  it("does nothing the second time", async () => {
    const doc = timelineDoc(1);
    storeClip(doc, PIXEL_CLIP, { x: 192, y: -108 });
    await convert(doc);
    const once = Y.encodeStateAsUpdate(doc);
    const takeLock = vi.fn(async () => true);

    expect(await convert(doc, takeLock)).toBe(0);

    expect(takeLock).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
  });

  it("converts on the next load a pixel clip an old page wrote after the document was converted", async () => {
    const doc = timelineDoc(1);
    storeClip(doc, PIXEL_CLIP, { x: 192, y: -108 });
    await convert(doc);
    const later = copyOf(doc);
    storeClip(later, LATE_CLIP, { x: -960, y: 540 });

    expect(await convert(later)).toBe(1);

    expect(storedTransform(later, LATE_CLIP)).toEqual({ frameX: -0.5, frameY: 0.5, ...SCALE });
    expect(storedTransform(later, PIXEL_CLIP)).toEqual({ frameX: 0.1, frameY: -0.1, ...SCALE });
    expect(later.getMap("timeline").get("schemaVersion")).toBe(2);
  });

  it("leaves the document as it was when reading the stored copy under the lock fails", async () => {
    const doc = timelineDoc(1);
    storeClip(doc, PIXEL_CLIP, { x: 192, y: -108 });
    const before = Y.encodeStateAsUpdate(doc);

    await expect(convertStoredTimelineTransformsOnLoad({
      documentName: NAME,
      document: doc,
      takeLock: async () => true,
      readStored: async () => {
        throw new Error("stored copy unreadable");
      },
    })).rejects.toThrow("stored copy unreadable");

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("converting under the document's lock (#1502 design §5)", () => {
  it("converts under the document's lock, and leaves it to the instance holding it", async () => {
    const keys: string[] = [];
    let held = false;
    /**
     * A lock only the first taker gets.
     * @param key - The key.
     * @returns Whether this caller took it.
     */
    const takeLock = async (key: string): Promise<boolean> => {
      keys.push(key);
      if (held) return false;
      held = true;
      return true;
    };
    const first = timelineDoc(1);
    storeClip(first, PIXEL_CLIP, { x: 192, y: -108 });
    const second = copyOf(first);
    const secondBefore = Y.encodeStateAsUpdate(second);

    const a = await convert(first, takeLock);
    const b = await convert(second, takeLock);

    expect([a, b]).toEqual([1, 0]);
    expect(Y.encodeStateAsUpdate(second)).toEqual(secondBefore);
    expect(keys).toEqual([
      "test:collab:lock:timeline-transform-migrate:project-p/timeline-s",
      "test:collab:lock:timeline-transform-migrate:project-p/timeline-s",
    ]);
  });

  it("reads the stored document again under the lock, and writes nothing of its own when it is converted there", async () => {
    // B loaded before A stored its conversion; A's lock has expired. Both loaded the same stored copy, so any write
    // under B's own client id is a conversion B made.
    const storedBefore = timelineDoc(1);
    storeClip(storedBefore, PIXEL_CLIP, { x: 192, y: -108 });
    const loadedByB = copyOf(storedBefore);
    const storedByA = copyOf(storedBefore);
    await convert(storedByA);

    const converted = await convertStoredTimelineTransformsOnLoad({
      documentName: NAME,
      document: loadedByB,
      takeLock: async () => true,
      readStored: async () => Y.encodeStateAsUpdate(storedByA),
    });

    expect(converted).toBe(0);
    expect(storedTransform(loadedByB, PIXEL_CLIP)).toEqual({ frameX: 0.1, frameY: -0.1, ...SCALE });
    expect(loadedByB.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(Y.decodeStateVector(Y.encodeStateVector(loadedByB)).has(loadedByB.clientID)).toBe(false);
  });
});

describe("what any converted document holds (#1502 design §5)", () => {
  it("moves no layer, leaves no pixel clip, is version 2, and changes nothing the second time", async () => {
    const offset = fc.oneof(
      fc.record({ x: fc.integer({ min: -20000, max: 20000 }), y: fc.integer({ min: -20000, max: 20000 }) }),
      fc.record({ frameX: fc.double({ min: -10, max: 10, noNaN: true }), frameY: fc.double({ min: -10, max: 10, noNaN: true }) }),
    );
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...Object.values(FRAMES)), fc.constantFrom(1 as const, 2 as const), fc.array(offset, { maxLength: 5 }),
      async (frame, version, offsets) => {
        const doc = timelineDoc(version, frame);
        offsets.forEach((value, index) => storeClip(doc, `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`, value));
        const shown = readTimelineDocument(doc).clips;

        await convert(doc);
        const once = Y.encodeStateAsUpdate(doc);

        expect(readTimelineDocument(doc).clips).toEqual(shown);
        expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
        doc.getMap("clips").forEach((record) => {
          expect(Object.keys((record as Y.Map<unknown>).get("transform") as object).sort()).toEqual(["frameX", "frameY", "rotation", "scaleX", "scaleY"]);
        });
        expect(await convert(doc)).toBe(0);
        expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
      },
    ));
  });
});
