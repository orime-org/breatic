// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Seeding and reading the Timeline document (inner#1707, inner#1708 F1b). Editing lives in web; these tests write
 * records directly, as a collaborator's update would.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import * as spaceContent from "../../space-content.js";
import {
  initializeTimelineDocument, readTimelineContent, readTimelineDocument, readTimelineSource, timelineDocumentNeedsUpgrade,
  upgradeTimelineDocument,
} from "../document.js";
import { TimelineClipSchema, TimelineDocumentV1Schema } from "../schema.js";

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const source = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "video" as const,
  assetId: "20000000-0000-4000-8000-000000000001",
  timebase: settings.fps,
  extentFrames: 48,
  durationSeconds: "2",
  durationOrigin: "registered" as const,
};
const clip = {
  id: "30000000-0000-4000-8000-000000000001",
  trackId: "visual-1",
  kind: "video" as const,
  sourceId: source.id,
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 48,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const docs: Y.Doc[] = [];

/**
 * Keep each real Yjs document available for deterministic cleanup.
 * @param update - An encoded snapshot to load, if any.
 * @returns A new document.
 * @throws {Error} When the supplied Yjs update cannot be decoded.
 */
function trackedDoc(update?: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (update !== undefined) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Create the server-owned initial Timeline state.
 * @returns The seeded document.
 * @throws {Error} When the initial state cannot be constructed.
 */
function seededDoc(): Y.Doc {
  const doc = trackedDoc();
  initializeTimelineDocument(doc, settings);
  return doc;
}

/**
 * Write the fixture source and an attached clip record directly, as an accepted addition leaves them.
 * @param doc - A seeded document.
 * @throws {Error} When Yjs cannot attach the map.
 */
function attachClip(doc: Y.Doc): void {
  doc.transact(() => {
    doc.getMap("sources").set(source.id, source);
    const record = new Y.Map<unknown>();
    doc.getMap("clips").set(clip.id, record);
    for (const [key, value] of Object.entries(clip)) record.set(key, value);
  }, "peer");
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.restoreAllMocks();
});

describe("Timeline document ownership and schema", () => {
  it("seeds a complete version 2 document with a single stable visual track (#1502 design §5)", () => {
    const doc = seededDoc();
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(readTimelineDocument(doc)).toEqual({
      schemaVersion: 2,
      settings,
      tracks: { "visual-1": { id: "visual-1", kind: "visual", order: 0 } },
      clips: {},
      sources: {},
      operationReceipts: {},
    });
    expect([...doc.share.keys()].sort()).toEqual(["clips", "sources", "timeline", "tracks"]);
    expect(doc.getMap("tracks").get("visual-1")).toBeInstanceOf(Y.Map);
    expect(TimelineDocumentV1Schema.parse(readTimelineDocument(doc))).toEqual(readTimelineDocument(doc));
  });

  it("reads the same persisted initial state in two independent clients", () => {
    const server = seededDoc();
    const bytes = Y.encodeStateAsUpdate(server);
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    expect(readTimelineDocument(first)).toEqual(readTimelineDocument(second));
    expect(Y.encodeStateAsUpdate(first)).toEqual(bytes);
    expect(Y.encodeStateAsUpdate(second)).toEqual(bytes);
  });

  it("does not manufacture an initial document while reading empty or unsupported content", () => {
    const empty = trackedDoc();
    const emptyBytes = Y.encodeStateAsUpdate(empty);
    expect(() => readTimelineDocument(empty)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(empty)).toEqual(emptyBytes);
    const unsupported = seededDoc();
    unsupported.getMap("timeline").set("schemaVersion", 3);
    const unsupportedBytes = Y.encodeStateAsUpdate(unsupported);
    expect(() => readTimelineDocument(unsupported)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(unsupported)).toEqual(unsupportedBytes);
  });

  it("requires a strict integer-frame DTO rather than a third-party or URL-bearing source", () => {
    const doc = seededDoc();
    attachClip(doc);
    const value = readTimelineDocument(doc);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, schemaVersion: 3 }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, settings: { ...settings, fps: { num: 24, den: 0 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, clips: { [clip.id]: { ...clip, startFrame: 0.5 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, sources: { [source.id]: { ...source, fileUrl: "https://example.com/video.mp4" } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, vendorTimeline: {} }).success).toBe(false);
  });

  it("preserves existing content and non-empty delete sets when initialization is attempted", () => {
    const existing = seededDoc();
    attachClip(existing);
    const unknown = trackedDoc();
    unknown.getMap("legacy").set("retained", "original content");
    const deleted = trackedDoc();
    deleted.getMap("legacy").set("removed", "original content");
    deleted.getMap("legacy").delete("removed");
    expect(deleted.getMap("legacy").size).toBe(0);
    expect(Y.decodeUpdate(Y.encodeStateAsUpdate(deleted)).ds.clients.size).toBe(1);
    for (const doc of [existing, unknown, deleted]) {
      const before = Y.encodeStateAsUpdate(doc);
      try {
        initializeTimelineDocument(doc, { width: 1280, height: 720, fps: { num: 30, den: 1 } });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    expect(readTimelineDocument(existing).settings).toEqual(settings);
    expect(readTimelineDocument(existing).clips[clip.id]).toEqual(clip);
    expect(unknown.getMap("legacy").get("retained")).toBe("original content");
  });

  it("rejects invalid settings before writing any part of the initial state", () => {
    const doc = trackedDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    expect(() => initializeTimelineDocument(doc, { ...settings, fps: { num: 24, den: 0 } })).toThrow(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
  });

  it("does not seed a document holding only a pending delete set and no structs", () => {
    const origin = trackedDoc();
    origin.getMap("legacy").set("removed", "retained deletion");
    const knownStructs = Y.encodeStateVector(origin);
    origin.getMap("legacy").delete("removed");
    const deletionOnly = Y.encodeStateAsUpdate(origin, knownStructs);
    expect(Y.decodeUpdate(deletionOnly).structs).toEqual([]);
    expect(Y.decodeUpdate(deletionOnly).ds.clients.size).toBe(1);
    const receiver = trackedDoc();
    Y.applyUpdate(receiver, deletionOnly);
    const before = Y.encodeStateAsUpdate(receiver);
    expect(Y.decodeUpdate(before).structs).toEqual([]);
    expect(Y.decodeUpdate(before).ds.clients.size).toBe(1);
    expect([...receiver.share.keys()]).toEqual([]);
    try {
      initializeTimelineDocument(receiver, settings);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(Y.encodeStateAsUpdate(receiver)).toEqual(before);
    expect([...receiver.share.keys()]).toEqual([]);
  });
});

describe("Timeline content with damaged records (inner#1708 F1b)", () => {
  const BAD_CLIP = "30000000-0000-4000-8000-0000000000bd";
  const BAD_TRACK = "track-damaged";

  /**
   * A document holding one valid clip, a clip record missing most fields and a track record missing its kind.
   * @returns The document.
   * @throws {Error} When seeding fails.
   */
  function damagedDoc(): Y.Doc {
    const doc = seededDoc();
    attachClip(doc);
    doc.transact(() => {
      const partialClip = new Y.Map<unknown>();
      doc.getMap("clips").set(BAD_CLIP, partialClip);
      partialClip.set("startFrame", 100);
      const partialTrack = new Y.Map<unknown>();
      doc.getMap("tracks").set(BAD_TRACK, partialTrack);
      partialTrack.set("order", 3);
    }, "peer");
    return doc;
  }

  it("reads every valid record and lists the damaged ones", () => {
    const doc = damagedDoc();
    const content = readTimelineContent(doc);
    expect(content.document.clips).toEqual({ [clip.id]: clip });
    expect(content.document.tracks).toEqual({ "visual-1": { id: "visual-1", kind: "visual", order: 0 } });
    expect(content.document.sources).toEqual({ [source.id]: source });
    // A damaged track record is left out of the document but not listed (inner#1708 Q3).
    expect(content.damaged).toEqual({ clips: [BAD_CLIP] });
  });

  it("reads the same valid document through readTimelineDocument without throwing", () => {
    const doc = damagedDoc();
    expect(() => readTimelineDocument(doc)).not.toThrow();
    expect(readTimelineDocument(doc)).toEqual(readTimelineContent(doc).document);
  });

  it("reports nothing damaged for intact content", () => {
    const doc = seededDoc();
    attachClip(doc);
    expect(readTimelineContent(doc)).toEqual({ document: readTimelineDocument(doc), damaged: { clips: [] } });
  });

  it("still refuses missing and unsupported Timeline roots", () => {
    expect(typeof readTimelineContent).toBe("function");
    expect(() => readTimelineContent(trackedDoc())).toThrow(Error);
    const unsupported = seededDoc();
    unsupported.getMap("timeline").set("schemaVersion", 3);
    expect(() => readTimelineContent(unsupported)).toThrow(Error);
  });
});

describe("Timeline sources read one by one (inner#1708 F1)", () => {
  const OTHER_ID = "10000000-0000-4000-8000-0000000000bb";
  const MAP_ID = "10000000-0000-4000-8000-0000000000cc";

  /**
   * Store a value under a key of the sources map.
   * @param doc - The document.
   * @param key - The map key.
   * @param value - The stored value.
   * @throws {Error} When Yjs refuses the value.
   */
  function store(doc: Y.Doc, key: string, value: unknown): void {
    doc.transact(() => doc.getMap("sources").set(key, value), "peer");
  }

  /**
   * Store a source as a Y.Map holding its fields.
   * @param doc - The document.
   * @param value - The source.
   * @param value.id - Its key.
   * @returns The attached map.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function storeAsMap(doc: Y.Doc, value: { id: string }): Y.Map<unknown> {
    const record = new Y.Map<unknown>();
    doc.transact(() => {
      doc.getMap("sources").set(value.id, record);
      for (const [key, field] of Object.entries(value)) record.set(key, field);
    }, "peer");
    return record;
  }

  it("reads a valid plain source stored under its own id", () => {
    expect(readTimelineSource(source, source.id)).toEqual(source);
  });

  it("reads a valid source stored as a Y.Map", () => {
    const doc = seededDoc();
    expect(readTimelineSource(storeAsMap(doc, { ...source, id: MAP_ID }), MAP_ID)).toEqual({ ...source, id: MAP_ID });
  });

  it.each([
    ["a number", 42],
    ["a record missing fields", { id: source.id, kind: "video" }],
    ["null", null],
    ["a string", "https://cdn.example/video.mp4"],
  ])("reads %s as no source", (_name, value) => {
    expect(readTimelineSource(value, source.id)).toBe(undefined);
  });

  it("reads a valid source stored under another key as no source", () => {
    expect(readTimelineSource({ ...source, id: OTHER_ID }, source.id)).toBe(undefined);
  });

  it("is exported from the space-content entry", () => {
    expect(typeof spaceContent.readTimelineSource).toBe("function");
    expect(spaceContent.readTimelineSource).toBe(readTimelineSource);
  });

  it("leaves out unreadable sources and keeps the readable ones, without throwing", () => {
    const doc = seededDoc();
    attachClip(doc);
    store(doc, "10000000-0000-4000-8000-0000000000a1", 42);
    store(doc, "10000000-0000-4000-8000-0000000000a2", { id: "10000000-0000-4000-8000-0000000000a2", kind: "video" });
    store(doc, "10000000-0000-4000-8000-0000000000a3", { ...source, id: OTHER_ID });
    storeAsMap(doc, { ...source, id: MAP_ID });
    expect(() => readTimelineContent(doc)).not.toThrow();
    expect(readTimelineContent(doc).document.sources).toEqual({ [source.id]: source, [MAP_ID]: { ...source, id: MAP_ID } });
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual(clip);
  });
});

describe("Timeline records stored under a key other than their id (inner#1708 Q1)", () => {
  const OTHER_KEY = "30000000-0000-4000-8000-0000000000ee";

  /**
   * Attach a record map under a key, with the given fields.
   * @param doc - The document.
   * @param map - The collection.
   * @param key - The map key.
   * @param fields - The record.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function attachUnder(doc: Y.Doc, map: "clips" | "tracks", key: string, fields: object): void {
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap(map).set(key, record);
      for (const [name, value] of Object.entries(fields)) record.set(name, value);
    }, "peer");
  }

  it("leaves a clip stored under another key out of the clips and lists it as damaged", () => {
    const doc = seededDoc();
    attachClip(doc);
    attachUnder(doc, "clips", OTHER_KEY, { ...clip, id: "30000000-0000-4000-8000-0000000000ef", startFrame: 100 });
    const content = readTimelineContent(doc);
    expect(content.document.clips).toEqual({ [clip.id]: clip });
    expect(content.damaged).toEqual({ clips: [OTHER_KEY] });
  });

  it("leaves a track stored under another key out of the tracks without listing it", () => {
    const doc = seededDoc();
    attachUnder(doc, "tracks", "track-key", { id: "track-other", kind: "visual", order: 1 });
    const content = readTimelineContent(doc);
    expect(content.document.tracks).toEqual({ "visual-1": { id: "visual-1", kind: "visual", order: 0 } });
    expect(content.damaged).toEqual({ clips: [] });
  });
});

describe("timelineRecordJson reads one stored Timeline value as JSON (inner#1708 Q1)", () => {
  /**
   * The export under test, read from a module namespace so a missing export fails as an assertion.
   * @param module - The module namespace.
   * @returns The function.
   * @throws {Error} When it is not exported.
   */
  function exported(module: object): (value: unknown) => unknown {
    const value: unknown = (module as Record<string, unknown>).timelineRecordJson;
    if (typeof value !== "function") throw new Error("timelineRecordJson is not exported");
    return value as (value: unknown) => unknown;
  }

  it("is exported from the document module and @breatic/shared/space-content as the same function", async () => {
    const documentModule = await import("../document.js");
    expect(exported(spaceContent)).toBe(exported(documentModule));
  });

  it("returns toJSON() for a Y.Map, a Y.Text and a Y.Array, and anything else unchanged", async () => {
    const read = exported(await import("../document.js"));
    const doc = trackedDoc();
    const map = doc.getMap("probe");
    const record = new Y.Map<unknown>();
    map.set("record", record);
    record.set("a", 1);
    const text = new Y.Text();
    map.set("text", text);
    text.insert(0, "hello");
    const list = new Y.Array<unknown>();
    map.set("list", list);
    list.push([1, "two"]);
    expect(read(record)).toEqual({ a: 1 });
    expect(read(text)).toBe("hello");
    expect(read(list)).toEqual([1, "two"]);
    const plain = { a: 1 };
    expect(read(plain)).toBe(plain);
    for (const value of [42, "s", null, undefined, true]) expect(read(value)).toBe(value);
  });

  it("reads a clip whose sourceId is a Y.Text as a valid clip", () => {
    const doc = seededDoc();
    doc.transact(() => {
      doc.getMap("sources").set(source.id, source);
      const record = new Y.Map<unknown>();
      doc.getMap("clips").set(clip.id, record);
      for (const [key, value] of Object.entries(clip)) if (key !== "sourceId") record.set(key, value);
      const text = new Y.Text();
      record.set("sourceId", text);
      text.insert(0, source.id);
    }, "peer");
    expect(readTimelineContent(doc)).toEqual({ document: expect.objectContaining({ clips: { [clip.id]: clip } }), damaged: { clips: [] } });
  });
});

/** The preset sizes of #1502 design §2, written out so this file does not depend on the preset module. */
const FRAMES = {
  "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 }, "4:5": { width: 1080, height: 1350 }, "2:3": { width: 1080, height: 1620 },
  "21:9": { width: 2520, height: 1080 },
} as const;

/** A clip id other than the fixture's. */
const SECOND_CLIP = "30000000-0000-4000-8000-000000000002";

/**
 * Store a clip record whose transform is in the given stored format, as a peer's update would.
 * @param doc - A seeded document.
 * @param id - The clip id.
 * @param transform - The stored transform, pixel (`x`, `y`) or fraction (`frameX`, `frameY`) format.
 * @returns The attached record map.
 * @throws {Error} When Yjs cannot attach the map.
 */
function storeClip(doc: Y.Doc, id: string, transform: Record<string, number>): Y.Map<unknown> {
  const record = new Y.Map<unknown>();
  doc.transact(() => {
    doc.getMap("sources").set(source.id, source);
    doc.getMap("clips").set(id, record);
    for (const [key, value] of Object.entries({ ...clip, id, transform })) record.set(key, value);
  }, "peer");
  return record;
}

/**
 * A seeded document stored as version 1, the format written before #1502, under the given frame size.
 * @param frame - The stored frame size.
 * @param frame.width - Frame width.
 * @param frame.height - Frame height.
 * @returns The document.
 * @throws {Error} When seeding fails.
 */
function versionOneDoc(frame: { width: number; height: number } = settings): Y.Doc {
  const doc = trackedDoc();
  initializeTimelineDocument(doc, { ...settings, ...frame });
  doc.getMap("timeline").set("schemaVersion", 1);
  return doc;
}

const PIXEL_SCALE = { scaleX: 0.5, scaleY: 2, rotation: 30 };

describe("Clip transforms are stored as frame offsets (#1502 design §4)", () => {
  it("accepts a clip whose transform carries frameX and frameY", () => {
    expect(TimelineClipSchema.safeParse({ ...clip, transform: { frameX: 0.35, frameY: -0.35, ...PIXEL_SCALE } }).success).toBe(true);
  });

  it("refuses a clip whose transform carries the pixel x and y, the format before #1502", () => {
    expect(TimelineClipSchema.safeParse({ ...clip, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } }).success).toBe(false);
  });
});

describe("Reading version 1 and version 2 documents and pixel-format clips (#1502 design §5)", () => {
  it("reads a version 1 document, turning a pixel clip into a frame offset of the current frame", () => {
    const doc = versionOneDoc();
    storeClip(doc, clip.id, { x: 192, y: -108, ...PIXEL_SCALE });
    const content = readTimelineContent(doc);
    expect(content.document.clips[clip.id]!.transform).toEqual({ frameX: 0.1, frameY: -0.1, ...PIXEL_SCALE });
    expect(content.damaged).toEqual({ clips: [] });
  });

  it("divides by the stored frame's own width and height, here a 9:16 frame", () => {
    const doc = versionOneDoc(FRAMES["9:16"]);
    storeClip(doc, clip.id, { x: 108, y: -192, ...PIXEL_SCALE });
    expect(readTimelineDocument(doc).clips[clip.id]!.transform).toEqual({ frameX: 0.1, frameY: -0.1, ...PIXEL_SCALE });
  });

  it("reads a version 2 document holding both pixel and fraction clips, returning every clip as a frame offset", () => {
    const doc = seededDoc();
    storeClip(doc, clip.id, { x: 480, y: 270, ...PIXEL_SCALE });
    storeClip(doc, SECOND_CLIP, { frameX: 0.35, frameY: -0.35, ...PIXEL_SCALE });
    const clips = readTimelineDocument(doc).clips;
    expect(clips[clip.id]!.transform).toEqual({ frameX: 0.25, frameY: 0.25, ...PIXEL_SCALE });
    expect(clips[SECOND_CLIP]!.transform).toEqual({ frameX: 0.35, frameY: -0.35, ...PIXEL_SCALE });
    for (const read of Object.values(clips)) expect(Object.keys(read.transform).sort()).toEqual(["frameX", "frameY", "rotation", "scaleX", "scaleY"]);
  });

  it("reads a fraction clip stored in a version 1 document", () => {
    const doc = versionOneDoc();
    storeClip(doc, clip.id, { frameX: 0.2, frameY: 0.1, ...PIXEL_SCALE });
    expect(readTimelineDocument(doc).clips[clip.id]!.transform).toEqual({ frameX: 0.2, frameY: 0.1, ...PIXEL_SCALE });
  });

  it("reads a transform carrying both frame and pixel fields by its frame fields", () => {
    const doc = seededDoc();
    storeClip(doc, clip.id, { frameX: 0.2, frameY: 0.1, x: 960, y: 540, ...PIXEL_SCALE });
    expect(readTimelineDocument(doc).clips[clip.id]!.transform).toEqual({ frameX: 0.2, frameY: 0.1, ...PIXEL_SCALE });
  });

  it("writes nothing while reading pixel clips", () => {
    const doc = versionOneDoc();
    storeClip(doc, clip.id, { x: 192, y: -108, ...PIXEL_SCALE });
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    readTimelineContent(doc);
    expect(updates).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(1);
  });

  it("reads any whole-pixel offset within ten frame sizes as that offset divided by the frame size, in any preset", () => {
    fc.assert(fc.property(
      fc.constantFrom(...Object.values(FRAMES)), fc.integer({ min: -10, max: 10 }), fc.integer({ min: -10, max: 10 }),
      fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.constantFrom(1, 2),
      (frame, wholeX, wholeY, partX, partY, version) => {
        const x = Math.round((wholeX + partX) * frame.width);
        const y = Math.round((wholeY + partY) * frame.height);
        const doc = versionOneDoc(frame);
        doc.getMap("timeline").set("schemaVersion", version);
        storeClip(doc, clip.id, { x, y, ...PIXEL_SCALE });
        const read = readTimelineDocument(doc).clips[clip.id]!.transform;
        return Math.abs(read.frameX * frame.width - x) <= 1e-6 && Math.abs(read.frameY * frame.height - y) <= 1e-6
          && read.scaleX === PIXEL_SCALE.scaleX && read.scaleY === PIXEL_SCALE.scaleY && read.rotation === PIXEL_SCALE.rotation;
      },
    ));
  });
});

describe("upgradeTimelineDocument: storing pixel clips as frame offsets (#1502 design §5)", () => {
  it("is exported from @breatic/shared/space-content with its check", () => {
    expect(spaceContent.upgradeTimelineDocument).toBe(upgradeTimelineDocument);
    expect(spaceContent.timelineDocumentNeedsUpgrade).toBe(timelineDocumentNeedsUpgrade);
  });

  it("finds an upgrade needed for a version 1 document, or for any document holding a pixel clip, and none otherwise", () => {
    expect(timelineDocumentNeedsUpgrade(versionOneDoc())).toBe(true);
    const latePixel = seededDoc();
    storeClip(latePixel, clip.id, { x: 10, y: 10, ...PIXEL_SCALE });
    expect(timelineDocumentNeedsUpgrade(latePixel)).toBe(true);
    const current = seededDoc();
    storeClip(current, clip.id, { frameX: 0.1, frameY: 0.1, ...PIXEL_SCALE });
    expect(timelineDocumentNeedsUpgrade(current)).toBe(false);
  });

  it("finds no upgrade needed for a document that holds no Timeline content", () => {
    expect(timelineDocumentNeedsUpgrade(trackedDoc())).toBe(false);
  });

  it("writes version 2 to a version 1 document that holds no pixel clip, in one update", () => {
    const doc = versionOneDoc();
    const updates = vi.fn();
    doc.on("update", updates);
    expect(upgradeTimelineDocument(doc)).toBe(0);
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it("writes nothing to a version 2 document that holds no pixel clip", () => {
    const doc = seededDoc();
    storeClip(doc, clip.id, { frameX: 0.1, frameY: 0.1, ...PIXEL_SCALE });
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    expect(upgradeTimelineDocument(doc)).toBe(0);
    expect(updates).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("stores each pixel clip as a frame offset of the current frame, in place, and leaves fraction clips alone", () => {
    const doc = versionOneDoc(FRAMES["9:16"]);
    const pixel = storeClip(doc, clip.id, { x: 108, y: -192, ...PIXEL_SCALE });
    storeClip(doc, SECOND_CLIP, { frameX: 0.35, frameY: -0.35, ...PIXEL_SCALE });
    const updates = vi.fn();
    doc.on("update", updates);
    expect(upgradeTimelineDocument(doc)).toBe(1);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
    expect(doc.getMap("clips").get(clip.id)).toBe(pixel);
    expect(pixel.get("transform")).toEqual({ frameX: 0.1, frameY: -0.1, ...PIXEL_SCALE });
    expect((doc.getMap("clips").get(SECOND_CLIP) as Y.Map<unknown>).get("transform")).toEqual({ frameX: 0.35, frameY: -0.35, ...PIXEL_SCALE });
    expect(timelineDocumentNeedsUpgrade(doc)).toBe(false);
  });

  it("writes under the transaction origin of the caller that wraps it", () => {
    const doc = versionOneDoc();
    storeClip(doc, clip.id, { x: 192, y: -108, ...PIXEL_SCALE });
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
    doc.transact(() => upgradeTimelineDocument(doc), "timeline-format");
    expect(origins).toEqual(["timeline-format"]);
  });

  it("moves no layer and changes nothing the second time, for any mix of clips, versions and presets", () => {
    const transform = fc.oneof(
      fc.record({ x: fc.integer({ min: -20000, max: 20000 }), y: fc.integer({ min: -20000, max: 20000 }) }),
      fc.record({ frameX: fc.double({ min: -10, max: 10, noNaN: true }), frameY: fc.double({ min: -10, max: 10, noNaN: true }) }),
    );
    fc.assert(fc.property(
      fc.constantFrom(...Object.values(FRAMES)), fc.constantFrom(1, 2), fc.array(transform, { maxLength: 5 }),
      (frame, version, transforms) => {
        const doc = versionOneDoc(frame);
        doc.getMap("timeline").set("schemaVersion", version);
        transforms.forEach((offset, index) => storeClip(doc, `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`, { ...offset, ...PIXEL_SCALE }));
        const shown = readTimelineDocument(doc).clips;
        upgradeTimelineDocument(doc);
        const once = Y.encodeStateAsUpdate(doc);
        expect(readTimelineDocument(doc).clips).toEqual(shown);
        expect(doc.getMap("timeline").get("schemaVersion")).toBe(2);
        expect(timelineDocumentNeedsUpgrade(doc)).toBe(false);
        expect(upgradeTimelineDocument(doc)).toBe(0);
        expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
      },
    ));
  });
});
