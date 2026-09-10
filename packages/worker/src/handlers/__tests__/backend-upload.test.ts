// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The worker's way into a backend upload (#206 design §3.4.1).
 *
 * Registering runs in a library, which holds no logger, so the three things
 * that can fail beside the outcome come back as fields instead. None of them
 * changes what the caller gets — the bytes are stored and the row is filed —
 * and this is the only account anybody ever gets of that failure. The server
 * writes them down in its route; this is where the worker does it, and going
 * through here is what keeps a caller from receiving them and dropping them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadBytesToStorage = vi.fn();
const transferUrlToStorage = vi.fn();
const error = vi.fn();

vi.mock("@breatic/domain", () => ({
  backendUploadService: { uploadBytesToStorage, transferUrlToStorage },
}));
vi.mock("@breatic/core", () => ({ logger: { error, info: vi.fn(), warn: vi.fn() } }));

const { storeBytes, storeFromUrl } = await import(
  "@worker/handlers/backend-upload.js"
);

const ctx = {
  projectId: "p-1",
  actingUserId: "u-1",
  assetSource: "ai" as const,
  taskType: "image",
  ext: ".png",
  contentType: "image/png",
};

const registered = { assetId: "a-1", fileUrl: "/uploads/a.png", kind: "image" };

beforeEach(() => {
  uploadBytesToStorage.mockReset();
  transferUrlToStorage.mockReset();
  error.mockReset();
});

describe("storing bytes", () => {
  it("hands back what was registered", async () => {
    uploadBytesToStorage.mockResolvedValue(registered);

    const stored = await storeBytes(new Blob(["x"]), ctx);

    expect(stored).toEqual(registered);
  });

  it("says nothing when nothing failed", async () => {
    uploadBytesToStorage.mockResolvedValue(registered);

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).not.toHaveBeenCalled();
  });

  // The object that lost a dedup race stays in R2 and is nobody's until the
  // sweep is told about it, so a queue that refused the job is the difference
  // between a bill that ends and one that does not.
  it("records a reclaim job that could not be queued", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      reclaimQueueFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a-1" }),
      "ingest_report_reclaim_queue_failed",
    );
  });

  // Without the counts the node keeps showing a task that has already ended.
  it("records counts that could not be published", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      countsPublishFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a-1" }),
      "node_task_counts_publish_failed",
    );
  });

  it("records an activity row that was never appended", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      activityAppendFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a-1" }),
      "activity_record_failed",
    );
  });

  it("records every one of them when they all failed", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      reclaimQueueFailed: true,
      countsPublishFailed: true,
      activityAppendFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).toHaveBeenCalledTimes(3);
  });
});

describe("storing what a link points at", () => {
  it("hands back what was registered", async () => {
    transferUrlToStorage.mockResolvedValue(registered);

    const stored = await storeFromUrl("https://provider.example/a.png", ctx);

    expect(stored).toEqual(registered);
  });

  // The same three can fail whichever lane put the bytes there, and this lane
  // is the one a generation's deliverable comes through.
  it("records what registering could not do", async () => {
    transferUrlToStorage.mockResolvedValue({
      ...registered,
      countsPublishFailed: true,
    });

    await storeFromUrl("https://provider.example/a.png", ctx);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a-1" }),
      "node_task_counts_publish_failed",
    );
  });
});
