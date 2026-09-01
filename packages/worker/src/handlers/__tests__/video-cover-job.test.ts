// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * runVideoCover — what happens after a video upload is registered (#173, design §5.3).
 *
 * The video is already in the ledger by the time this job exists; the server
 * wrote it when the ingest report arrived. So the cover's fate never changes
 * the video's: an extraction that fails still ends with the node showing the
 * video, just without a cover.
 *
 * The three things this pins:
 *
 *   - the cover's URL is the REGISTERED canonical, never the object just
 *     uploaded — a dedup hit resolves to a different row, and pinning the
 *     fresh key would point the node at an object the reclaim job removes;
 *   - the node hears about the video and its cover in ONE event, because two
 *     would put a cover-less video on screen first;
 *   - a publish failure fails the job, so BullMQ retries it. The node is in
 *     handling until something says otherwise, and swallowing the failure
 *     leaves it there.
 *
 * No real Redis / DB / storage — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPublicUrl = vi.hoisted(() => vi.fn((key: string) => `https://cdn/${key}`));
const mockGetStorageAdapter = vi.hoisted(() => vi.fn());
const mockExtract = vi.hoisted(() => vi.fn());
const mockRegister = vi.hoisted(() => vi.fn());
const mockSetCover = vi.hoisted(() => vi.fn());
const mockFindCoverOf = vi.hoisted(() => vi.fn());
const mockRecordUpload = vi.hoisted(() => vi.fn());
const mockEmitDone = vi.hoisted(() => vi.fn());
const mockActivityInsert = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: mockGetStorageAdapter,
  getStreamRedis: vi.fn(() => ({})),
  projectActivitiesRepo: { insert: mockActivityInsert },
  publishActivityNew: mockPublishActivity,
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  assetService: { register: mockRegister },
  assetRepo: { setCoverAsset: mockSetCover, findCoverOf: mockFindCoverOf },
  nodeHistoryService: { recordUpload: mockRecordUpload },
  emitNodeStateDone: mockEmitDone,
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));
vi.mock("@worker/providers/video-cover.js", () => ({
  extractVideoCover: mockExtract,
}));

import { runVideoCover } from "@worker/handlers/video-cover-job.js";
import type { VideoCoverJobData } from "@breatic/domain";

/** What the extractor uploads: `key` is the object it just stored. */
const EXTRACTED = {
  url: "https://cdn/image/fresh_cover.png",
  key: "image/fresh_cover.png",
  sha256: "c".repeat(64),
  sizeBytes: 2048,
  mimeType: "image/png",
};

/** The registered row a dedup hit resolves to — a DIFFERENT stored object. */
const REGISTERED_COVER = {
  id: "cover-row-1",
  storageKey: "image/existing_cover.png",
  fileUrl: "https://cdn/image/existing_cover.png",
  kind: "image" as const,
};

const DATA: VideoCoverJobData = {
  storageKey: "uploads/abc.mp4",
  videoAssetId: "video-row-1",
  videoUrl: "https://cdn/uploads/registered.mp4",
  ownerStudioId: "studio-1",
  userId: "user-1",
  projectId: "proj-1",
  spaceId: "space-1",
  nodeId: "node-1",
  leaseGen: 4,
  sizeBytes: 999,
  mimeType: "video/mp4",
  filename: "clip.mp4",
  source: "upload",
  toolName: null,
};

/** The one argument runVideoCover reads off a BullMQ job. */
function job(overrides: Partial<VideoCoverJobData> = {}): { data: VideoCoverJobData } {
  return { data: { ...DATA, ...overrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStorageAdapter.mockResolvedValue({ publicUrl: mockPublicUrl });
  mockExtract.mockResolvedValue(EXTRACTED);
  mockRegister.mockResolvedValue({ asset: REGISTERED_COVER, deduped: true });
  mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: true });
  mockEmitDone.mockResolvedValue(undefined);
  mockFindCoverOf.mockResolvedValue(null);
});

