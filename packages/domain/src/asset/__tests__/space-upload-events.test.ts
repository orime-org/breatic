// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the backend tells a Space document's upload placeholder about its upload: a Document body block
 * (breatic#1574) or a Timeline upload clip (inner#1709 design §4.1, §4.2). The grant records which of the two the
 * page named, and the event type and document name follow it.
 *
 * The stream client is a double that records every entry, and core's own publishing runs on it, so the cases read
 * what would reach collab whatever core helper the code publishes through.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type * as core from "@breatic/core";

const stream = vi.hoisted(() => ({ entries: [] as unknown[][] }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  getStreamRedis: vi.fn(() => ({
    xadd: vi.fn(async (...args: unknown[]) => {
      stream.entries.push(args);
      return "1-0";
    }),
  })),
}));

const { initCore } = await import("@breatic/core");
const {
  announceSpaceUploadAsset,
  announceSpaceUploadFailure,
  announceSpaceUploadProcessing,
  spaceUploadTargetOf,
} = await import("@domain/asset/space-upload-events.js");

const ASSET_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const DOCUMENT = { target: "document" as const, projectId: "p", spaceId: "s", uploadId: "u1" };
const TIMELINE = { target: "timeline" as const, projectId: "p", spaceId: "s", uploadId: "u1" };

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by another file in this process.
  }
});

beforeEach(() => {
  stream.entries = [];
});

/**
 * The payloads published so far, in order.
 * @returns Each entry's parsed `payload` field.
 */
function published(): unknown[] {
  return stream.entries.map((args) => {
    const at = args.indexOf("payload");
    return JSON.parse(String(args[at + 1]));
  });
}

describe("which Space placeholder a grant names (inner#1709 design §4.1)", () => {
  it("names no placeholder for a grant without an upload id", () => {
    expect(spaceUploadTargetOf({ projectId: "p", spaceId: "s", spaceUploadId: null, spaceUploadTarget: null })).toBeNull();
  });

  it("names no placeholder for a grant without a Project or a Space", () => {
    expect(spaceUploadTargetOf({ projectId: null, spaceId: "s", spaceUploadId: "u1", spaceUploadTarget: "timeline" })).toBeNull();
    expect(spaceUploadTargetOf({ projectId: "p", spaceId: null, spaceUploadId: "u1", spaceUploadTarget: "timeline" })).toBeNull();
  });

  it("names the Timeline clip or the Document block the grant recorded", () => {
    expect(spaceUploadTargetOf({ projectId: "p", spaceId: "s", spaceUploadId: "u1", spaceUploadTarget: "timeline" })).toEqual(TIMELINE);
    expect(spaceUploadTargetOf({ projectId: "p", spaceId: "s", spaceUploadId: "u1", spaceUploadTarget: "document" })).toEqual(DOCUMENT);
  });
});

describe("a Document block's upload (breatic#1574)", () => {
  it("hands the block a picture, a video or a sound with its address and size", async () => {
    await announceSpaceUploadAsset(DOCUMENT, {
      id: ASSET_ID, kind: "image", fileUrl: "https://cdn/a.png", width: 8, height: 6, durationSeconds: null,
    });
    expect(published()).toEqual([{
      type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "completed",
      result: { url: "https://cdn/a.png", mediaWidth: 8, mediaHeight: 6 },
    }]);
  });

  it("fails the block when the upload resolved to something that is not a medium", async () => {
    await announceSpaceUploadAsset(DOCUMENT, {
      id: ASSET_ID, kind: "document", fileUrl: "https://cdn/a.pdf", width: null, height: null, durationSeconds: null,
    });
    expect(published()).toEqual([{
      type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "failed", reason: "unsupported_type",
    }]);
  });

  it("tells the block the cause a raw failure normalises to, and no cause for one it does not know", async () => {
    await announceSpaceUploadFailure(DOCUMENT, "unsupported_type");
    await announceSpaceUploadFailure(DOCUMENT, "not a code of ours");
    expect(published()).toEqual([
      { type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "failed", reason: "unsupported_type" },
      { type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "failed" },
    ]);
  });

  it("tells the block its bytes were handed over", async () => {
    await announceSpaceUploadProcessing(DOCUMENT);
    expect(published()).toEqual([{ type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "processing" }]);
  });
});

describe("a Timeline upload clip's upload (inner#1709 design §4.2)", () => {
  it("tells the clip its bytes were handed over, on the Timeline's document", async () => {
    await announceSpaceUploadProcessing(TIMELINE);
    expect(published()).toEqual([{ type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "processing" }]);
  });

  it("hands the clip a registered video with its asset, length and size", async () => {
    await announceSpaceUploadAsset(TIMELINE, {
      id: ASSET_ID, kind: "video", fileUrl: "https://cdn/a.mp4", width: 1280, height: 720, durationSeconds: 7.375,
    });
    expect(published()).toEqual([{
      type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "completed",
      result: { assetId: ASSET_ID, kind: "video", durationSeconds: 7.375, width: 1280, height: 720 },
    }]);
  });

  it("hands the clip a registered picture with no length, and a sound with no size", async () => {
    await announceSpaceUploadAsset(TIMELINE, {
      id: ASSET_ID, kind: "image", fileUrl: "https://cdn/a.png", width: 8, height: 6, durationSeconds: null,
    });
    await announceSpaceUploadAsset(TIMELINE, {
      id: ASSET_ID, kind: "audio", fileUrl: "https://cdn/a.mp3", width: null, height: null, durationSeconds: 3.5,
    });
    expect(published()).toEqual([
      {
        type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "completed",
        result: { assetId: ASSET_ID, kind: "image", durationSeconds: null, width: 8, height: 6 },
      },
      {
        type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "completed",
        result: { assetId: ASSET_ID, kind: "audio", durationSeconds: 3.5, width: null, height: null },
      },
    ]);
  });

  it("fails the clip with unsupported_type when the upload resolved to something that is not a video, a picture or a sound", async () => {
    await announceSpaceUploadAsset(TIMELINE, {
      id: ASSET_ID, kind: "document", fileUrl: "https://cdn/a.pdf", width: null, height: null, durationSeconds: null,
    });
    expect(published()).toEqual([{
      type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "failed", reason: "unsupported_type",
    }]);
  });

  it("tells the clip the cause a raw failure normalises to, and no cause for one it does not know", async () => {
    await announceSpaceUploadFailure(TIMELINE, "unsupported_type");
    await announceSpaceUploadFailure(TIMELINE, "not a code of ours");
    expect(published()).toEqual([
      { type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "failed", reason: "unsupported_type" },
      { type: "timeline-upload", docName: "project-p/timeline-s", uploadId: "u1", state: "failed" },
    ]);
  });
});
