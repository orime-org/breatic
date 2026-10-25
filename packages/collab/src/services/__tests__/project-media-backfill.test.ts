// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  CANVAS_NODES_KEY, canvasSpaceDocName, documentBodyFragment, documentSpaceDocName,
  initializeTimelineDocument, projectMetaDocName, timelineSpaceDocName,
} from "@breatic/shared";
import * as documents from "../yjs-documents.repo.js";
import { createSpaceProjectMediaBackfillSource } from "../project-media-backfill.js";

vi.mock("../yjs-documents.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof documents>()), scanMediaBackfillDocuments: vi.fn(),
}));

const PROJECT = "10000000-0000-4000-8000-000000000001";
const SPACE = "20000000-0000-4000-8000-000000000001";
const OTHER_SPACE = "20000000-0000-4000-8000-000000000002";
const ASSET = "30000000-0000-4000-8000-000000000001";
const OTHER_ASSET = "30000000-0000-4000-8000-000000000002";
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const URL = "https://cdn.example/a-video.mp4";
const COVER = "https://cdn.example/b-cover.jpg";

/** Encode a real fixture and release its construction-time document. */
function bytes(build: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  try { build(doc); return Y.encodeStateAsUpdate(doc); }
  finally { doc.destroy(); }
}

/** Attach the actual nested Canvas node/data structure before writing fields. */
function node(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown>): void {
  const item = new Y.Map<unknown>();
  doc.getMap(CANVAS_NODES_KEY).set(id, item);
  item.set("id", id);
  item.set("type", type);
  const data = new Y.Map<unknown>();
  item.set("data", data);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
}

/** Attach an actual Document media or text node with its stored attributes. */
function element(parent: Y.XmlFragment | Y.XmlElement, name: string, attrs: Record<string, string> = {}): Y.XmlElement {
  const child = new Y.XmlElement(name);
  parent.insert(parent.length, [child]);
  for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
  return child;
}

