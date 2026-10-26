// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upload-finish job runs the domain's finish and writes down how it ended
 * (inner#1367 §4.2a).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({
  finishUpload: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  logger: { info: h.info, warn: vi.fn(), error: h.error },
}));
vi.mock("@breatic/domain", () => ({
  uploadFinishService: { finishUpload: h.finishUpload },
  INGEST_SIDE_EFFECT_EVENTS: { countsPublishFailed: "upload_counts_publish_failed" },
}));

const { runUploadFinish } = await import("@worker/handlers/upload-finish.js");

const DATA = {
  storageKey: "image/2026-10-10/k.png",
  uploadId: "u-1",
  token: "t",
  parts: [{ partNumber: 1, etag: "e" }],
  assetSource: null,
};

/** The queued job. */
function job(): Job<typeof DATA> {
  return { data: DATA } as unknown as Job<typeof DATA>;
}

beforeEach(() => {
  h.finishUpload.mockReset();
  h.error.mockReset();
  h.info.mockReset();
});

describe("the upload-finish job", () => {
  it("hands the queued upload to the domain's finish", async () => {
    h.finishUpload.mockResolvedValue({ outcome: { status: "registered" } });

    await runUploadFinish(job() as never);

    expect(h.finishUpload).toHaveBeenCalledWith(DATA);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("writes an error for a finish the Worker could not do", async () => {
    const cause = new Error("assemble failed");
    h.finishUpload.mockResolvedValue({
      outcome: { status: "voided" },
      refused: { reason: "assemble_failed", cause },
    });

    await runUploadFinish(job() as never);

    expect(h.error).toHaveBeenCalledWith(
      { err: cause, key: DATA.storageKey, reason: "assemble_failed" },
      "upload_finish_failed",
    );
  });

  it("writes the type the bytes turned out to be when it was not the one asked for", async () => {
    h.finishUpload.mockResolvedValue({
      outcome: { status: "voided" },
      refused: { reason: "unsupported_type", contentType: "video/mp4" },
    });

    await runUploadFinish(job() as never);

    expect(h.info).toHaveBeenCalledWith(
      { key: DATA.storageKey, contentType: "video/mp4", source: null },
      "upload_purpose_type_refused",
    );
  });

  it("writes an info when the Worker refused the stored bytes' type", async () => {
    h.finishUpload.mockResolvedValue({
      outcome: { status: "voided" },
      refused: { reason: "unsupported_type", cause: new Error("Asset upload failed (HTTP 415)") },
    });

    await runUploadFinish(job() as never);

    expect(h.info).toHaveBeenCalledWith(
      { key: DATA.storageKey, source: null },
      "upload_stored_type_refused",
    );
    expect(h.error).not.toHaveBeenCalled();
  });

  it("writes an error when the row stands but its media read was not queued", async () => {
    const err = new Error("redis down");
    h.finishUpload.mockResolvedValue({ outcome: { status: "registered" }, mediaReadNotQueued: err });

    await runUploadFinish(job() as never);

    expect(h.error).toHaveBeenCalledWith({ err, key: DATA.storageKey }, "media_read_enqueue_failed");
  });

  it("writes the side effects registration could not complete", async () => {
    h.finishUpload.mockResolvedValue({ outcome: { status: "registered", countsPublishFailed: true } });

    await runUploadFinish(job() as never);

    expect(h.error).toHaveBeenCalledWith({ key: DATA.storageKey }, "upload_counts_publish_failed");
  });
});
