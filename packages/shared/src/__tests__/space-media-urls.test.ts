// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Space documents keep media as URLs with their media facts, as canvas nodes do (inner#2171 design §3): a Timeline
 * video source and a 3D model or part picture carry no asset id, a record in the old id format reads as damaged
 * without throwing or writing, and backfill reads media only from canvas and Document content.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { SceneLookMapSchema, SceneModelSchema } from "../scene.js";
import { SCENE_FORMAT_VERSION } from "../scene-version.js";
import { readSpaceMediaReferences } from "../space-media-references.js";
import { attachTimelineRecord, initializeTimelineDocument, readTimelineContent } from "../timeline/document.js";
import { TIMELINE_SCHEMA_VERSIONS, TimelineVideoSourceSchema } from "../timeline/schema.js";
import { durationToFrames } from "../timeline/time.js";
import { WebAnimationRowViewSchema } from "../timeline/web-animation.js";

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const VIDEO_URL = "https://cdn.example.com/assets/beach.mp4";
const COVER_URL = "https://cdn.example.com/assets/beach.jpg";
const ASSET = "22222222-2222-4222-8222-222222222222";

const newSource = {
  id: "50000000-0000-4000-8000-000000000001",
  kind: "video",
  url: VIDEO_URL,
  coverUrl: COVER_URL,
  name: "beach.mp4",
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  timebase: { num: 24, den: 1 },
  extentFrames: 48,
  durationSeconds: "2",
  durationOrigin: "registered",
} as const;

const oldSource = {
  id: "50000000-0000-4000-8000-000000000002",
  kind: "video",
  assetId: ASSET,
  timebase: { num: 24, den: 1 },
  extentFrames: 48,
  durationSeconds: "2",
  durationOrigin: "registered",
} as const;

const glb = { kind: "asset", url: "https://cdn.example.com/assets/figure.glb", mimeType: "model/gltf-binary", sizeBytes: 1024 } as const;

