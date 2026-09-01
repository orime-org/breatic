// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cover queue's own failure net (#173, design §6.4.1).
 *
 * The `tasks` queue's net stamps every target node failed, which is right for
 * a generation and wrong here: the video registered before this job existed,
 * so telling the node it failed would contradict the row already in the
 * ledger. This net announces SUCCESS instead — the video is what the user gets
 * either way, with or without a cover.
 *
 * Which of the two it announces is a question only the database can answer,
 * because a job that died holds no state anyone can read. `cover_asset_id` is
 * that answer: the job writes it right after registering the cover, so a value
 * there means the cover exists and an unconditional "video only" would hide a
 * cover the studio is already paying to store.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPublicUrl = vi.hoisted(() => vi.fn((key: string) => `https://cdn/${key}`));
const mockGetStorageAdapter = vi.hoisted(() => vi.fn());
const mockFindCoverOf = vi.hoisted(() => vi.fn());
const mockRecordUpload = vi.hoisted(() => vi.fn());
const mockEmitDone = vi.hoisted(() => vi.fn());
const mockActivityInsert = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: mockGetStorageAdapter,
  getStreamRedis: vi.fn(() => ({})),
  projectActivitiesRepo: { insert: mockActivityInsert },
  publishActivityNew: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  assetService: { register: vi.fn() },
  assetRepo: { setCoverAsset: vi.fn(), findCoverOf: mockFindCoverOf },
  nodeHistoryService: { recordUpload: mockRecordUpload },
  emitNodeStateDone: mockEmitDone,
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));
vi.mock("@worker/providers/video-cover.js", () => ({
  extractVideoCover: vi.fn(),
}));

import {
  reclaimFailedCoverJobById,
  type CoverJobFetcher,
  type FailedCoverJobLike,
} from "@worker/handlers/video-cover-cleanup.js";
import type { VideoCoverJobData } from "@breatic/domain";

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

/** A read-side queue that hands back one job. */
function queueHolding(job: FailedCoverJobLike | undefined): CoverJobFetcher {
  return { getJob: vi.fn(async () => job) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStorageAdapter.mockResolvedValue({ publicUrl: mockPublicUrl });
  mockFindCoverOf.mockResolvedValue(null);
  mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: true });
  mockEmitDone.mockResolvedValue(undefined);
});

describe("a failure that is not terminal yet", () => {
  // BullMQ emits 'failed' for retryable attempts too. Writing the node idle
  // then would fight the retry that is about to run.
  it("says nothing while retries remain", async () => {
    const queue = queueHolding({ data: DATA });

    expect(await reclaimFailedCoverJobById(queue, "job-1")).toBe(false);
    expect(mockEmitDone).not.toHaveBeenCalled();
  });

  it("says nothing when the job is no longer fetchable", async () => {
    const queue = queueHolding(undefined);

    expect(await reclaimFailedCoverJobById(queue, "job-1")).toBe(false);
    expect(mockEmitDone).not.toHaveBeenCalled();
  });
});

describe("a terminal failure", () => {
  it("tells the node the video is ready, without a cover it never got", async () => {
    const queue = queueHolding({ data: DATA, finishedOn: 1_700_000_000_000 });

    expect(await reclaimFailedCoverJobById(queue, "job-1")).toBe(true);

    expect(mockEmitDone).toHaveBeenCalledTimes(1);
    const [, docName, nodeId, fields, gen] = mockEmitDone.mock.calls[0]!;
    expect(docName).toBe("project-proj-1/canvas-space-1");
    expect(nodeId).toBe("node-1");
    expect(fields.content).toBe(DATA.videoUrl);
    expect(fields.coverUrl).toBeUndefined();
    expect(gen).toBe(4);
  });

  // The job registered the cover and linked it, then died on the event. An
  // unconditional "video only" would leave that cover in the ledger, charged
  // for, and never on screen.
  it("carries the cover the job managed to register before dying", async () => {
    mockFindCoverOf.mockResolvedValue({ storageKey: "image/existing_cover.png" });
    const queue = queueHolding({ data: DATA, finishedOn: 1_700_000_000_000 });

    await reclaimFailedCoverJobById(queue, "job-1");

    expect(mockFindCoverOf).toHaveBeenCalledWith("video-row-1");
    expect(mockEmitDone.mock.calls[0]![3].coverUrl).toBe(
      "https://cdn/image/existing_cover.png",
    );
  });

  it("records the upload, which a job that died early may never have", async () => {
    const queue = queueHolding({ data: DATA, finishedOn: 1_700_000_000_000 });

    await reclaimFailedCoverJobById(queue, "job-1");

    expect(mockRecordUpload.mock.calls[0]![0]).toMatchObject({
      storageKey: "uploads/abc.mp4",
      content: DATA.videoUrl,
    });
  });

  it("adds no feed row when the job already wrote one", async () => {
    mockRecordUpload.mockResolvedValue({ entry: { id: "hist-1" }, inserted: false });
    const queue = queueHolding({ data: DATA, finishedOn: 1_700_000_000_000 });

    await reclaimFailedCoverJobById(queue, "job-1");

    expect(mockActivityInsert).not.toHaveBeenCalled();
  });
});
