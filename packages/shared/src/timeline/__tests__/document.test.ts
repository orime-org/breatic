// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { applyTimelineEdit, initializeTimelineDocument, prepareTimelineEdit, readTimelineDocument } from "../document.js";
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
const add = {
  operation: "add_video" as const,
  parameters: { source, clip },
};
const docs: Y.Doc[] = [];

/**
 * Keep each real Yjs document available for deterministic cleanup.
 * @returns A new document, optionally loaded from an encoded snapshot.
 * @throws {Error} When the supplied Yjs update cannot be decoded.
 */
function trackedDoc(update?: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (update !== undefined) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Create the server-owned initial Timeline state for an editing test.
 * @returns The seeded document.
 * @throws {Error} When the initial state cannot be constructed.
 */
function seededDoc(): Y.Doc {
  const doc = trackedDoc();
  initializeTimelineDocument(doc, settings);
  return doc;
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
    applyTimelineEdit(doc, add);
    const value = readTimelineDocument(doc);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, settings: { ...settings, fps: { num: 24, den: 0 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, clips: { [clip.id]: { ...clip, startFrame: 0.5 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, sources: { [source.id]: { ...source, fileUrl: "https://example.com/video.mp4" } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, vendorTimeline: {} }).success).toBe(false);
  });

  it("preserves existing content and non-empty delete sets when initialization is attempted", () => {
    const existing = seededDoc();
    applyTimelineEdit(existing, add);
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

describe("Timeline native edit transactions", () => {
  it("prepares a valid edit without writing source or layout", () => {
    const doc = seededDoc();
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepareTimelineEdit(doc, add)).toEqual({ clipId: clip.id, clip, source });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
  });

  it("writes the source and attached clip in one transaction", () => {
    const doc = seededDoc();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshots: ReturnType<typeof readTimelineDocument>[] = [];
    doc.on("afterTransaction", () => snapshots.push(readTimelineDocument(doc)));
    expect(applyTimelineEdit(doc, add)).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      clips: { [clip.id]: clip },
      sources: { [source.id]: source },
    });
    expect(doc.getMap("clips").get(clip.id)).toBeInstanceOf(Y.Map);
    expect(warn.mock.calls.filter((args) => args.some((arg) => String(arg).includes("Invalid access")))).toEqual([]);
  });

  it("reopens the exact document parameters, source and placement", () => {
    const doc = seededDoc();
    applyTimelineEdit(doc, add);
    const reopened = trackedDoc(Y.encodeStateAsUpdate(doc));
    expect(readTimelineDocument(reopened)).toEqual(readTimelineDocument(doc));
    expect(readTimelineDocument(reopened).settings).toEqual(settings);
    expect(readTimelineDocument(reopened).clips[clip.id]).toEqual(clip);
  });

  it("changes only the current clip start while preserving its source", () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add)).toBe(true);
    const command = {
      operation: "set_start" as const,
      parameters: { clipId: clip.id, startFrame: 144 },
    };
    expect(applyTimelineEdit(doc, command)).toBe(true);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual({ ...clip, startFrame: 144 });
    expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
  });

  it("keeps stored source and clip snapshots unchanged when callers mutate their command inputs", () => {
    const doc = seededDoc();
    const command = structuredClone(add);
    expect(applyTimelineEdit(doc, command)).toBe(true);
    const before = Y.encodeStateAsUpdate(doc);
    for (const mutate of [
      () => Reflect.set(command.parameters.source, "durationSeconds", "9"),
      () => Reflect.set(command.parameters.clip, "startFrame", 144),
      () => Reflect.set(command.parameters.clip.transform, "x", 17),
    ]) {
      try {
        mutate();
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).sources[source.id]).toEqual(source);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual(clip);
  });

  it("refuses an overlapping addition without changing document bytes or its occupied clip", () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add)).toBe(true);
    const nextSource = { ...source, id: "10000000-0000-4000-8000-000000000002" };
    const nextClip = { ...clip, id: "30000000-0000-4000-8000-000000000002", sourceId: nextSource.id, startFrame: 24 };
    const command = {
      operation: "add_video" as const,
      parameters: { source: nextSource, clip: nextClip },
    };
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepareTimelineEdit(doc, command)).toEqual({ clipId: nextClip.id, reason: "overlap" });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(applyTimelineEdit(doc, command)).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({ [clip.id]: clip });
    expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
  });

  it("refuses a missing target without writing and can edit it once the clip exists", () => {
    const doc = seededDoc();
    const missing = {
      operation: "set_start" as const,
      parameters: { clipId: clip.id, startFrame: 144 },
    };
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepareTimelineEdit(doc, missing)).toEqual({ clipId: clip.id, reason: "target_missing" });
    expect(applyTimelineEdit(doc, missing)).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
    expect(applyTimelineEdit(doc, add)).toBe(true);
    expect(applyTimelineEdit(doc, missing)).toBe(true);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual({ ...clip, startFrame: 144 });
  });

  it("refuses an addition whose clip identity already exists without replacing its layout or source", () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add)).toBe(true);
    const nextSource = { ...source, id: "10000000-0000-4000-8000-000000000002" };
    const reused = { operation: "add_video" as const, parameters: {
      source: nextSource, clip: { ...clip, sourceId: nextSource.id, startFrame: 144 },
    } };
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepareTimelineEdit(doc, reused)).toEqual({ clipId: clip.id, reason: "target_missing" });
    expect(applyTimelineEdit(doc, reused)).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({ [clip.id]: clip });
    expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
  });

  it.each([
    { sourceInFrame: 1 },
    { durationFrames: 49 },
    { startFrame: Number.MAX_SAFE_INTEGER },
  ])("refuses a semantically invalid range without writing: %s", (changedFields) => {
    const doc = seededDoc();
    const command = { operation: "add_video" as const, parameters: { source, clip: { ...clip, ...changedFields } } };
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepareTimelineEdit(doc, command)).toEqual({ clipId: clip.id, reason: "invalid_range" });
    expect(applyTimelineEdit(doc, command)).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
  });

  it("keeps independent fields of a nested clip when clients merge", () => {
    const base = seededDoc();
    applyTimelineEdit(base, add);
    const bytes = Y.encodeStateAsUpdate(base);
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    applyTimelineEdit(first, {
      operation: "set_start",
      parameters: { clipId: clip.id, startFrame: 96 },
    });
    const secondClip = second.getMap<Y.Map<unknown>>("clips").get(clip.id);
    if (secondClip === undefined) throw new Error("The fixture clip is missing");
    secondClip.set("gain", 0.5);
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    expect(readTimelineDocument(first).clips[clip.id]).toEqual({ ...clip, startFrame: 96, gain: 0.5 });
  });

  it("refuses repeated additions of the same clip identity without changing accepted bytes", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 10000 }), (count, startFrame) => {
      const doc = seededDoc();
      const command = { ...add, parameters: { source, clip: { ...clip, startFrame } } };
      expect(applyTimelineEdit(doc, command)).toBe(true);
      const bytes = Y.encodeStateAsUpdate(doc);
      for (let attempt = 0; attempt < count; attempt += 1) expect(applyTimelineEdit(doc, command)).toBe(false);
      expect(Object.keys(readTimelineDocument(doc).clips)).toEqual([clip.id]);
      expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    }));
  });

  it("preserves both locally accepted clips and sources in either merge order", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), (startFrame) => {
      const initial = Y.encodeStateAsUpdate(seededDoc());
      const first = trackedDoc(initial);
      const second = trackedDoc(initial);
      const secondSource = { ...source, id: "10000000-0000-4000-8000-000000000002" };
      const secondClip = { ...clip, id: "30000000-0000-4000-8000-000000000002", sourceId: secondSource.id, startFrame };
      applyTimelineEdit(first, { ...add, parameters: { source, clip: { ...clip, startFrame } } });
      applyTimelineEdit(second, { operation: "add_video", parameters: { source: secondSource, clip: secondClip } });
      const firstBytes = Y.encodeStateAsUpdate(first);
      const secondBytes = Y.encodeStateAsUpdate(second);
      Y.applyUpdate(first, secondBytes);
      Y.applyUpdate(second, firstBytes);
      expect(readTimelineDocument(first)).toEqual(readTimelineDocument(second));
      expect(readTimelineDocument(first).clips).toEqual({ [clip.id]: { ...clip, startFrame }, [secondClip.id]: secondClip });
      expect(readTimelineDocument(first).sources).toEqual({ [source.id]: source, [secondSource.id]: secondSource });
      expect(TimelineDocumentV1Schema.safeParse(readTimelineDocument(first)).success).toBe(true);
    }));
  });
});
