// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A Timeline upload's result, written into the Timeline document by collab (inner#1709 design §4.3, §7.1). Each case
 * writes the placeholder directly, as the uploader's page leaves it, and applies the backend's event the way collab's
 * task listener does.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import * as spaceContent from "../space-content.js";
import { attachTimelineRecord, initializeTimelineDocument, readTimelineContent } from "../timeline/document.js";
import { TimelineClipSchema, type TimelineClip, type TimelineDocumentV1 } from "../timeline/schema.js";
import { applyTimelineUpload, TIMELINE_UPLOAD_ORIGIN, type TimelineUploadEvent } from "../timeline-upload.js";

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const DOC_NAME = "project-p/timeline-s";
const UPLOAD = "b0000000-0000-4000-8000-000000000001";
const OTHER_UPLOAD = "b0000000-0000-4000-8000-000000000002";
const PLACEHOLDER = "60000000-0000-4000-8000-000000000001";
const SECOND_PLACEHOLDER = "60000000-0000-4000-8000-000000000002";
const ASSET = "20000000-0000-4000-8000-000000000001";
const transform = { frameX: 0.1, frameY: -0.1, scaleX: 0.5, scaleY: 0.5, rotation: 15 };

const placement = {
  trackId: "visual-1", startFrame: 0, sourceInFrame: 0, durationFrames: 60, rate: { num: 1, den: 1 }, gain: 1,
  mute: false, transform,
};
/** A 2.5 s local video: 60 frames at 24 fps, untrimmed. */
const videoPlaceholder = {
  ...placement, id: PLACEHOLDER, kind: "upload" as const,
  upload: { uploadId: UPLOAD, name: "beach.mp4", kind: "video" as const, durationSeconds: 2.5 },
};
/** A local picture, placed for 5 s. */
const imagePlaceholder = {
  ...placement, id: PLACEHOLDER, kind: "upload" as const, durationFrames: 120,
  upload: { uploadId: UPLOAD, name: "beach.png", kind: "image" as const, durationSeconds: null },
};
/** A 2.5 s local sound. */
const audioPlaceholder = {
  ...placement, id: PLACEHOLDER, kind: "upload" as const,
  upload: { uploadId: UPLOAD, name: "song.mp3", kind: "audio" as const, durationSeconds: 2.5 },
};

type Placeholder = typeof videoPlaceholder | typeof imagePlaceholder | typeof audioPlaceholder;
type UploadResult = NonNullable<TimelineUploadEvent["result"]>;

const VIDEO_RESULT: UploadResult = { assetId: ASSET, kind: "video", durationSeconds: 4, width: 1920, height: 1080 };
const IMAGE_RESULT: UploadResult = { assetId: ASSET, kind: "image", durationSeconds: null, width: 800, height: 600 };
const AUDIO_RESULT: UploadResult = { assetId: ASSET, kind: "audio", durationSeconds: 4, width: null, height: null };

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.restoreAllMocks();
});

/**
 * A seeded version 3 Timeline with a second track and the given records stored as maps, as the editor writes them.
 * @param records - Clip records to store.
 * @returns The document.
 * @throws {Error} When seeding fails.
 */
function timeline(...records: object[]): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  initializeTimelineDocument(doc, settings);
  doc.transact(() => {
    attachTimelineRecord(doc.getMap("tracks"), "visual-2", { id: "visual-2", order: 1 });
    for (const record of records) attachTimelineRecord(doc.getMap("clips"), (record as { id: string }).id, record);
  }, "uploader");
  return doc;
}

/**
 * The backend's event for this upload.
 * @param state - What happened.
 * @param fields - The result or the reason.
 * @returns The event.
 * @throws {never} Never.
 */
function uploadEvent(state: TimelineUploadEvent["state"], fields: Partial<TimelineUploadEvent> = {}): TimelineUploadEvent {
  return { type: "timeline-upload", docName: DOC_NAME, uploadId: UPLOAD, state, ...fields };
}

/**
 * A completed event carrying the registered asset.
 * @param result - What registration measured.
 * @returns The event.
 * @throws {never} Never.
 */
function completed(result: UploadResult): TimelineUploadEvent {
  return uploadEvent("completed", { result });
}

/**
 * The readable document.
 * @param doc - The content document.
 * @returns What every reader sees.
 * @throws {Error} When the content cannot be read.
 */
