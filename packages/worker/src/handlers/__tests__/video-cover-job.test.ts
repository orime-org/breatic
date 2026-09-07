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
const mockUploadBytes = vi.hoisted(() => vi.fn());
const mockSetCover = vi.hoisted(() => vi.fn());
const mockRecordUpload = vi.hoisted(() => vi.fn());
const mockFindTask = vi.hoisted(() => vi.fn());
const mockSettleTask = vi.hoisted(() => vi.fn());
const mockEmitCounts = vi.hoisted(() => vi.fn());
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
  backendUploadService: { uploadBytesToStorage: mockUploadBytes },
  assetRepo: { setCoverAsset: mockSetCover },
  nodeHistoryService: { recordUpload: mockRecordUpload },
  // The task row a video upload settles on (#186): its cover is the last
  // thing the upload waits for, so this handler is where it lands.
  nodeTaskService: {
    findByStorageKey: mockFindTask,
    settle: mockSettleTask,
  },
  emitNodeTaskCounts: mockEmitCounts,
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));
vi.mock("@worker/providers/video-cover.js", () => ({
  extractVideoCover: mockExtract,
}));

import { runVideoCover } from "@worker/handlers/video-cover-job.js";
import type { VideoCoverJobData } from "@breatic/domain";

/** What the extractor hands back: the frame, and the type it is served as. */
const EXTRACTED = { png: Buffer.from("png-bytes"), mimeType: "image/png" };

/** What the store answered with — on a dedup hit, an existing row. */
const STORED = {
  assetId: "cover-row-1",
  fileUrl: "https://cdn/image/existing_cover.png",
  kind: "image",
};

const DATA: VideoCoverJobData = {
  storageKey: "uploads/abc.mp4",
  videoAssetId: "video-row-1",
  videoUrl: "https://cdn/uploads/registered.mp4",
  userId: "user-1",
  projectId: "proj-1",
  spaceId: "space-1",
  nodeId: "node-1",
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
  mockUploadBytes.mockResolvedValue(STORED);
  mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: true });
  mockEmitCounts.mockResolvedValue(undefined);
  mockFindTask.mockResolvedValue({ id: "row-1" });
  mockSettleTask.mockResolvedValue({
    applied: true,
    landed: true,
    counts: { running: 0, done: 1, failed: 0, expired: 0 },
  });
});