beforeEach(() => {
  vi.mocked(documents.scanMediaBackfillDocuments).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("Space media provenance backfill source", () => {
  it("uses its stable report name", () => {
    expect(createSpaceProjectMediaBackfillSource().name).toBe("space_documents");
  });
  it.each([null, "project-last/document-last"])("passes cursor %j and the exact bounded limit to the owning repository", async (cursor) => {
    const source = createSpaceProjectMediaBackfillSource();
    expect(await source.readPage(cursor, 19)).toEqual([]);
    expect(documents.scanMediaBackfillDocuments).toHaveBeenCalledExactlyOnceWith(cursor, 19);
  });
  it("reads actual Canvas media fields, deduplicates and sorts while leaving stored bytes intact", async () => {
    const name = canvasSpaceDocName(PROJECT, SPACE);
    const data = bytes((doc) => {
      node(doc, "video", "video", { content: URL, coverUrl: COVER, styleImageUrls: [COVER, URL] });
      node(doc, "other-video", "video", { content: URL });
      node(doc, "words", "text", { content: "https://cdn.example/text-is-not-media.mp4" });
      doc.getMap("unrelated").set("url", "https://cdn.example/unrelated.mp4");
    });
    const before = data.slice();
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, projectId: PROJECT, urls: [URL, COVER] });
    expect(rows[0]?.assetIds ?? []).toEqual([]);
    expect(rows[0]?.reason).toBeUndefined();
    expect(data).toEqual(before);
  });
  it("reads nested Document media attributes and ignores paragraph URLs and link text", async () => {
    const name = documentSpaceDocName(PROJECT, SPACE);
    const data = bytes((doc) => {
      const group = element(documentBodyFragment(doc), "blockGroup");
      const block = element(group, "blockContainer", { id: "media-block" });
      element(block, "video", { url: URL });
      element(block, "image", { url: COVER });
      const nested = element(block, "blockGroup");
      element(element(nested, "blockContainer"), "video", { url: URL });
      const paragraph = element(group, "paragraph", { url: "https://cdn.example/paragraph-attribute.mp4" });
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      text.insert(0, "https://cdn.example/paragraph-text.mp4");
      text.format(0, text.length, { link: { href: "https://cdn.example/link.mp4" } });
    });
    const before = data.slice();
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, projectId: PROJECT, urls: [URL, COVER] });
    expect(rows[0]?.assetIds ?? []).toEqual([]);
    expect(rows[0]?.reason).toBeUndefined();
    expect(data).toEqual(before);
  });
  it("reads real Timeline source identities with stable deduplication and no URL inference", async () => {
    const name = timelineSpaceDocName(PROJECT, SPACE);
    const data = bytes((doc) => {
      initializeTimelineDocument(doc, SETTINGS);
      const base = { kind: "video", timebase: SETTINGS.fps, extentFrames: 48, durationSeconds: "2", durationOrigin: "registered" };
      doc.getMap("sources").set("source-b", { ...base, id: "40000000-0000-4000-8000-000000000001", assetId: OTHER_ASSET });
      doc.getMap("sources").set("source-a", { ...base, id: "40000000-0000-4000-8000-000000000002", assetId: ASSET });
      doc.getMap("sources").set("source-copy", { ...base, id: "40000000-0000-4000-8000-000000000003", assetId: ASSET });
      doc.getMap("sources").set("words", "https://cdn.example/arbitrary-source.mp4");
      doc.getMap("comments").set("text", URL);
    });
    const before = data.slice();
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, projectId: PROJECT, assetIds: [ASSET, OTHER_ASSET] });
    expect(rows[0]?.urls ?? []).toEqual([]);
    expect(rows[0]?.reason).toBeUndefined();
    expect(data).toEqual(before);
  });
  it("retains a readable content row with no media so it can be recorded in the report", async () => {
    const name = canvasSpaceDocName(PROJECT, SPACE);
    const data = bytes(() => {});
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, projectId: PROJECT });
    expect(rows[0]?.assetIds ?? []).toEqual([]);
    expect(rows[0]?.urls ?? []).toEqual([]);
    expect(rows[0]?.reason).toBeUndefined();
  });
  it("keeps arbitrary URL-like Document text outside physical media provenance", async () => {
    await fc.assert(fc.asyncProperty(fc.webUrl(), async (url) => {
      const name = documentSpaceDocName(PROJECT, SPACE);
      const data = bytes((doc) => {
        const text = new Y.XmlText();
        const paragraph = element(documentBodyFragment(doc), "paragraph", { url });
        paragraph.insert(0, [text]);
        text.insert(0, url);
      });
      vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
      const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.assetIds ?? []).toEqual([]);
      expect(rows[0]?.urls ?? []).toEqual([]);
      expect(rows[0]?.reason).toBeUndefined();
    }));
  });
  it("destroys each successfully decoded temporary document", async () => {
    const first = { name: canvasSpaceDocName(PROJECT, SPACE), data: bytes((doc) => node(doc, "video", "video", { content: URL })) };
    const second = { name: documentSpaceDocName(PROJECT, OTHER_SPACE), data: bytes((doc) => element(documentBodyFragment(doc), "video", { url: URL })) };
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([first, second]);
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows).toHaveLength(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy.mock.contexts.map((doc) => doc instanceof Y.Doc && doc.isDestroyed)).toEqual([true, true]);
  });
  it("reports invalid Yjs bytes and still destroys the temporary decoder", async () => {
    const name = canvasSpaceDocName(PROJECT, SPACE);
    const data = new Uint8Array([255, 255, 255]);
    const before = data.slice();
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, projectId: PROJECT, reason: "invalid_document" });
    expect(rows[0]?.assetIds ?? []).toEqual([]);
    expect(rows[0]?.urls ?? []).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.contexts.map((doc) => doc instanceof Y.Doc && doc.isDestroyed)).toEqual([true]);
    expect(data).toEqual(before);
  });
  it.each([
    `project-not-a-project-uuid/canvas-${SPACE}`,
    `project-${PROJECT}/timeline-not-a-space-uuid`,
    `project-${PROJECT}/canvas`,
    `project-${PROJECT}/unknown-${SPACE}`,
    projectMetaDocName(PROJECT),
  ])("reports malformed or non-content name %s as invalid_document", async (name) => {
    const data = bytes(() => {});
    const before = data.slice();
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([{ name, data }]);
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: name, cursor: name, reason: "invalid_document" });
    expect(rows[0]?.assetIds ?? []).toEqual([]);
    expect(rows[0]?.urls ?? []).toEqual([]);
    expect(data).toEqual(before);
  });
  it("keeps later valid rows available after one invalid document", async () => {
    const broken = { name: canvasSpaceDocName(PROJECT, SPACE), data: new Uint8Array([255]) };
    const valid = { name: canvasSpaceDocName(PROJECT, OTHER_SPACE), data: bytes((doc) => node(doc, "video", "video", { content: URL })) };
    vi.mocked(documents.scanMediaBackfillDocuments).mockResolvedValue([broken, valid]);
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");
    const rows = await createSpaceProjectMediaBackfillSource().readPage(null, 19);
    expect(rows.map((row) => ({ id: row.id, reason: row.reason, urls: row.urls ?? [] }))).toEqual([
      { id: broken.name, reason: "invalid_document", urls: [] }, { id: valid.name, reason: undefined, urls: [URL] },
    ]);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
  it("preserves the original database scanner Error and allocates no decoder for it", async () => {
    const error = new Error("Yjs database unavailable");
    vi.mocked(documents.scanMediaBackfillDocuments).mockRejectedValueOnce(error);
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy");
    await expect(createSpaceProjectMediaBackfillSource().readPage(null, 19)).rejects.toBe(error);
    expect(destroy).not.toHaveBeenCalled();
  });
});
