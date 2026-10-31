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
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";

const uploadBytesToStorage = vi.fn();
const transferUrlToStorage = vi.fn();
const error = vi.fn();

// Everything real but the one service driven here, so the table naming these
// events is the one the library publishes rather than a copy typed in a test.
vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof domainModule>()),
  backendUploadService: { uploadBytesToStorage, transferUrlToStorage },
}));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  logger: { error, info: vi.fn(), warn: vi.fn() },
}));

const { storeBytes, storeFromUrl } = await import(
  "@worker/handlers/backend-upload.js"
);
const { UploadOpenFailed, INGEST_SIDE_EFFECT_EVENTS } = await import("@breatic/domain");
const { INGEST_NO_ANSWER, UploadHttpError } = await import("@breatic/shared");

const ctx = {
  projectId: "p-1",
  actingUserId: "u-1",
  assetSource: "ai" as const,
  taskType: "image",
  ext: ".png",
  contentType: "image/png",
  deadlineAt: Date.now() + 3_600_000,
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

  // A video stands and is shown without a poster when this one fails, so the
  // object left in storage has no row pointing at it and this line is the
  // only trace of it.
  it("records a cover that could not be filed", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      coverRegisterFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a-1" }),
      "ingest_cover_register_failed",
    );
  });

  it("records every one of them when they all failed", async () => {
    uploadBytesToStorage.mockResolvedValue({
      ...registered,
      reclaimQueueFailed: true,
      countsPublishFailed: true,
      activityAppendFailed: true,
      coverRegisterFailed: true,
    });

    await storeBytes(new Blob(["x"]), ctx);

    // Four, because the table has four entries. A flag added to the library
    // without a line there would leave this at four while five can fail.
    expect(error).toHaveBeenCalledTimes(4);
  });
});

// Lane ② opens its upload at the Worker before sending a byte (inner#1595).
// When that open fails, the domain has already settled the grant and the task
// row; whatever settling could not do beside it comes back on the error, and
// this is the only place the worker writes it down.
describe("storing bytes whose upload could not be opened", () => {
  const flags = Object.keys(INGEST_SIDE_EFFECT_EVENTS) as (keyof typeof INGEST_SIDE_EFFECT_EVENTS)[];

  it("T48: records each side effect settling raised, then throws the same error", async () => {
    expect(flags).toHaveLength(5);
    // Two of the five raised, three not.
    const raised = flags.filter((_, i) => i === 0 || i === 3);
    const settled = {
      status: "voided" as const,
      ...Object.fromEntries(flags.map((flag) => [flag, raised.includes(flag)])),
    };
    const failed = new UploadOpenFailed({
      storageKey: "k-1",
      reason: "store_failed",
      settled,
      cause: new UploadHttpError(502, "store_failed"),
    });
    uploadBytesToStorage.mockRejectedValue(failed);

    await expect(storeBytes(new Blob(["x"]), ctx)).rejects.toBe(failed);

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.map((call) => call[1]).sort()).toEqual(
      raised.map((flag) => INGEST_SIDE_EFFECT_EVENTS[flag]).sort(),
    );
  });

  it("T48: records nothing when settling raised nothing, and still throws the same error", async () => {
    const settled = {
      status: "voided" as const,
      ...Object.fromEntries(flags.map((flag) => [flag, false])),
    };
    const failed = new UploadOpenFailed({
      storageKey: "k-1",
      reason: "store_failed",
      settled,
      cause: new UploadHttpError(502, "store_failed"),
    });
    uploadBytesToStorage.mockRejectedValue(failed);

    await expect(storeBytes(new Blob(["x"]), ctx)).rejects.toBe(failed);

    expect(error).not.toHaveBeenCalled();
  });

  // The settling error travels on the thrown error to whoever handles it.
  it("T49: only throws the same error when settling failed too", async () => {
    const failed = new UploadOpenFailed({
      storageKey: "k-1",
      reason: INGEST_NO_ANSWER,
      settleError: new Error("db down"),
      cause: new TypeError("fetch failed"),
    });
    uploadBytesToStorage.mockRejectedValue(failed);

    await expect(storeBytes(new Blob(["x"]), ctx)).rejects.toBe(failed);

    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain error", () => new Error("boom")],
    ["a Worker refusal", () => new UploadHttpError(502, "store_failed")],
  ])("T49: passes %s through untouched", async (_label, make) => {
    const err = make();
    uploadBytesToStorage.mockRejectedValue(err);

    await expect(storeBytes(new Blob(["x"]), ctx)).rejects.toBe(err);

    expect(error).not.toHaveBeenCalled();
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
