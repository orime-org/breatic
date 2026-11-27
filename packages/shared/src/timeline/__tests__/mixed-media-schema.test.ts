// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Version 3 of the Timeline document (inner#1709 design §2): tracks without a kind, image and audio sources beside
 * video ones, image, audio and text clips, and placeholders that name what they will become. Every field boundary is a
 * schema rule (acceptance 10), so each is checked here on both sides.
 */

import { describe, expect, it } from "vitest";

import {
  TIMELINE_MAX_GAIN, TIMELINE_SCHEMA_VERSIONS, TimelineAudioClipSchema, TimelineAudioSourceSchema, TimelineClipSchema,
  TimelineDocumentV1Schema, TimelineImageClipSchema, TimelineImageSourceSchema, TimelineSourceSchema,
  TimelineTextClipSchema, TimelineTrackSchema, TimelineUploadClipSchema, TimelineVideoClipSchema,
  isPresentableTimelineClip, type TimelineClip, type TimelineDocumentV1,
} from "../schema.js";

const fps = { num: 24, den: 1 };
const settings = { width: 1920, height: 1080, fps };
const transform = { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
const VIDEO_SOURCE = "10000000-0000-4000-8000-000000000001";
const IMAGE_SOURCE = "10000000-0000-4000-8000-000000000002";
const AUDIO_SOURCE = "10000000-0000-4000-8000-000000000003";
const MISSING_SOURCE = "10000000-0000-4000-8000-0000000000ff";
const UPLOAD = "b0000000-0000-4000-8000-000000000001";

const videoSource = {
  id: VIDEO_SOURCE, kind: "video" as const, url: "https://cdn.example/a.mp4", coverUrl: null, name: "a.mp4", mimeType: "video/mp4",
  width: 1920, height: 1080, timebase: fps, extentFrames: 48, durationSeconds: "2", durationOrigin: "registered" as const,
};
const imageSource = { id: IMAGE_SOURCE, kind: "image" as const, url: "https://cdn.example/a.png", name: "a.png", mimeType: "image/png", width: 800, height: 600 };
const audioSource = {
  id: AUDIO_SOURCE, kind: "audio" as const, url: "https://cdn.example/a.mp3", name: "a.mp3", mimeType: "audio/mpeg",
  timebase: fps, extentFrames: 60, durationSeconds: "2.5", durationOrigin: "registered" as const,
};

const placement = {
  trackId: "visual-1", startFrame: 0, sourceInFrame: 0, durationFrames: 48, rate: { num: 1, den: 1 }, gain: 1,
  mute: false, transform,
};
const videoClip = { ...placement, id: "30000000-0000-4000-8000-000000000001", kind: "video" as const, sourceId: VIDEO_SOURCE };
const imageClip = { ...placement, id: "30000000-0000-4000-8000-000000000002", kind: "image" as const, sourceId: IMAGE_SOURCE, durationFrames: 120 };
const audioClip = { ...placement, id: "30000000-0000-4000-8000-000000000003", kind: "audio" as const, sourceId: AUDIO_SOURCE, sourceInFrame: 12 };
const textClip = {
  ...placement, id: "30000000-0000-4000-8000-000000000004", kind: "text" as const, durationFrames: 120,
  text: { body: "Hello", size: 0.06 },
};
const webClip = {
  ...placement, id: "30000000-0000-4000-8000-000000000005", kind: "web-animation" as const,
  contentBinding: { baseSourceResultId: "40000000-0000-4000-8000-000000000001", operationId: null },
};
const videoPlaceholder = {
  ...placement, id: "30000000-0000-4000-8000-000000000006", kind: "upload" as const,
  upload: { uploadId: UPLOAD, name: "beach.mp4", kind: "video" as const, durationSeconds: 2.5 },
};
const imagePlaceholder = {
  ...placement, id: "30000000-0000-4000-8000-000000000007", kind: "upload" as const, durationFrames: 120,
  upload: { uploadId: UPLOAD, name: "beach.png", kind: "image" as const, durationSeconds: null },
};
const audioPlaceholder = {
  ...placement, id: "30000000-0000-4000-8000-000000000008", kind: "upload" as const,
  upload: { uploadId: UPLOAD, name: "song.mp3", kind: "audio" as const, durationSeconds: 2.5 },
};

/**
 * Whether the clip union accepts a value.
 * @param value - The candidate clip.
 * @returns Whether it parses.
 * @throws {never} Never.
 */
function clipAccepts(value: unknown): boolean {
  return TimelineClipSchema.safeParse(value).success;
}

describe("version 3 (design §2.1)", () => {
  it("accepts versions 1, 2 and 3", () => {
    expect([...TIMELINE_SCHEMA_VERSIONS]).toEqual([1, 2, 3]);
  });
});

describe("tracks have no kind (design §2.1)", () => {
  it("accepts a track of id and order", () => {
    expect(TimelineTrackSchema.parse({ id: "visual-2", order: 1 })).toEqual({ id: "visual-2", order: 1 });
  });

  it("refuses a track record carrying a kind, which reading strips first", () => {
    expect(TimelineTrackSchema.safeParse({ id: "visual-2", kind: "visual", order: 1 }).success).toBe(false);
  });
});

describe("sources are a union of video, image and audio (design §2.2)", () => {
  it("accepts an image source with a measured size, alone and through the union", () => {
    expect(TimelineImageSourceSchema.parse(imageSource)).toEqual(imageSource);
    expect(TimelineSourceSchema.parse(imageSource)).toEqual(imageSource);
  });

  it("accepts an image source whose width and height are both null", () => {
    const unmeasured = { ...imageSource, width: null, height: null };
    expect(TimelineSourceSchema.parse(unmeasured)).toEqual(unmeasured);
  });

  it.each([
    ["a zero width", { width: 0 }],
    ["a fractional height", { height: 1.5 }],
    ["a negative width", { width: -800 }],
    ["only the width null", { width: null }],
    ["only the height null", { height: null }],
    ["a duration, which a picture has none of", { durationSeconds: "2" }],
    ["a timebase", { timebase: fps }],
    ["an asset id, which inner#2171 replaced by the address", { assetId: "20000000-0000-4000-8000-000000000001" }],
    ["an address that is not a URL", { url: "beach.png" }],
    ["no address", { url: undefined }],
    ["an empty name", { name: "" }],
    ["a name of 256 characters", { name: "a".repeat(256) }],
    ["a type that is not a picture", { mimeType: "video/mp4" }],
    ["a cover, which a picture has none of", { coverUrl: null }],
  ])("refuses an image source with %s", (_case, fields) => {
    expect(TimelineImageSourceSchema.safeParse({ ...imageSource, ...fields }).success).toBe(false);
    expect(TimelineSourceSchema.safeParse({ ...imageSource, ...fields }).success).toBe(false);
  });

  it("accepts an audio source measured like a video, alone and through the union", () => {
    expect(TimelineAudioSourceSchema.parse(audioSource)).toEqual(audioSource);
    expect(TimelineSourceSchema.parse(audioSource)).toEqual(audioSource);
  });

  it.each([
    ["an asset id, which inner#2171 replaced by the address", { assetId: "20000000-0000-4000-8000-000000000001" }],
    ["an address that is not a URL", { url: "song.mp3" }],
    ["a type that is not a sound", { mimeType: "video/mp4" }],
    ["a cover or a size, which a sound has none of", { coverUrl: null, width: 1, height: 1 }],
  ])("refuses an audio source with %s", (_case, fields) => {
    expect(TimelineAudioSourceSchema.safeParse({ ...audioSource, ...fields }).success).toBe(false);
    expect(TimelineSourceSchema.safeParse({ ...audioSource, ...fields }).success).toBe(false);
  });

  it("refuses an audio source whose duration does not conform to its extent", () => {
    expect(TimelineAudioSourceSchema.safeParse({ ...audioSource, extentFrames: 61 }).success).toBe(false);
    expect(TimelineSourceSchema.safeParse({ ...audioSource, extentFrames: 61 }).success).toBe(false);
  });

  it("still accepts a video source through the union", () => {
    expect(TimelineSourceSchema.parse(videoSource)).toEqual(videoSource);
  });

  it("refuses a source of any other kind", () => {
    expect(TimelineSourceSchema.safeParse(imageSource).success).toBe(true);
    expect(TimelineSourceSchema.safeParse({ ...imageSource, kind: "text" }).success).toBe(false);
  });
});

describe("image and audio clips (design §2.3)", () => {
  it("accepts an image clip, alone and through the union", () => {
    expect(TimelineImageClipSchema.parse(imageClip)).toEqual(imageClip);
    expect(TimelineClipSchema.parse(imageClip)).toEqual(imageClip);
  });

  it("refuses an image clip whose in-point is not 0", () => {
    expect(TimelineImageClipSchema.safeParse({ ...imageClip, sourceInFrame: 1 }).success).toBe(false);
    expect(clipAccepts({ ...imageClip, sourceInFrame: 1 })).toBe(false);
  });

  it("refuses an image clip without its sourceId", () => {
    const { sourceId: _sourceId, ...bare } = imageClip;
    expect(clipAccepts(imageClip)).toBe(true);
    expect(clipAccepts(bare)).toBe(false);
  });

  it("accepts an audio clip with an in-point, alone and through the union", () => {
    expect(TimelineAudioClipSchema.parse(audioClip)).toEqual(audioClip);
    expect(TimelineClipSchema.parse(audioClip)).toEqual(audioClip);
  });
});

describe("text clips (design §2.3)", () => {
  it("accepts a text clip, alone and through the union", () => {
    expect(TimelineTextClipSchema.parse(textClip)).toEqual(textClip);
    expect(TimelineClipSchema.parse(textClip)).toEqual(textClip);
  });

  it("keeps the body exactly as typed, markup and line breaks included", () => {
    const raw = { ...textClip, text: { body: "<b>Title</b>\n  second line  ", size: 0.06 } };
    expect(TimelineClipSchema.parse(raw)).toEqual(raw);
  });

  it("accepts a body of 1 and of 2000 characters", () => {
    expect(clipAccepts({ ...textClip, text: { body: "a", size: 0.06 } })).toBe(true);
    expect(clipAccepts({ ...textClip, text: { body: "a".repeat(2000), size: 0.06 } })).toBe(true);
  });

  it("refuses an empty body and a body of 2001 characters", () => {
    expect(clipAccepts(textClip)).toBe(true);
    expect(clipAccepts({ ...textClip, text: { body: "", size: 0.06 } })).toBe(false);
    expect(clipAccepts({ ...textClip, text: { body: "a".repeat(2001), size: 0.06 } })).toBe(false);
  });

  it("accepts a size of 0.01 and of 0.5 of the frame height", () => {
    expect(clipAccepts({ ...textClip, text: { body: "Hello", size: 0.01 } })).toBe(true);
    expect(clipAccepts({ ...textClip, text: { body: "Hello", size: 0.5 } })).toBe(true);
  });

  it.each([0, 0.0099, 0.501, -0.06, Number.POSITIVE_INFINITY, Number.NaN])("refuses a size of %s", (size) => {
    expect(clipAccepts(textClip)).toBe(true);
    expect(clipAccepts({ ...textClip, text: { body: "Hello", size } })).toBe(false);
  });

  it("refuses a stored font or style, which every text clip takes from the shared constants", () => {
    expect(clipAccepts(textClip)).toBe(true);
    expect(clipAccepts({ ...textClip, text: { body: "Hello", size: 0.06, fontFamily: "Inter" } })).toBe(false);
  });

  it("refuses a text clip whose in-point is not 0", () => {
    expect(TimelineTextClipSchema.safeParse({ ...textClip, sourceInFrame: 1 }).success).toBe(false);
    expect(clipAccepts({ ...textClip, sourceInFrame: 1 })).toBe(false);
  });

  it("refuses a sourceId on a text clip and a text clip without its text", () => {
    expect(clipAccepts(textClip)).toBe(true);
    expect(clipAccepts({ ...textClip, sourceId: VIDEO_SOURCE })).toBe(false);
    const { text: _text, ...bare } = textClip;
    expect(clipAccepts(bare)).toBe(false);
  });
});

describe("gain is capped at +12 dB (design §2.3)", () => {
  it("is 10^(12/20), the HyperFrames export cap", () => {
    expect(TIMELINE_MAX_GAIN).toBe(10 ** (12 / 20));
    expect(TIMELINE_MAX_GAIN).toBeCloseTo(3.981, 3);
  });

  it.each([
    ["video", videoClip],
    ["audio", audioClip],
    ["image", imageClip],
    ["text", textClip],
  ])("accepts a %s clip with gain 0 and gain at the cap, and refuses one past it", (_kind, clip) => {
    expect(clipAccepts({ ...clip, gain: 0 })).toBe(true);
    expect(clipAccepts({ ...clip, gain: TIMELINE_MAX_GAIN })).toBe(true);
    expect(clipAccepts({ ...clip, gain: TIMELINE_MAX_GAIN + 0.001 })).toBe(false);
    expect(clipAccepts({ ...clip, gain: -0.001 })).toBe(false);
  });

  it("refuses a video clip past the cap through its own schema", () => {
    expect(TimelineVideoClipSchema.safeParse({ ...videoClip, gain: 4 }).success).toBe(false);
  });
});

describe("upload placeholders name what they will become (design §2.3)", () => {
  it.each([
    ["video", videoPlaceholder],
    ["image", imagePlaceholder],
    ["audio", audioPlaceholder],
  ])("accepts a %s placeholder, alone and through the union", (_kind, clip) => {
    expect(TimelineUploadClipSchema.parse(clip)).toEqual(clip);
    expect(TimelineClipSchema.parse(clip)).toEqual(clip);
  });

  it("refuses a placeholder without upload.kind", () => {
    const { kind: _kind, ...upload } = videoPlaceholder.upload;
    expect(TimelineUploadClipSchema.safeParse({ ...videoPlaceholder, upload }).success).toBe(false);
  });

  it("refuses a placeholder that would become text or a web animation", () => {
    expect(clipAccepts(videoPlaceholder)).toBe(true);
    for (const kind of ["text", "web-animation"]) {
      expect(clipAccepts({ ...videoPlaceholder, upload: { ...videoPlaceholder.upload, kind } })).toBe(false);
    }
  });

  it("refuses a picture placeholder with a duration, and a video or audio placeholder without one", () => {
    for (const clip of [imagePlaceholder, videoPlaceholder, audioPlaceholder]) expect(clipAccepts(clip)).toBe(true);
    expect(clipAccepts({ ...imagePlaceholder, upload: { ...imagePlaceholder.upload, durationSeconds: 5 } })).toBe(false);
    expect(clipAccepts({ ...videoPlaceholder, upload: { ...videoPlaceholder.upload, durationSeconds: null } })).toBe(false);
    expect(clipAccepts({ ...audioPlaceholder, upload: { ...audioPlaceholder.upload, durationSeconds: null } })).toBe(false);
  });

  it("refuses a picture placeholder whose in-point is not 0, and accepts a trimmed video or audio placeholder", () => {
    expect(clipAccepts({ ...imagePlaceholder, sourceInFrame: 3 })).toBe(false);
    expect(clipAccepts({ ...videoPlaceholder, sourceInFrame: 3 })).toBe(true);
    expect(clipAccepts({ ...audioPlaceholder, sourceInFrame: 3 })).toBe(true);
  });

  it("accepts the states collab writes", () => {
    const processing = { ...videoPlaceholder, upload: { ...videoPlaceholder.upload, state: "processing" } };
    const failed = { ...imagePlaceholder, upload: { ...imagePlaceholder.upload, state: "failed", failure: "unsupportedType", retryable: false } };
    expect(TimelineClipSchema.parse(processing)).toEqual(processing);
    expect(TimelineClipSchema.parse(failed)).toEqual(failed);
  });

  it.each([
    ["a completed state", { state: "completed" }],
    ["a failure outside the Document vocabulary", { state: "failed", failure: "timeout", retryable: true }],
    ["a retryable flag written as text", { state: "failed", failure: "failed", retryable: "false" }],
  ])("refuses %s", (_case, fields) => {
    expect(clipAccepts(videoPlaceholder)).toBe(true);
    expect(clipAccepts({ ...videoPlaceholder, upload: { ...videoPlaceholder.upload, ...fields } })).toBe(false);
  });
});

describe("a version 3 document holding every kind (design §2)", () => {
  it("parses tracks without kind, every source kind and every clip kind", () => {
    const document = {
      schemaVersion: 3,
      settings,
      tracks: { "visual-1": { id: "visual-1", order: 0 }, "visual-2": { id: "visual-2", order: 1 } },
      sources: { [VIDEO_SOURCE]: videoSource, [IMAGE_SOURCE]: imageSource, [AUDIO_SOURCE]: audioSource },
      clips: Object.fromEntries([videoClip, imageClip, audioClip, textClip, webClip, videoPlaceholder, imagePlaceholder, audioPlaceholder]
        .map((clip) => [clip.id, clip])),
    };
    expect(TimelineDocumentV1Schema.parse(document)).toEqual(document);
  });
});

describe("isPresentableTimelineClip (design §2.4, §3.5)", () => {
  const document = {
    schemaVersion: 3,
    settings,
    tracks: { "visual-1": { id: "visual-1", order: 0 }, "visual-2": { id: "visual-2", order: 1 } },
    sources: { [VIDEO_SOURCE]: videoSource, [IMAGE_SOURCE]: imageSource, [AUDIO_SOURCE]: audioSource },
    clips: {},
  } as unknown as TimelineDocumentV1;
  const gone = { trackId: "visual-9" };

  it.each<[string, boolean, unknown]>([
    ["a text clip on an existing track", true, textClip],
    ["a web-animation clip on an existing track", true, { ...webClip, trackId: "visual-2" }],
    ["a video placeholder on an existing track", true, videoPlaceholder],
    ["a picture placeholder on an existing track", true, imagePlaceholder],
    ["a video clip whose video source is present", true, videoClip],
    ["an image clip whose image source is present", true, imageClip],
    ["an audio clip whose audio source is present", true, audioClip],
    ["a text clip on a deleted track", false, { ...textClip, ...gone }],
    ["a web-animation clip on a deleted track", false, { ...webClip, ...gone }],
    ["a placeholder on a deleted track", false, { ...videoPlaceholder, ...gone }],
    ["a video clip on a deleted track with its source present", false, { ...videoClip, ...gone }],
    ["a video clip whose source record is missing", false, { ...videoClip, sourceId: MISSING_SOURCE }],
    ["an image clip whose source record is missing", false, { ...imageClip, sourceId: MISSING_SOURCE }],
    ["an audio clip whose source record is missing", false, { ...audioClip, sourceId: MISSING_SOURCE }],
    ["a video clip naming an image source", false, { ...videoClip, sourceId: IMAGE_SOURCE }],
    ["an image clip naming an audio source", false, { ...imageClip, sourceId: AUDIO_SOURCE }],
    ["an audio clip naming a video source", false, { ...audioClip, sourceId: VIDEO_SOURCE }],
  ])("answers %s: %s", (_case, expected, clip) => {
    expect(isPresentableTimelineClip(document, clip as TimelineClip)).toBe(expected);
  });
});