describe("a cover that comes out", () => {
  it("sends the frame to be filed as the studio's own image asset", async () => {
    await runVideoCover(job());

    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    const sent = mockUploadBytes.mock.calls[0]![0] as Blob;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(
      new Uint8Array(EXTRACTED.png),
    );
    expect(mockUploadBytes.mock.calls[0]![1]).toMatchObject({
      projectId: "proj-1",
      actingUserId: "user-1",
      // What this is travels on the grant: the Worker's report knows only what
      // the ticket told it, so `cover` cannot be inferred there.
      assetSource: "cover",
      contentType: EXTRACTED.mimeType,
    });
  });

  it("writes the cover's row id back onto the video", async () => {
    await runVideoCover(job());

    expect(mockSetCover).toHaveBeenCalledWith("video-row-1", "cover-row-1");
  });

  it("pins the url the store answered with, not one minted on this side", async () => {
    // Within one studio the same frame files to a single row, so a second
    // video with an identical first frame resolves to a row holding a
    // different key -- and the key just written is queued for reclaim.
    await runVideoCover(job());

    const emitted = mockEmitCounts.mock.calls[0]!;
    expect(emitted[4].coverUrl).toBe(STORED.fileUrl);
  });

  it("tells the node about the video and its cover in one event", async () => {
    await runVideoCover(job());

    expect(mockEmitCounts).toHaveBeenCalledTimes(1);
    const [, docName, nodeId, , fields] = mockEmitCounts.mock.calls[0]!;
    expect(docName).toBe("project-proj-1/canvas-space-1");
    expect(nodeId).toBe("node-1");
    expect(fields.content).toBe(DATA.videoUrl);
    expect(fields.coverUrl).toBe(STORED.fileUrl);
  });

  it("records the upload under the granted key, carrying the cover", async () => {
    await runVideoCover(job());

    expect(mockRecordUpload).toHaveBeenCalledWith({
      projectId: "proj-1",
      nodeId: "node-1",
      userId: "user-1",
      content: DATA.videoUrl,
      thumbnailUrl: STORED.fileUrl,
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
        thumbnailUrl: STORED.fileUrl,
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

    expect(mockEmitCounts).toHaveBeenCalledTimes(1);
  });
});

describe("no cover comes out", () => {
  beforeEach(() => {
    mockExtract.mockResolvedValue(undefined);
  });

  it("registers nothing and links nothing", async () => {
    await runVideoCover(job());

    expect(mockUploadBytes).not.toHaveBeenCalled();
    expect(mockSetCover).not.toHaveBeenCalled();
  });

  it("still tells the node the video is ready, without a cover", async () => {
    await runVideoCover(job());

    expect(mockEmitCounts).toHaveBeenCalledTimes(1);
    const fields = mockEmitCounts.mock.calls[0]![4];
    expect(fields.content).toBe(DATA.videoUrl);
    expect(fields.coverUrl).toBeNull();
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
    mockUploadBytes.mockRejectedValue(new Error("ledger down"));

    await expect(runVideoCover(job())).resolves.toBeUndefined();

    expect(mockSetCover).not.toHaveBeenCalled();
    expect(mockEmitCounts.mock.calls[0]![4].coverUrl).toBeNull();
    expect(mockWarn).toHaveBeenCalled();
  });

  // Registering and pointing at it are two different failures. The registered
  // row is real and keyed on the frame's hash, so the retry that follows finds
  // it by dedup and only has to write the pointer — whereas giving up here
  // leaves a cover row nothing points at and a node that never gets one.
  it("fails the job when the cover registered but could not be linked", async () => {
    // Once, because `clearAllMocks` clears calls but keeps an implementation,
    // and this one would then reject for every case after it.
    mockSetCover.mockRejectedValueOnce(new Error("update lost"));

    await expect(runVideoCover(job())).rejects.toThrow(/update lost/);

    expect(mockEmitCounts).not.toHaveBeenCalled();
  });

  // Filing it is what produces the row and its url, so an answer carrying
  // neither means the cover exists as an object and as nothing else. There is
  // no id to point the video at and no url to show.
  it("falls back to no cover when the store filed nothing", async () => {
    mockUploadBytes.mockResolvedValue({ assetId: null });

    await expect(runVideoCover(job())).resolves.toBeUndefined();

    expect(mockSetCover).not.toHaveBeenCalled();
    expect(mockEmitCounts.mock.calls[0]![4].coverUrl).toBeNull();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe("the event cannot be published", () => {
  // Nothing else writes this node's URL: the value lives only in Yjs and this
  // event is the only thing that puts it there. Swallowing the failure leaves
  // the node showing a task that never ends.
  it("fails the job so BullMQ retries it", async () => {
    mockEmitCounts.mockRejectedValue(new Error("redis gone"));

    await expect(runVideoCover(job())).rejects.toThrow("redis gone");
  });
});

/**
 * The task row a video upload settles on (#186, design §3.6).
 *
 * A video's upload is not done until its cover has had its chance, so the
 * ingest report leaves the row running and this handler is what closes it.
 * The row is the one the ticket opened, named by the key this upload was
 * granted.
 */
describe("the upload's task row", () => {
  it("settles the row this key was granted, pointing at the history row", async () => {
    await runVideoCover(job());

    expect(mockFindTask).toHaveBeenCalledWith(DATA.storageKey);
    expect(mockSettleTask).toHaveBeenCalledWith({
      taskId: "row-1",
      outcome: "done",
      nodeHistoryId: "hist-1",
    });
  });

  it("publishes the node's counts with the video and its cover", async () => {
    await runVideoCover(job());

    expect(mockEmitCounts).toHaveBeenCalledTimes(1);
    const [, docName, nodeId, counts, result] = mockEmitCounts.mock
      .calls[0] as [unknown, string, string, unknown, { coverUrl: string | null }];
    expect(docName).toBe(`project-${DATA.projectId}/canvas-${DATA.spaceId}`);
    expect(nodeId).toBe(DATA.nodeId);
    expect(counts).toEqual({ running: 0, done: 1, failed: 0, expired: 0 });
    expect(result.coverUrl).not.toBeNull();
  });

  it("leaves the content alone when the row had already settled", async () => {
    // The deadline passed first. The numbers still go out; what is on the
    // node stays where it is.
    mockSettleTask.mockResolvedValue({
      applied: false,
      landed: false,
      counts: { running: 0, done: 0, failed: 0, expired: 1 },
    });

    await runVideoCover(job());

    expect(mockEmitCounts.mock.calls[0]![4]).toBeUndefined();
  });

  it("settles nothing for an upload this table never held", async () => {
    mockFindTask.mockResolvedValue(null);

    await runVideoCover(job());

    expect(mockSettleTask).not.toHaveBeenCalled();
    expect(mockEmitCounts).not.toHaveBeenCalled();
  });
});
