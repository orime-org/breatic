// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `upload` clip: a placeholder for a local video still uploading in the background (#1434 design §2). The schema
 * checks only the clip's own `upload` fields; its range against `upload.durationSeconds` is the arrangement's
 * `invalid_range` conflict, so a range a concurrent trim pushed past the end must still read.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { attachTimelineRecord, initializeTimelineDocument, readTimelineContent } from "../document.js";
import { TimelineClipSchema, TimelineUploadClipSchema, TimelineVideoClipSchema } from "../schema.js";

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const UPLOAD = "b0000000-0000-4000-8000-000000000001";

const uploadClip = {
  id: "60000000-0000-4000-8000-000000000001",
  trackId: "visual-1",
  kind: "upload" as const,
  upload: { uploadId: UPLOAD, name: "beach.mp4", durationSeconds: 2.5 },
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 60,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

/**
 * The placeholder with its `upload` fields replaced.
 * @param upload - The fields to override.
 * @returns The clip.
 * @throws {never} Never.
 */
function withUpload(upload: Record<string, unknown>): Record<string, unknown> {
  return { ...uploadClip, upload: { ...uploadClip.upload, ...upload } };
}

describe("upload clip schema", () => {
  it("accepts a placeholder alone and through the clip union", () => {
    expect(TimelineUploadClipSchema.parse(uploadClip)).toEqual(uploadClip);
    expect(TimelineClipSchema.parse(uploadClip)).toEqual(uploadClip);
  });

  it("accepts a name of exactly 255 characters and a fractional duration", () => {
    const named = withUpload({ name: "a".repeat(255), durationSeconds: 0.04 });
    expect(TimelineClipSchema.safeParse(named).success).toBe(true);
  });

  it.each([
    ["an uploadId that is not a uuid", { uploadId: "upload-1" }],
    ["an empty name", { name: "" }],
    ["a name longer than 255 characters", { name: "a".repeat(256) }],
    ["a zero duration", { durationSeconds: 0 }],
    ["a negative duration", { durationSeconds: -1 }],
    ["an infinite duration", { durationSeconds: Number.POSITIVE_INFINITY }],
    ["a NaN duration", { durationSeconds: Number.NaN }],
    ["a duration written as text", { durationSeconds: "2.5" }],
    ["an unknown upload field", { fileUrl: "https://cdn.example/a.mp4" }],
  ])("refuses %s", (_case, upload) => {
    expect(TimelineUploadClipSchema.safeParse(withUpload(upload)).success).toBe(false);
    expect(TimelineClipSchema.safeParse(withUpload(upload)).success).toBe(false);
  });

  it("refuses a placeholder without its upload fields", () => {
    const { upload: _upload, ...bare } = uploadClip;
    expect(TimelineClipSchema.safeParse(bare).success).toBe(false);
  });

  it("refuses a sourceId or a content binding, which only video and web clips carry", () => {
    expect(TimelineClipSchema.safeParse({ ...uploadClip, sourceId: "10000000-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(TimelineClipSchema.safeParse({ ...uploadClip, contentBinding: { baseSourceResultId: null, operationId: UPLOAD } }).success).toBe(false);
  });

  it("refuses an upload field on a video clip", () => {
    const { upload, kind: _kind, ...placement } = uploadClip;
    const video = { ...placement, kind: "video", sourceId: "10000000-0000-4000-8000-000000000001" };
    expect(TimelineVideoClipSchema.safeParse(video).success).toBe(true);
    expect(TimelineClipSchema.safeParse({ ...video, upload }).success).toBe(false);
  });

  it("does not check the range against the duration: a range past the end still parses", () => {
    const past = { ...uploadClip, sourceInFrame: 50, durationFrames: 500 };
    expect(TimelineClipSchema.parse(past)).toEqual(past);
  });
});

describe("reading upload clips", () => {
  it("reads a placeholder beside a video clip and lists nothing as damaged", () => {
    const doc = new Y.Doc();
    initializeTimelineDocument(doc, settings);
    attachTimelineRecord(doc.getMap("clips"), uploadClip.id, uploadClip);

    const { document, damaged } = readTimelineContent(doc);

    expect(document.clips).toEqual({ [uploadClip.id]: uploadClip });
    expect(damaged.clips).toEqual([]);
  });

  it("reads a placeholder whose range runs past its duration", () => {
    const doc = new Y.Doc();
    initializeTimelineDocument(doc, settings);
    const past = { ...uploadClip, sourceInFrame: 30, durationFrames: 60 };
    attachTimelineRecord(doc.getMap("clips"), past.id, past);

    expect(readTimelineContent(doc).document.clips[past.id]).toEqual(past);
  });
});