describe("a cover that comes out", () => {
  it("registers it as the video's studio's own image asset", async () => {
    await runVideoCover(job());

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0]![0]).toMatchObject({
      ownerStudioId: "studio-1",
      projectId: "proj-1",
      actingUserId: "user-1",
      contentHash: EXTRACTED.sha256,
      storageKey: EXTRACTED.key,
      sizeBytes: EXTRACTED.sizeBytes,
      mimeType: EXTRACTED.mimeType,
      kind: "image",
      source: "cover",
    });
  });

  it("writes the cover's row id back onto the video", async () => {
    await runVideoCover(job());

    expect(mockSetCover).toHaveBeenCalledWith("video-row-1", "cover-row-1");
  });

  it("pins the registered canonical, not the object just uploaded", async () => {
    await runVideoCover(job());

    const emitted = mockEmitDone.mock.calls[0]!;
    expect(emitted[3].coverUrl).toBe(`https://cdn/${REGISTERED_COVER.storageKey}`);
    expect(emitted[3].coverUrl).not.toContain(EXTRACTED.key);
  });

  it("tells the node about the video and its cover in one event", async () => {
    await runVideoCover(job());

    expect(mockEmitDone).toHaveBeenCalledTimes(1);
    const [, docName, nodeId, fields, gen] = mockEmitDone.mock.calls[0]!;
    expect(docName).toBe("project-proj-1/canvas-space-1");
    expect(nodeId).toBe("node-1");
    expect(fields.content).toBe(DATA.videoUrl);
    expect(fields.coverUrl).toBe(`https://cdn/${REGISTERED_COVER.storageKey}`);
    expect(gen).toBe(4);
  });

  it("records the upload under the granted key, carrying the cover", async () => {
    await runVideoCover(job());

    expect(mockRecordUpload).toHaveBeenCalledWith({
      projectId: "proj-1",
      nodeId: "node-1",
      userId: "user-1",
      content: DATA.videoUrl,
      thumbnailUrl: `https://cdn/${REGISTERED_COVER.storageKey}`,
      storageKey: "uploads/abc.mp4",
      metadata: { filename: "clip.mp4", size: 999, mimeType: "video/mp4" },
    });
  });

  it("announces the upload on the project feed with its thumbnail", async () => {
    await runVideoCover(job());

    expect(mockActivityInsert).toHaveBeenCalledTimes(1);
    expect(mockActivityInsert.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
      actorUserId: "user-1",
      type: "asset:uploaded",
      spaceId: "space-1",
      nodeId: "node-1",
      payload: {
        fileUrl: DATA.videoUrl,
        kind: "video",
        thumbnailUrl: `https://cdn/${REGISTERED_COVER.storageKey}`,
      },
    });
    expect(mockPublishActivity).toHaveBeenCalledWith("proj-1");
  });

  it("reports a mini-tool upload as a generation on the feed", async () => {
    await runVideoCover(job({ source: "mini_tool", toolName: "trim" }));

    expect(mockActivityInsert.mock.calls[0]![0]).toMatchObject({
      type: "generation:succeeded",
      payload: { source: "mini_tool", toolName: "trim", executedOn: "frontend" },
    });
  });
});

describe("a replay of the same job", () => {
  // The history write is keyed on the storage key, so the second run gets the
  // first run's row back. The feed has no key of its own and reads that flag.
  it("does not add a second feed row", async () => {
    mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: false });

    await runVideoCover(job());

    expect(mockActivityInsert).not.toHaveBeenCalled();
    expect(mockPublishActivity).not.toHaveBeenCalled();
  });

  it("still sends the node its event, which is last-write-wins", async () => {
    mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: false });

    await runVideoCover(job());

    expect(mockEmitDone).toHaveBeenCalledTimes(1);
  });
});

