// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A focus crop's upload as collab writes it into the node (#1580): the crop shows as uploading in `focusUploads`, the
 * way a task row shows as running, and its ending either moves it into the pool or takes it away. Like a task row it
 * carries its own deadline, so one whose ending never came is cleared once its time is up.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyFocusImageUpload } from "@shared/canvas/focus-image-append.js";
import { FOCUS_IMAGE_UPLOAD_EVENT_TYPE, validFocusImages, validFocusUploads, type FocusImageUploadEvent } from "@shared/canvas/focus-images.js";

const OPENED_AT = 1_000_000;
const BUDGET_MS = 7_200_000;
const CROP = { id: "crop-1", name: "Kyoto", width: 640, height: 360 };
const UPLOAD = { ...CROP, deadlineAt: OPENED_AT + BUDGET_MS };
const IMAGE = { ...CROP, url: "https://cdn.test/crop-1.png" };
const BASE = { type: FOCUS_IMAGE_UPLOAD_EVENT_TYPE, docName: "project-p/canvas-s", nodeId: "n1" } as const;

/**
 * A node's data map attached to a document.
 * @returns The map and its document.
 */
function nodeData(): { doc: Y.Doc; data: Y.Map<unknown> } {
  const doc = new Y.Doc();
  return { doc, data: doc.getMap<unknown>("data") };
}

/**
 * Apply one event inside a transaction.
 * @param doc - The document.
 * @param data - The node's data map.
 * @param event - The event.
 */
function apply(doc: Y.Doc, data: Y.Map<unknown>, event: FocusImageUploadEvent): void {
  doc.transact(() => applyFocusImageUpload(data, event));
}

/**
 * The node's uploading entries as plain values.
 * @param data - The node's data map.
 * @returns The entries.
 */
function uploads(data: Y.Map<unknown>): unknown[] {
  const raw = data.get("focusUploads");
  return validFocusUploads(raw instanceof Y.Array ? raw.toArray() : raw);
}

/**
 * The node's pool as plain values.
 * @param data - The node's data map.
 * @returns The images.
 */
function pool(data: Y.Map<unknown>): unknown[] {
  const raw = data.get("focusImages");
  return validFocusImages(raw instanceof Y.Array ? raw.toArray() : raw);
}

describe("applyFocusImageUpload", () => {
  it("shows a crop that started uploading, once per id", () => {
    const { doc, data } = nodeData();
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    expect(uploads(data)).toEqual([UPLOAD]);
    expect(pool(data)).toEqual([]);
  });

  it("moves a crop that ended well from uploading into the pool in one change", () => {
    const { doc, data } = nodeData();
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    const seen: Array<[number, number]> = [];
    doc.on("afterTransaction", () => seen.push([uploads(data).length, pool(data).length]));
    apply(doc, data, { ...BASE, state: "completed", image: IMAGE });
    expect(seen).toEqual([[0, 1]]);
    expect(pool(data)).toEqual([IMAGE]);
  });

  it("puts a dedup hit straight into the pool", () => {
    const { doc, data } = nodeData();
    apply(doc, data, { ...BASE, state: "completed", image: IMAGE });
    expect(pool(data)).toEqual([IMAGE]);
    expect(uploads(data)).toEqual([]);
  });

  it("takes away a crop that failed and leaves the pool alone", () => {
    const { doc, data } = nodeData();
    apply(doc, data, { ...BASE, state: "completed", image: { ...IMAGE, id: "other" } });
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    apply(doc, data, { ...BASE, state: "failed", id: UPLOAD.id });
    expect(uploads(data)).toEqual([]);
    expect(pool(data)).toEqual([{ ...IMAGE, id: "other" }]);
  });

  it("never shows as uploading a crop the pool already holds, and a late failure never takes the image away", () => {
    const { doc, data } = nodeData();
    apply(doc, data, { ...BASE, state: "completed", image: IMAGE });
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    apply(doc, data, { ...BASE, state: "failed", id: UPLOAD.id });
    expect(uploads(data)).toEqual([]);
    expect(pool(data)).toEqual([IMAGE]);
  });

  it("clears entries whose time is up when the next upload opens, and keeps the ones still running", () => {
    const { doc, data } = nodeData();
    const later = OPENED_AT + 60_000;
    apply(doc, data, { ...BASE, state: "uploading", openedAt: OPENED_AT, image: UPLOAD });
    apply(doc, data, { ...BASE, state: "uploading", openedAt: later, image: { ...UPLOAD, id: "crop-2", deadlineAt: later + BUDGET_MS } });
    const next = { ...UPLOAD, id: "crop-3", deadlineAt: UPLOAD.deadlineAt + BUDGET_MS };
    apply(doc, data, { ...BASE, state: "uploading", openedAt: UPLOAD.deadlineAt, image: next });
    expect(uploads(data)).toEqual([{ ...UPLOAD, id: "crop-2", deadlineAt: later + BUDGET_MS }, next]);
  });
});

describe("validFocusUploads", () => {
  it("keeps well-formed entries once per id and drops the rest", () => {
    expect(validFocusUploads([UPLOAD, UPLOAD, { id: "", name: "x", width: 1, height: 1 }, { id: "b", name: "y", width: -1, height: 1 }, "junk"]))
      .toEqual([UPLOAD]);
    expect(validFocusUploads("not a list")).toEqual([]);
  });

  it("drops an entry with no deadline to judge it by", () => {
    expect(validFocusUploads([CROP, { ...CROP, deadlineAt: Number.NaN }, { ...CROP, deadlineAt: "soon" }])).toEqual([]);
  });
});