function read(doc: Y.Doc): TimelineDocumentV1 {
  return readTimelineContent(doc).document;
}

/**
 * The placement fields a placeholder keeps when it becomes a clip.
 * @param placeholder - The placeholder.
 * @returns Its fields without `kind` and `upload`.
 * @throws {never} Never.
 */
function placementOf(placeholder: Placeholder): Omit<Placeholder, "kind" | "upload"> {
  const { kind: _kind, upload: _upload, ...rest } = placeholder;
  return rest;
}

/**
 * Count the updates a call makes.
 * @param doc - The document.
 * @param run - The call.
 * @returns The origins of the updates, in order.
 * @throws {Error} When the call throws.
 */
function originsOf(doc: Y.Doc, run: () => void): unknown[] {
  const origins: unknown[] = [];
  /**
   * Record one update's origin.
   * @param _update - The update.
   * @param origin - Its transaction origin.
   */
  const listen = (_update: Uint8Array, origin: unknown): void => {
    origins.push(origin);
  };
  doc.on("update", listen);
  try {
    run();
  } finally {
    doc.off("update", listen);
  }
  return origins;
}

describe("applyTimelineUpload exports (design §4.2, §4.3)", () => {
  it("is exported from @breatic/shared/space-content with its origin", () => {
    expect(spaceContent.applyTimelineUpload).toBe(applyTimelineUpload);
    expect(spaceContent.TIMELINE_UPLOAD_ORIGIN).toBe(TIMELINE_UPLOAD_ORIGIN);
  });
});

describe("processing (design §4.3, §7.1)", () => {
  it("marks a placeholder that has no state yet as processing", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, uploadEvent("processing"));
    expect(read(doc).clips[PLACEHOLDER]).toEqual({ ...videoPlaceholder, upload: { ...videoPlaceholder.upload, state: "processing" } });
    expect(read(doc).sources).toEqual({});
  });

  it("never replaces a failure, and writes nothing", () => {
    const failed = { ...videoPlaceholder, upload: { ...videoPlaceholder.upload, state: "failed" as const, failure: "tooLarge" as const, retryable: false } };
    const doc = timeline(failed);
    expect(originsOf(doc, () => applyTimelineUpload(doc, uploadEvent("processing")))).toEqual([]);
    expect(read(doc).clips[PLACEHOLDER]).toEqual(failed);
  });

  it("writes nothing to a placeholder already processing", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, uploadEvent("processing"));
    expect(originsOf(doc, () => applyTimelineUpload(doc, uploadEvent("processing")))).toEqual([]);
  });
});