describe("no cover comes out", () => {
  beforeEach(() => {
    mockExtract.mockResolvedValue(undefined);
  });

  it("registers nothing and links nothing", async () => {
    await runVideoCover(job());

    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockSetCover).not.toHaveBeenCalled();
  });

  it("still tells the node the video is ready, without a cover", async () => {
    await runVideoCover(job());

    expect(mockEmitDone).toHaveBeenCalledTimes(1);
    const fields = mockEmitDone.mock.calls[0]![3];
    expect(fields.content).toBe(DATA.videoUrl);
    expect(fields.coverUrl).toBeUndefined();
  });

  it("leaves the history row and the feed row without a thumbnail", async () => {
    await runVideoCover(job());

    expect(mockRecordUpload.mock.calls[0]![0].thumbnailUrl).toBeUndefined();
    expect(
      (mockActivityInsert.mock.calls[0]![0] as { payload: Record<string, unknown> })
        .payload.thumbnailUrl,
    ).toBeUndefined();
  });
});

describe("the cover cannot be registered", () => {
  // The video is already in the ledger. Failing the job over its cover would
  // hold the node in handling for something the user can live without.
  it("falls back to no cover rather than failing the job", async () => {
    mockRegister.mockRejectedValue(new Error("ledger down"));

    await expect(runVideoCover(job())).resolves.toBeUndefined();

    expect(mockSetCover).not.toHaveBeenCalled();
    expect(mockEmitDone.mock.calls[0]![3].coverUrl).toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });

  it("warns when the redundant object could not be queued for reclaim", async () => {
    mockRegister.mockResolvedValue({
      asset: REGISTERED_COVER,
      deduped: true,
      reclaimQueueFailed: true,
    });

    await runVideoCover(job());

    expect(mockWarn).toHaveBeenCalled();
    expect(mockEmitDone.mock.calls[0]![3].coverUrl).toBe(
      `https://cdn/${REGISTERED_COVER.storageKey}`,
    );
  });
});

describe("the event cannot be published", () => {
  // Nothing else writes this node's URL: the value lives only in Yjs and this
  // event is the only thing that puts it there. Swallowing the failure leaves
  // the node spinning until collab's hour-long sweeper reclaims it.
  it("fails the job so BullMQ retries it", async () => {
    mockEmitDone.mockRejectedValue(new Error("redis gone"));

    await expect(runVideoCover(job())).rejects.toThrow("redis gone");
  });
});

// A job that already produced a cover is retried whenever anything after the
// extraction failed. Extracting again downloads the video, runs ffmpeg and
// stores a second PNG that immediately dedups to the first — leaving an object
// for the reclaim job to collect, once per retry.
describe("a retry of a video whose cover is already linked", () => {
  it("neither extracts nor stores a second time", async () => {
    mockFindCoverOf.mockResolvedValueOnce({
      id: "cover-1",
      storageKey: "image/2026-08-31/cover.png",
    });

    await runVideoCover(job());

    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("still tells the node what it holds, cover and all", async () => {
    mockFindCoverOf.mockResolvedValueOnce({
      id: "cover-1",
      storageKey: "image/2026-08-31/cover.png",
    });

    await runVideoCover(job());

    expect(mockEmitDone).toHaveBeenCalledOnce();
    expect(mockEmitDone.mock.calls[0]![3]).toMatchObject({
      coverUrl: expect.stringContaining("image/2026-08-31/cover.png"),
    });
  });
});

// The cover is in the ledger by the time this write happens, so failing it
// leaves an extracted frame nothing can reach. That is not the degradation B1
// describes (no cover came out); it is a cover that came out and was lost, and
// the attempt has to be made again.
describe("a cover that was registered but could not be linked", () => {
  it("fails the job so it is retried", async () => {
    mockSetCover.mockRejectedValueOnce(new Error("the ledger is unreachable"));

    await expect(runVideoCover(job())).rejects.toThrow();
  });

  it("tells the node nothing rather than telling it there is no cover", async () => {
    mockSetCover.mockRejectedValueOnce(new Error("the ledger is unreachable"));

    await runVideoCover(job()).catch(() => undefined);

    expect(mockEmitDone).not.toHaveBeenCalled();
  });
});
