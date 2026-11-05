// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeding and reading the Timeline document (inner#1707, inner#1708 F1b). Editing lives in web; these tests write
 * records directly, as a collaborator's update would.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import * as spaceContent from "../../space-content.js";
import { initializeTimelineDocument, readTimelineContent, readTimelineDocument, readTimelineSource } from "../document.js";
import { TimelineDocumentV1Schema } from "../schema.js";

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
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
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
  it("seeds a complete V1 with a single stable visual track", () => {
    const doc = seededDoc();
    expect(readTimelineDocument(doc)).toEqual({
      schemaVersion: 1,
      settings,
      tracks: { "visual-1": { id: "visual-1", kind: "visual", order: 0 } },
      clips: {},
      sources: {},
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
    unsupported.getMap("timeline").set("schemaVersion", 2);
    const unsupportedBytes = Y.encodeStateAsUpdate(unsupported);
    expect(() => readTimelineDocument(unsupported)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(unsupported)).toEqual(unsupportedBytes);
  });

  it("requires a strict integer-frame DTO rather than a third-party or URL-bearing source", () => {
    const doc = seededDoc();
    attachClip(doc);
    const value = readTimelineDocument(doc);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
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
    unsupported.getMap("timeline").set("schemaVersion", 2);
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