describe("completed (design §4.3 conversion table, §7.1)", () => {
  it("turns an untrimmed video placeholder into a video clip of the whole registered length and writes one source", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const document = read(doc);
    const sources = Object.values(document.sources);
    expect(sources).toHaveLength(1);
    const source = sources[0]!;
    expect(source).toEqual({
      id: source.id, kind: "video", assetId: ASSET, timebase: settings.fps, extentFrames: 96, durationSeconds: "4",
      durationOrigin: "registered",
    });
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(videoPlaceholder), kind: "video", sourceId: source.id, durationFrames: 96 });
  });

  it("stops an untrimmed placeholder at the next presentable clip on its track", () => {
    const missingSource = {
      ...placement, id: "30000000-0000-4000-8000-000000000001", kind: "video" as const, startFrame: 70, durationFrames: 10,
      sourceId: "10000000-0000-4000-8000-0000000000ff",
    };
    const text = { ...placement, id: "30000000-0000-4000-8000-000000000002", kind: "text" as const, startFrame: 80, durationFrames: 24, text: { body: "Next", size: 0.06 } };
    const otherTrack = { ...text, id: "30000000-0000-4000-8000-000000000003", trackId: "visual-2", startFrame: 30 };
    const doc = timeline(videoPlaceholder, missingSource, text, otherTrack);
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const converted = read(doc).clips[PLACEHOLDER]!;
    expect(converted.kind).toBe("video");
    expect(converted.durationFrames).toBe(80);
  });

  it("cuts a trimmed placeholder to what the asset holds and keeps its in-point", () => {
    const trimmed = { ...videoPlaceholder, sourceInFrame: 24, durationFrames: 36 };
    const doc = timeline(trimmed);
    applyTimelineUpload(doc, completed({ ...VIDEO_RESULT, durationSeconds: 1.5 }));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source.kind === "video" && source.extentFrames).toBe(36);
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(trimmed), kind: "video", sourceId: source.id, durationFrames: 12 });
  });

  it("keeps a trimmed placeholder's length when the asset holds all of it", () => {
    const trimmed = { ...videoPlaceholder, durationFrames: 40 };
    const doc = timeline(trimmed);
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const source = Object.values(read(doc).sources)[0]!;
    expect(read(doc).clips[PLACEHOLDER]).toEqual({ ...placementOf(trimmed), kind: "video", sourceId: source.id, durationFrames: 40 });
  });

  it("deletes a placeholder the registered asset leaves no frame of", () => {
    const pastEnd = { ...videoPlaceholder, sourceInFrame: 48, durationFrames: 12 };
    const doc = timeline(pastEnd);
    applyTimelineUpload(doc, completed({ ...VIDEO_RESULT, durationSeconds: 1 }));
    expect(read(doc).clips).toEqual({});
  });

  it("measures by the duration the browser read when registration measured none", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, completed({ ...VIDEO_RESULT, durationSeconds: null }));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source).toEqual({
      id: source.id, kind: "video", assetId: ASSET, timebase: settings.fps, extentFrames: 60, durationSeconds: "2.5",
      durationOrigin: "decoded",
    });
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(videoPlaceholder), kind: "video", sourceId: source.id });
  });

  it("turns a picture placeholder into an image clip of the same length and writes an image source with its size", () => {
    const doc = timeline(imagePlaceholder);
    applyTimelineUpload(doc, completed(IMAGE_RESULT));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source).toEqual({ id: source.id, kind: "image", assetId: ASSET, width: 800, height: 600 });
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(imagePlaceholder), kind: "image", sourceId: source.id, sourceInFrame: 0, durationFrames: 120 });
  });

  it("writes an image source of null size when registration measured none", () => {
    const doc = timeline(imagePlaceholder);
    applyTimelineUpload(doc, completed({ ...IMAGE_RESULT, width: null, height: null }));
    const source = Object.values(read(doc).sources)[0]!;
    expect(source).toEqual({ id: source.id, kind: "image", assetId: ASSET, width: null, height: null });
  });

  it("turns an audio placeholder into an audio clip and writes an audio source", () => {
    const doc = timeline(audioPlaceholder);
    applyTimelineUpload(doc, completed(AUDIO_RESULT));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source).toEqual({
      id: source.id, kind: "audio", assetId: ASSET, timebase: settings.fps, extentFrames: 96, durationSeconds: "4",
      durationOrigin: "registered",
    });
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(audioPlaceholder), kind: "audio", sourceId: source.id, durationFrames: 96 });
  });

  it("converts by the registered kind when it differs: a head-trimmed video placeholder registered as a picture gets in-point 0 and reads back", () => {
    const trimmed = { ...videoPlaceholder, sourceInFrame: 24, durationFrames: 36 };
    const doc = timeline(trimmed);
    applyTimelineUpload(doc, completed(IMAGE_RESULT));
    const content = readTimelineContent(doc);
    const source = Object.values(content.document.sources)[0]!;
    expect(source.kind).toBe("image");
    expect(content.document.clips[PLACEHOLDER]).toEqual({ ...placementOf(trimmed), kind: "image", sourceId: source.id, sourceInFrame: 0, durationFrames: 36 });
    expect(content.damaged).toEqual({ clips: [] });
  });

  it("converts by the registered kind when it differs: a head-trimmed audio placeholder registered as a picture gets in-point 0", () => {
    const trimmed = { ...audioPlaceholder, sourceInFrame: 12, durationFrames: 48 };
    const doc = timeline(trimmed);
    applyTimelineUpload(doc, completed(IMAGE_RESULT));
    const converted = read(doc).clips[PLACEHOLDER]!;
    expect(converted.kind).toBe("image");
    expect(converted.sourceInFrame).toBe(0);
    expect(converted.durationFrames).toBe(48);
  });

  it("converts by the registered kind when it differs: a picture placeholder registered as a video with a duration", () => {
    const doc = timeline(imagePlaceholder);
    applyTimelineUpload(doc, completed({ ...VIDEO_RESULT, durationSeconds: 2 }));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source).toEqual({
      id: source.id, kind: "video", assetId: ASSET, timebase: settings.fps, extentFrames: 48, durationSeconds: "2",
      durationOrigin: "registered",
    });
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(imagePlaceholder), kind: "video", sourceId: source.id, durationFrames: 48 });
  });

  it("converts by the registered kind when it differs: a video placeholder registered as audio", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, completed(AUDIO_RESULT));
    const document = read(doc);
    const source = Object.values(document.sources)[0]!;
    expect(source.kind).toBe("audio");
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(videoPlaceholder), kind: "audio", sourceId: source.id, durationFrames: 96 });
  });

  it.each([
    ["a video", VIDEO_RESULT],
    ["an audio", AUDIO_RESULT],
  ])("marks a picture placeholder registered as %s with no duration anywhere as failed, not retryable", (_kind, result) => {
    const doc = timeline(imagePlaceholder);
    applyTimelineUpload(doc, completed({ ...result, durationSeconds: null }));
    expect(read(doc).clips[PLACEHOLDER]).toEqual({
      ...imagePlaceholder, upload: { ...imagePlaceholder.upload, state: "failed", failure: "failed", retryable: false },
    });
    expect(read(doc).sources).toEqual({});
  });

  it("converts every placeholder of the upload against one source and leaves other uploads alone", () => {
    const copy = { ...videoPlaceholder, id: SECOND_PLACEHOLDER, trackId: "visual-2", startFrame: 200 };
    const other = { ...videoPlaceholder, id: "60000000-0000-4000-8000-000000000003", startFrame: 400, upload: { ...videoPlaceholder.upload, uploadId: OTHER_UPLOAD } };
    const doc = timeline(videoPlaceholder, copy, other);
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const document = read(doc);
    const sources = Object.values(document.sources);
    expect(sources).toHaveLength(1);
    expect(document.clips[PLACEHOLDER]).toEqual({ ...placementOf(videoPlaceholder), kind: "video", sourceId: sources[0]!.id, durationFrames: 96 });
    expect(document.clips[SECOND_PLACEHOLDER]).toEqual({ ...placementOf(copy), kind: "video", sourceId: sources[0]!.id, durationFrames: 96 });
    expect(document.clips[other.id]).toEqual(other);
  });

  it("writes the conversion in one transaction under TIMELINE_UPLOAD_ORIGIN", () => {
    const doc = timeline(videoPlaceholder);
    expect(originsOf(doc, () => applyTimelineUpload(doc, completed(VIDEO_RESULT)))).toEqual([TIMELINE_UPLOAD_ORIGIN]);
  });

  it("converts a placeholder a peer stored as a plain value, storing the clip as a map", () => {
    const doc = timeline();
    doc.transact(() => doc.getMap("clips").set(PLACEHOLDER, videoPlaceholder), "peer");
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const source = Object.values(read(doc).sources)[0]!;
    expect(read(doc).clips[PLACEHOLDER]).toEqual({ ...placementOf(videoPlaceholder), kind: "video", sourceId: source.id, durationFrames: 96 });
    expect(doc.getMap("clips").get(PLACEHOLDER)).toBeInstanceOf(Y.Map);
  });

  it("marks the placeholder failed, not retryable, and converts nothing when the converted clip fails the clip schema", () => {
    const doc = timeline(videoPlaceholder);
    const original = TimelineClipSchema.safeParse.bind(TimelineClipSchema);
    vi.spyOn(TimelineClipSchema, "safeParse").mockImplementation((value: unknown) => {
      if (value !== null && typeof value === "object" && "id" in value && value.id === PLACEHOLDER && "kind" in value && value.kind !== "upload") {
        return original({ ...value, gain: -1 });
      }
      return original(value);
    });
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    vi.restoreAllMocks();
    expect(read(doc).clips[PLACEHOLDER]).toEqual({
      ...videoPlaceholder, upload: { ...videoPlaceholder.upload, state: "failed", failure: "failed", retryable: false },
    });
    expect(read(doc).sources).toEqual({});
  });

  it("writes nothing when the placeholder was deleted", () => {
    const unrelated = { ...videoPlaceholder, id: SECOND_PLACEHOLDER, upload: { ...videoPlaceholder.upload, uploadId: OTHER_UPLOAD } };
    const doc = timeline(unrelated);
    const before = Y.encodeStateAsUpdate(doc);
    for (const event of [uploadEvent("processing"), completed(VIDEO_RESULT), uploadEvent("failed", { reason: "over_cap" })]) {
      expect(originsOf(doc, () => applyTimelineUpload(doc, event))).toEqual([]);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("writes nothing for a completed event repeated after the conversion", () => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, completed(VIDEO_RESULT));
    const before = Y.encodeStateAsUpdate(doc);
    expect(originsOf(doc, () => applyTimelineUpload(doc, completed(VIDEO_RESULT)))).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("failed (design §4.3, §7.1)", () => {
  it.each([
    ["over_cap", { failure: "tooLarge", retryable: false }],
    ["unsupported_type", { failure: "unsupportedType", retryable: false }],
    ["source_unreachable", { failure: "unreachable", retryable: true }],
    ["internal", { failure: "failed", retryable: true }],
  ] as const)("writes the Document failure for %s", (reason, failure) => {
    const doc = timeline(videoPlaceholder);
    applyTimelineUpload(doc, uploadEvent("failed", { reason }));
    expect(read(doc).clips[PLACEHOLDER]).toEqual({ ...videoPlaceholder, upload: { ...videoPlaceholder.upload, state: "failed", ...failure } });
    expect(read(doc).sources).toEqual({});
  });

  it("writes a retryable failure when no cause was recorded", () => {
    const doc = timeline(imagePlaceholder);
    applyTimelineUpload(doc, uploadEvent("failed"));
    expect(read(doc).clips[PLACEHOLDER]).toEqual({
      ...imagePlaceholder, upload: { ...imagePlaceholder.upload, state: "failed", failure: "failed", retryable: true },
    });
  });

  it("replaces processing", () => {
    const doc = timeline(audioPlaceholder);
    applyTimelineUpload(doc, uploadEvent("processing"));
    applyTimelineUpload(doc, uploadEvent("failed", { reason: "empty" }));
    expect(read(doc).clips[PLACEHOLDER]).toEqual({
      ...audioPlaceholder, upload: { ...audioPlaceholder.upload, state: "failed", failure: "empty", retryable: false },
    });
  });
});

/**
 * The document with each source keyed by its asset, since the source id is minted when the upload lands.
 * @param doc - The content document.
 * @returns A comparable reading.
 * @throws {Error} When the content cannot be read.
 */
function comparable(doc: Y.Doc): unknown {
  const document = read(doc);
  const key = (id: string): string => `asset:${document.sources[id]?.assetId ?? id}`;
  return {
    ...document,
    sources: Object.fromEntries(Object.values(document.sources).map((source) => [key(source.id), { ...source, id: key(source.id) }])),
    clips: Object.fromEntries(Object.values(document.clips).map((clip: TimelineClip) => [clip.id, "sourceId" in clip ? { ...clip, sourceId: key(clip.sourceId) } : clip])),
  };
}

describe("any order and repetition of one upload's events lands the same document (design §10 property row)", () => {
  it("ends where the terminal event alone ends, or processing alone, or untouched", () => {
    const terminal = fc.constantFrom<TimelineUploadEvent>(
      completed(VIDEO_RESULT), completed(IMAGE_RESULT), completed(AUDIO_RESULT), completed({ ...VIDEO_RESULT, durationSeconds: null }),
      completed({ ...AUDIO_RESULT, durationSeconds: null }),
      uploadEvent("failed", { reason: "over_cap" }), uploadEvent("failed", { reason: "source_unreachable" }), uploadEvent("failed"),
    );
    fc.assert(fc.property(
      fc.constantFrom<Placeholder>(videoPlaceholder, imagePlaceholder, audioPlaceholder),
      fc.boolean(),
      terminal,
      fc.array(fc.constantFrom("processing", "terminal"), { maxLength: 8 }),
      (placeholder, withCopy, end, sequence) => {
        const records = withCopy ? [placeholder, { ...placeholder, id: SECOND_PLACEHOLDER, trackId: "visual-2", startFrame: 300 }] : [placeholder];
        const events = sequence.map((step) => (step === "terminal" ? end : uploadEvent("processing")));
        const applied = timeline(...records);
        for (const event of events) applyTimelineUpload(applied, event);
        const expected = timeline(...records);
        if (sequence.includes("terminal")) applyTimelineUpload(expected, end);
        else if (sequence.includes("processing")) applyTimelineUpload(expected, uploadEvent("processing"));
        expect(comparable(applied)).toEqual(comparable(expected));
      },
    ));
  });
});
