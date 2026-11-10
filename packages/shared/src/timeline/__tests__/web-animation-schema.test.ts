// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web-animation clips and operation receipts in the Timeline document (inner#1711 design §3.1). The tests write
 * records directly, as a collaborator's update would.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { attachTimelineRecord, initializeTimelineDocument, readTimelineContent } from "../document.js";
import {
  TimelineClipSchema, TimelineOperationReceiptSchema, TimelineWebAnimationClipSchema, TimelineVideoClipSchema,
} from "../schema.js";

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const identityTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000001";
const EXECUTION = "40000000-0000-4000-8000-000000000001";
const ACTION = "50000000-0000-4000-8000-000000000001";

const webClip = {
  id: "60000000-0000-4000-8000-000000000001",
  trackId: "visual-2",
  kind: "web-animation" as const,
  contentBinding: { baseSourceResultId: SOURCE_VERSION, operationId: null },
  startFrame: 24,
  sourceInFrame: 0,
  durationFrames: 96,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: identityTransform,
};
const placeholderClip = {
  ...webClip,
  id: "60000000-0000-4000-8000-000000000002",
  contentBinding: { baseSourceResultId: null, operationId: EXECUTION },
};
const videoClip = {
  id: "60000000-0000-4000-8000-000000000003",
  trackId: "visual-1",
  kind: "video" as const,
  sourceId: "10000000-0000-4000-8000-000000000001",
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 48,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: identityTransform,
};
const receipt = { executionId: EXECUTION, inputHash: "sha256:abc", landedAt: "2026-11-07T08:00:00.000Z" };

/**
 * A seeded document with one second visual track.
 * @returns The document.
 */
function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initializeTimelineDocument(doc, settings);
  attachTimelineRecord(doc.getMap("tracks"), "visual-2", { id: "visual-2", kind: "visual", order: 1 });
  return doc;
}

describe("web-animation clip schema", () => {
  it("accepts a copy bound to a succeeded source version", () => {
    expect(TimelineWebAnimationClipSchema.parse(webClip)).toEqual(webClip);
  });

  it("accepts a placeholder bound to an in-progress execution", () => {
    expect(TimelineWebAnimationClipSchema.parse(placeholderClip)).toEqual(placeholderClip);
  });

  it("refuses a binding that names neither a source version nor an operation", () => {
    const unbound = { ...webClip, contentBinding: { baseSourceResultId: null, operationId: null } };
    expect(TimelineWebAnimationClipSchema.safeParse(unbound).success).toBe(false);
  });

  it("refuses a sourceId, which only video clips carry", () => {
    expect(TimelineWebAnimationClipSchema.safeParse({ ...webClip, sourceId: SOURCE_VERSION }).success).toBe(false);
  });

  it("keeps the video clip schema unchanged", () => {
    expect(TimelineVideoClipSchema.parse(videoClip)).toEqual(videoClip);
  });

  it("discriminates both clip kinds through one union", () => {
    expect(TimelineClipSchema.parse(videoClip)).toEqual(videoClip);
    expect(TimelineClipSchema.parse(webClip)).toEqual(webClip);
    expect(TimelineClipSchema.safeParse({ ...webClip, kind: "image" }).success).toBe(false);
  });
});

describe("operation receipt schema", () => {
  it("accepts an execution id, input hash and landing time", () => {
    expect(TimelineOperationReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("refuses a receipt without an execution id", () => {
    expect(TimelineOperationReceiptSchema.safeParse({ inputHash: "sha256:abc", landedAt: receipt.landedAt }).success).toBe(false);
  });
});

describe("reading web-animation clips and receipts", () => {
  it("reads web clips beside video clips", () => {
    const doc = seeded();
    attachTimelineRecord(doc.getMap("clips"), webClip.id, webClip);
    attachTimelineRecord(doc.getMap("clips"), placeholderClip.id, placeholderClip);

    const { document, damaged } = readTimelineContent(doc);

    expect(document.clips).toEqual({ [webClip.id]: webClip, [placeholderClip.id]: placeholderClip });
    expect(damaged.clips).toEqual([]);
  });

  it("lists an unreadable web clip as damaged and keeps the readable ones", () => {
    const doc = seeded();
    attachTimelineRecord(doc.getMap("clips"), webClip.id, webClip);
    const broken = { ...placeholderClip, contentBinding: { baseSourceResultId: null, operationId: null } };
    attachTimelineRecord(doc.getMap("clips"), broken.id, broken);

    const { document, damaged } = readTimelineContent(doc);

    expect(Object.keys(document.clips)).toEqual([webClip.id]);
    expect(damaged.clips).toEqual([broken.id]);
  });

  it("reads receipts keyed by action id", () => {
    const doc = seeded();
    doc.getMap("operationReceipts").set(ACTION, receipt);

    expect(readTimelineContent(doc).document.operationReceipts).toEqual({ [ACTION]: receipt });
  });

  it("reads a document written before receipts existed as having none", () => {
    const doc = seeded();

    expect(readTimelineContent(doc).document.operationReceipts).toEqual({});
  });

  it("leaves out a receipt that fails its schema", () => {
    const doc = seeded();
    doc.getMap("operationReceipts").set(ACTION, receipt);
    doc.getMap("operationReceipts").set("50000000-0000-4000-8000-000000000002", { executionId: "not-a-uuid" });

    expect(readTimelineContent(doc).document.operationReceipts).toEqual({ [ACTION]: receipt });
  });
});
