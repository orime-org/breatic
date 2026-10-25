// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { documentBodyFragment } from "../document-body.js";
import { readSpaceMediaReferences } from "../space-media-references.js";
import { initializeTimelineDocument } from "../timeline/document.js";
import { CANVAS_NODES_KEY } from "../types/canvas-node.js";

const docs: Y.Doc[] = [];
const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const sourceTemplate = {
  kind: "video",
  timebase: settings.fps,
  extentFrames: 48,
  durationSeconds: "2",
  durationOrigin: "registered",
};

/**
 * Track the real document used by a reference extraction test.
 * @returns An empty Yjs document.
 * @throws {never} Never.
 */
function trackedDoc(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

/**
 * Build the nested node/data maps that current Canvas writers use.
 * @returns The attached node data map.
 * @throws {Error} When the node cannot be attached to the document.
 */
function canvasNode(doc: Y.Doc, id: string, type: string, fields: Readonly<Record<string, unknown>>): Y.Map<unknown> {
  const node = new Y.Map<unknown>();
  doc.getMap(CANVAS_NODES_KEY).set(id, node);
  node.set("id", id);
  node.set("type", type);
  const position = new Y.Map<number>();
  node.set("position", position);
  position.set("x", 0);
  position.set("y", 0);
  const data = new Y.Map<unknown>();
  node.set("data", data);
  data.set("name", "Media fixture");
  data.set("createdAt", 1);
  data.set("createdBy", "60000000-0000-4000-8000-000000000001");
  data.set("locked", false);
  data.set("attachments", []);
  data.set("focusImages", new Y.Array<unknown>());
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/**
 * Attach a named XML element before adding its semantic attributes.
 * @returns The attached XML node.
 * @throws {Error} When the XML node cannot be attached.
 */
function appendElement(parent: Y.XmlFragment | Y.XmlElement, name: string, attrs: Readonly<Record<string, unknown>> = {}): Y.XmlElement {
  const element = new Y.XmlElement(name);
  parent.insert(parent.length, [element]);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value as never);
  return element;
}

/**
 * Store one accepted V1 source without depending on any clip placement.
 * @returns Nothing after the source has been attached.
 * @throws {Error} When the source cannot be attached.
 */
function timelineSource(doc: Y.Doc, id: string, assetId: string): void {
  doc.getMap("sources").set(id, { ...sourceTemplate, id, assetId });
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe("semantic Space media references", () => {
  it("reads empty Spaces without creating roots, emitting updates or seeding content", () => {
    for (const kind of ["canvas", "document", "timeline"] as const) {
      const doc = trackedDoc();
      const before = Y.encodeStateAsUpdate(doc);
      const changed = vi.fn();
      doc.on("update", changed);
      expect(readSpaceMediaReferences(kind, doc)).toEqual({ assetIds: [], urls: [] });
      expect([...doc.share.keys()]).toEqual([]);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
    }
  });

  it("reads physical image, audio, video and 3D content from their nested data maps", () => {
    const doc = trackedDoc();
    for (const [index, type] of ["image", "audio", "video", "3d"].entries()) {
      canvasNode(doc, `node-${index}`, type, { content: `https://cdn.example/${type}` });
    }
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({
      assetIds: [],
      urls: ["https://cdn.example/3d", "https://cdn.example/audio", "https://cdn.example/image", "https://cdn.example/video"],
    });
  });

  it("reads video posters without creating phantom image or audio poster references", () => {
    const doc = trackedDoc();
    canvasNode(doc, "video", "video", { coverUrl: "https://cdn.example/video-poster.png" });
    canvasNode(doc, "image", "image", { coverUrl: "https://cdn.example/phantom-image-poster.png" });
    canvasNode(doc, "audio", "audio", { coverUrl: "https://cdn.example/phantom-audio-poster.png" });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({ assetIds: [], urls: ["https://cdn.example/video-poster.png"] });
  });

  it("includes the stored scalar image slots and copied style images", () => {
    const doc = trackedDoc();
    canvasNode(doc, "video", "video", {
      firstFrameUrl: "https://cdn.example/first.png",
      endFrameUrl: "https://cdn.example/end.png",
      characterImageUrl: "https://cdn.example/character.png",
      styleImageUrls: ["https://cdn.example/style.png", "https://cdn.example/first.png"],
    });
    canvasNode(doc, "audio", "audio", { moodImageUrl: "https://cdn.example/mood.png" });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({
      assetIds: [],
      urls: ["https://cdn.example/character.png", "https://cdn.example/end.png", "https://cdn.example/first.png", "https://cdn.example/mood.png", "https://cdn.example/style.png"],
    });
  });

  it("includes video-slot resources and their stored posters", () => {
    const doc = trackedDoc();
    canvasNode(doc, "video", "video", {
      drivingVideo: { url: "https://cdn.example/driving.mp4", cover: "https://cdn.example/driving.png", duration: 2 },
      sourceVideo: { url: "https://cdn.example/source.mp4", cover: "https://cdn.example/source.png" },
    });
    canvasNode(doc, "audio", "audio", { soundVideo: { url: "https://cdn.example/sound.mp4", cover: "https://cdn.example/sound.png" } });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({
      assetIds: [],
      urls: ["https://cdn.example/driving.mp4", "https://cdn.example/driving.png", "https://cdn.example/sound.mp4", "https://cdn.example/sound.png", "https://cdn.example/source.mp4", "https://cdn.example/source.png"],
    });
  });

  it("includes the eight stored audio-slot resources", () => {
    const doc = trackedDoc();
    canvasNode(doc, "video", "video", {
      drivingAudio: { url: "https://cdn.example/driving.mp3" },
      leftAudio: { url: "https://cdn.example/left.mp3" },
      rightAudio: { url: "https://cdn.example/right.mp3" },
    });
    canvasNode(doc, "audio", "audio", {
      refAudio: { url: "https://cdn.example/ref.mp3" },
      musicSong: { url: "https://cdn.example/song.mp3" },
      coverSong: { url: "https://cdn.example/cover.mp3" },
      musicMelody: { url: "https://cdn.example/melody.mp3" },
      musicVocal: { url: "https://cdn.example/vocal.mp3" },
    });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({
      assetIds: [],
      urls: ["https://cdn.example/cover.mp3", "https://cdn.example/driving.mp3", "https://cdn.example/left.mp3", "https://cdn.example/melody.mp3", "https://cdn.example/ref.mp3", "https://cdn.example/right.mp3", "https://cdn.example/song.mp3", "https://cdn.example/vocal.mp3"],
    });
  });

  it("reads focus crop URLs in current Y.Array and retained plain-array encodings", () => {
    const doc = trackedDoc();
    const data = canvasNode(doc, "current", "image", {});
    const crops = data.get("focusImages");
    if (!(crops instanceof Y.Array)) throw new Error("The fixture crop container is missing");
    crops.push([{ id: "crop-a", url: "https://cdn.example/crop-a.png", name: "A", width: 20, height: 20 }]);
    canvasNode(doc, "retained", "video", { focusImages: [{ id: "crop-b", url: "https://cdn.example/crop-b.png", name: "B", width: 20, height: 20 }] });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({ assetIds: [], urls: ["https://cdn.example/crop-a.png", "https://cdn.example/crop-b.png"] });
  });

  it("reads uploaded attachments in both documented pool encodings", () => {
    const doc = trackedDoc();
    canvasNode(doc, "plain", "text", { attachments: [{ id: "file-a", url: "https://cdn.example/file-a.pdf", name: "A", mimeType: "application/pdf", size: 20, uploadedAt: "2026-10-24T00:00:00Z" }] });
    const data = canvasNode(doc, "pool", "video", {});
    const pool = new Y.Array<Y.Map<unknown>>();
    data.set("attachments", pool);
    const attachment = new Y.Map<unknown>();
    pool.push([attachment]);
    for (const [key, value] of Object.entries({ id: "file-b", url: "https://cdn.example/file-b.mp4", name: "B", mimeType: "video/mp4", size: 40, uploadedAt: "2026-10-24T00:00:00Z" })) attachment.set(key, value);
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({ assetIds: [], urls: ["https://cdn.example/file-a.pdf", "https://cdn.example/file-b.mp4"] });
  });

  it("does not scan text, iframe pages, prompts, arbitrary parameters or provider extras", () => {
    const doc = trackedDoc();
    canvasNode(doc, "text", "text", { content: "https://cdn.example/text.mp4", body: "https://cdn.example/body.mp4" });
    canvasNode(doc, "annotation", "annotation", { content: "https://cdn.example/sticky.mp4" });
    canvasNode(doc, "web", "web", { content: "https://cdn.example/page.html" });
    canvasNode(doc, "video", "video", {
      name: "https://cdn.example/name.mp4",
      prompt: "https://cdn.example/prompt.mp4",
      operationParams: { url: "https://cdn.example/parameter.mp4" },
      paramsByModel: { model: { url: "https://cdn.example/model-parameter.mp4" } },
      result_url: "https://cdn.example/result.mp4",
      extra: { audio_url: "https://cdn.example/extra.mp3" },
      metadata: { assetId: "20000000-0000-4000-8000-000000000001" },
    });
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({ assetIds: [], urls: [] });
  });

  it("skips unknown Canvas portions without losing readable media or rewriting the document", () => {
    const doc = trackedDoc();
    canvasNode(doc, "valid", "image", { content: "https://cdn.example/kept.png" });
    canvasNode(doc, "future", "unknown-node", { content: "https://cdn.example/future.png" });
    canvasNode(doc, "partial", "video", { content: null, coverUrl: 17, focusImages: [null, { name: "No URL" }] });
    doc.getMap(CANVAS_NODES_KEY).set("unknown-value", "https://cdn.example/not-a-node.png");
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSpaceMediaReferences("canvas", doc)).toEqual({ assetIds: [], urls: ["https://cdn.example/kept.png"] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reads image, audio and video URL attributes below nested block and table containers", () => {
    const doc = trackedDoc();
    const group = appendElement(documentBodyFragment(doc), "blockGroup");
    const first = appendElement(group, "blockContainer", { id: "image-block" });
    appendElement(first, "image", { url: "https://cdn.example/image.png" });
    const nested = appendElement(first, "blockGroup");
    appendElement(appendElement(nested, "blockContainer"), "audio", { url: "https://cdn.example/audio.mp3" });
    const table = appendElement(appendElement(group, "blockContainer"), "table");
    const cell = appendElement(appendElement(table, "tableRow"), "tableCell");
    appendElement(cell, "video", { url: "https://cdn.example/video.mp4" });
    expect(readSpaceMediaReferences("document", doc)).toEqual({ assetIds: [], urls: ["https://cdn.example/audio.mp3", "https://cdn.example/image.png", "https://cdn.example/video.mp4"] });
  });

  it("ignores body text, link marks, unrelated attributes and media outside the body fragment", () => {
    const doc = trackedDoc();
    const paragraph = appendElement(documentBodyFragment(doc), "paragraph", { url: "https://cdn.example/paragraph.mp4" });
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, "See https://cdn.example/words.mp4");
    text.format(0, text.length, { link: { href: "https://cdn.example/link.mp4" } });
    appendElement(paragraph, "link", { href: "https://cdn.example/element-link.mp4" });
    appendElement(doc.getXmlFragment("other-content"), "video", { url: "https://cdn.example/other-root.mp4" });
    doc.getMap("comments").set("comment", { url: "https://cdn.example/comment.mp4" });
    expect(readSpaceMediaReferences("document", doc)).toEqual({ assetIds: [], urls: [] });
  });

  it("leaves classification of explicit external or unknown media URLs to registered-asset resolution", () => {
    const doc = trackedDoc();
    const body = documentBodyFragment(doc);
    appendElement(body, "video", { url: "https://outside.example/video.mp4" });
    appendElement(body, "image", { url: "unregistered-media" });
    appendElement(body, "audio", { url: "" });
    appendElement(body, "image", { url: 42 });
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSpaceMediaReferences("document", doc)).toEqual({ assetIds: [], urls: ["https://outside.example/video.mp4", "unregistered-media"] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reads registered Timeline source asset ids even when their placements are absent", () => {
    const doc = trackedDoc();
    initializeTimelineDocument(doc, settings);
    const assetId = "20000000-0000-4000-8000-000000000001";
    timelineSource(doc, "10000000-0000-4000-8000-000000000001", assetId);
    timelineSource(doc, "10000000-0000-4000-8000-000000000002", assetId);
    doc.getMap("unrelatedMetadata").set("unrelated", { assetId: "20000000-0000-4000-8000-000000000002", url: "https://cdn.example/record-text.mp4" });
    doc.getMap("clips").set("unknown", { assetId: "20000000-0000-4000-8000-000000000003", content: "https://cdn.example/clip-text.mp4" });
    expect(readSpaceMediaReferences("timeline", doc)).toEqual({ assetIds: [assetId], urls: [] });
  });

  it("keeps readable V1 sources when another source entry is unknown", () => {
    const doc = trackedDoc();
    initializeTimelineDocument(doc, settings);
    const assetId = "20000000-0000-4000-8000-000000000001";
    timelineSource(doc, "10000000-0000-4000-8000-000000000001", assetId);
    doc.getMap("sources").set("unknown", { kind: "future-source", assetId: "20000000-0000-4000-8000-000000000002" });
    doc.getMap("sources").set("text", "https://cdn.example/not-a-source.mp4");
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSpaceMediaReferences("timeline", doc)).toEqual({ assetIds: [assetId], urls: [] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("does not infer source identities from an unsupported Timeline version", () => {
    const doc = trackedDoc();
    initializeTimelineDocument(doc, settings);
    timelineSource(doc, "10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001");
    doc.getMap("timeline").set("schemaVersion", 2);
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSpaceMediaReferences("timeline", doc)).toEqual({ assetIds: [], urls: [] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reads encoded snapshots after loading them into fresh documents", () => {
    for (const kind of ["canvas", "document", "timeline"] as const) {
      const original = trackedDoc();
      if (kind === "canvas") canvasNode(original, "video", "video", { content: "https://cdn.example/restored.mp4" });
      else if (kind === "document") appendElement(documentBodyFragment(original), "video", { url: "https://cdn.example/restored.mp4" });
      else {
        initializeTimelineDocument(original, settings);
        timelineSource(original, "10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001");
      }
      const bytes = Y.encodeStateAsUpdate(original);
      const reopened = trackedDoc();
      Y.applyUpdate(reopened, bytes);
      expect(readSpaceMediaReferences(kind, reopened)).toEqual(kind === "timeline"
        ? { assetIds: ["20000000-0000-4000-8000-000000000001"], urls: [] }
        : { assetIds: [], urls: ["https://cdn.example/restored.mp4"] });
      expect(Y.encodeStateAsUpdate(reopened)).toEqual(bytes);
    }
  });

  it("is read-only, deduplicated and repeatable for arbitrary references in each Space kind", () => {
    fc.assert(fc.property(
      fc.constantFrom("canvas" as const, "document" as const, "timeline" as const),
      fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 20 }),
      (kind, entries) => {
        const doc = trackedDoc();
        if (kind === "timeline") initializeTimelineDocument(doc, settings);
        for (const [index, value] of entries.entries()) {
          const url = `https://cdn.example/${value}.mp4`;
          if (kind === "canvas") canvasNode(doc, `node-${index}`, "video", { content: url });
          else if (kind === "document") appendElement(documentBodyFragment(doc), "video", { url });
          else timelineSource(doc, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
        }
        const unique = [...new Set(entries)].sort((left, right) => left - right);
        const expected = kind === "timeline"
          ? { assetIds: unique.map((value) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`), urls: [] }
          : { assetIds: [], urls: unique.map((value) => `https://cdn.example/${value}.mp4`) };
        const before = Y.encodeStateAsUpdate(doc);
        const roots = [...doc.share.keys()];
        const updates = vi.fn();
        doc.on("update", updates);
        expect(readSpaceMediaReferences(kind, doc)).toEqual(expected);
        expect(readSpaceMediaReferences(kind, doc)).toEqual(expected);
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
        expect([...doc.share.keys()]).toEqual(roots);
        expect(updates).not.toHaveBeenCalled();
      },
    ));
  });
});