describe("Timeline video source schema (inner#2171 design §3.1)", () => {
  it("accepts a source stored by URL with its media facts", () => {
    expect(TimelineVideoSourceSchema.safeParse(newSource).success).toBe(true);
  });

  it("accepts null cover, width and height", () => {
    expect(TimelineVideoSourceSchema.safeParse({ ...newSource, coverUrl: null, width: null, height: null }).success).toBe(true);
  });

  it("rejects a source that also carries an asset id", () => {
    expect(TimelineVideoSourceSchema.safeParse({ ...newSource, assetId: ASSET }).success).toBe(false);
  });

  it("rejects a source in the old id format", () => {
    expect(TimelineVideoSourceSchema.safeParse(oldSource).success).toBe(false);
  });

  it.each(["url", "name", "mimeType", "coverUrl", "width", "height"])("rejects a source without %s", (key) => {
    const { [key as keyof typeof newSource]: _dropped, ...rest } = newSource;
    expect(TimelineVideoSourceSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ["a url that is not a URL", { url: "beach.mp4" }],
    ["a cover that is not a URL", { coverUrl: "beach.jpg" }],
    ["an empty name", { name: "" }],
    ["a name over 255 characters", { name: "a".repeat(256) }],
    ["a mime type that is not a video", { mimeType: "image/png" }],
    ["a zero width", { width: 0 }],
    ["a fractional height", { height: 10.5 }],
  ])("rejects %s", (_label, patch) => {
    expect(TimelineVideoSourceSchema.safeParse({ ...newSource, ...patch }).success).toBe(false);
  });

  it("rejects an extent that disagrees with the duration", () => {
    expect(TimelineVideoSourceSchema.safeParse({ ...newSource, extentFrames: 47 }).success).toBe(false);
  });

  it("accepts every well-formed source and rejects each with an asset id or without a url", () => {
    const rate = fc.record({ num: fc.integer({ min: 1, max: 120_000 }), den: fc.integer({ min: 1, max: 1001 }) });
    const source = fc.record({
      id: fc.uuid(),
      url: fc.webUrl({ validSchemes: ["https"] }),
      coverUrl: fc.option(fc.webUrl({ validSchemes: ["https"] }), { nil: null }),
      name: fc.string({ minLength: 1, maxLength: 255 }),
      mimeType: fc.constantFrom("video/mp4", "video/webm", "video/quicktime"),
      width: fc.option(fc.integer({ min: 1, max: 8192 }), { nil: null }),
      height: fc.option(fc.integer({ min: 1, max: 8192 }), { nil: null }),
      timebase: rate,
      millis: fc.integer({ min: 1, max: 3_600_000 }),
    }).map(({ millis, timebase, ...rest }) => {
      const durationSeconds = String(millis / 1000);
      return { ...rest, kind: "video" as const, timebase, durationSeconds, extentFrames: durationToFrames(durationSeconds, timebase), durationOrigin: "registered" as const };
    }).filter((value) => value.extentFrames > 0);
    fc.assert(fc.property(source, fc.uuid(), (value, assetId) => {
      expect(TimelineVideoSourceSchema.safeParse(value).success).toBe(true);
      expect(TimelineVideoSourceSchema.safeParse({ ...value, assetId }).success).toBe(false);
      const { url: _url, ...withoutUrl } = value;
      expect(TimelineVideoSourceSchema.safeParse(withoutUrl).success).toBe(false);
    }), { numRuns: 100 });
  });
});

describe("3D model and part picture schemas (inner#2171 design §3.2)", () => {
  it.each([glb, { ...glb, url: "https://cdn.example.com/assets/rig.zip", mimeType: "application/zip" }])(
    "accepts an imported model stored by URL, type and size ($mimeType)", (model) => {
      expect(SceneModelSchema.safeParse(model).success).toBe(true);
    },
  );

  it.each([
    ["an extra asset id", { ...glb, assetId: ASSET }],
    ["another media type", { ...glb, mimeType: "image/png" }],
    ["a zero size", { ...glb, sizeBytes: 0 }],
    ["a negative size", { ...glb, sizeBytes: -1 }],
    ["a fractional size", { ...glb, sizeBytes: 1.5 }],
    ["a url that is not a URL", { ...glb, url: "figure.glb" }],
    ["the old id format", { kind: "asset", assetId: ASSET }],
  ])("rejects a model with %s", (_label, model) => {
    expect(SceneModelSchema.safeParse(model).success).toBe(false);
  });

  it.each([{ kind: "builtin", id: "figure" }, { kind: "camera" }, { kind: "light", type: "spot" }])(
    "still accepts a $kind model", (model) => {
      expect(SceneModelSchema.safeParse(model).success).toBe(true);
    },
  );

  it.each(["https://cdn.example.com/assets/wood.png", "none"])("accepts the part picture %s", (map) => {
    expect(SceneLookMapSchema.safeParse(map).success).toBe(true);
  });

  it.each([ASSET, "", "wood.png"])("rejects the part picture %j", (map) => {
    expect(SceneLookMapSchema.safeParse(map).success).toBe(false);
  });

  it("rejects any picture written as an id and accepts any URL", () => {
    fc.assert(fc.property(fc.uuid(), fc.webUrl({ validSchemes: ["https"] }), (id, url) => {
      expect(SceneLookMapSchema.safeParse(id).success).toBe(false);
      expect(SceneLookMapSchema.safeParse(url).success).toBe(true);
    }), { numRuns: 100 });
  });
});

describe("old-format documents (inner#2171 design §3, acceptance 6)", () => {
  /**
   * Build a Timeline with old and new sources, a clip on each, an upload placeholder and a Motion clip.
   * @returns The document.
   */
  function mixedTimeline(): Y.Doc {
    const doc = new Y.Doc();
    initializeTimelineDocument(doc, settings);
    const second = { ...oldSource, id: "50000000-0000-4000-8000-000000000003" };
    for (const source of [newSource, oldSource, second]) attachTimelineRecord(doc.getMap("sources"), source.id, source);
    const placement = { trackId: "main", startFrame: 0, sourceInFrame: 0, durationFrames: 24, rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
    [newSource.id, oldSource.id, second.id].forEach((sourceId, index) => {
      const id = `60000000-0000-4000-8000-00000000000${index + 1}`;
      attachTimelineRecord(doc.getMap("clips"), id, { ...placement, id, kind: "video", sourceId, startFrame: index * 24 });
    });
    const uploadId = "60000000-0000-4000-8000-000000000004";
    attachTimelineRecord(doc.getMap("clips"), uploadId, { ...placement, id: uploadId, kind: "upload", startFrame: 72, upload: { uploadId: "b0000000-0000-4000-8000-000000000001", name: "clip.mov", durationSeconds: 1 } });
    const motionId = "60000000-0000-4000-8000-000000000005";
    attachTimelineRecord(doc.getMap("clips"), motionId, { ...placement, id: motionId, kind: "web-animation", startFrame: 96, contentBinding: { baseSourceResultId: ASSET, operationId: null } });
    return doc;
  }

  it("reads only the new sources and keeps every clip", () => {
    const { document, damaged } = readTimelineContent(mixedTimeline());
    expect(Object.keys(document.sources)).toEqual([newSource.id]);
    expect(Object.keys(document.clips)).toHaveLength(5);
    expect(damaged.clips).toEqual([]);
  });

  it("does not write the document while reading it", () => {
    const doc = mixedTimeline();
    const before = Y.encodeStateAsUpdate(doc);
    readTimelineContent(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("keeps the format versions", () => {
    expect(SCENE_FORMAT_VERSION).toBe(2);
    expect([...TIMELINE_SCHEMA_VERSIONS]).toEqual([1, 2]);
  });
});

describe("backfill reads only canvas and Document (inner#2171 design §5.5)", () => {
  it("reads nothing from a Timeline, new or old", () => {
    const doc = new Y.Doc();
    initializeTimelineDocument(doc, settings);
    attachTimelineRecord(doc.getMap("sources"), newSource.id, newSource);
    attachTimelineRecord(doc.getMap("sources"), oldSource.id, oldSource);
    expect(readSpaceMediaReferences("timeline", doc)).toEqual({ urls: [] });
  });

  it("reads nothing from a scene, new or old", () => {
    const doc = new Y.Doc();
    const objects = doc.getMap("objects");
    const fresh = new Y.Map<unknown>();
    objects.set("a", fresh);
    fresh.set("model", glb);
    fresh.set("look.0.map", "https://cdn.example.com/assets/wood.png");
    const stale = new Y.Map<unknown>();
    objects.set("b", stale);
    stale.set("model", { kind: "asset", assetId: ASSET });
    stale.set("look.0.map", ASSET);
    expect(readSpaceMediaReferences("3d", doc)).toEqual({ urls: [] });
  });
});

describe("Motion execution row view (inner#2171 design §4)", () => {
  const FPS = { num: 24, den: 1 };
  const row = {
    kind: "web_animation_export",
    id: "70000000-0000-4000-8000-000000000001",
    spaceId: "70000000-0000-4000-8000-000000000002",
    status: "succeeded",
    phase: null,
    failureReason: null,
    ownProject: true,
    usageCredits: 0,
    createdAt: "2026-11-26T00:00:00.000000Z",
    resultSourceVersionId: null,
    actorUserId: "70000000-0000-4000-8000-000000000003",
    slotWaitSince: null,
    slotWaitLimit: null,
    progress: null,
    input: { sourceVersionId: "70000000-0000-4000-8000-000000000004", width: 1080, height: 1920, fps: FPS, durationFrames: 144, videoKey: "generated/2026/11/26/v.mp4" },
    source: { executionId: "70000000-0000-4000-8000-000000000005", request: "A logo" },
  };
  const resultAsset = { url: VIDEO_URL, coverUrl: COVER_URL, width: 1920, height: 1080, durationSeconds: 4, mimeType: "video/mp4", sizeBytes: 2048 };

  it("carries the export result as a URL with its media facts", () => {
    expect(WebAnimationRowViewSchema.parse({ ...row, resultAsset })).toEqual({ ...row, resultAsset });
  });

  it("accepts a row without a result", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...row, resultAsset: null }).success).toBe(true);
  });

  it("rejects a row that still names the result by asset id", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...row, resultAsset: null, resultAssetId: ASSET }).success).toBe(false);
  });
});
