// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T39 (inner#1006 §4.3): the upload-finish job logs a finished transfer as
 * `upload_finished` with status `transferred`, and a refused transfer (no
 * `contentType` on the refusal) as `upload_finish_failed`. The finish results
 * are typed as `UploadFinishResult`, so the package typecheck pins that
 * `transferred` is one of the outcomes the domain can hand back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { UploadFinishResult } from "@breatic/domain";

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

const KEY = "transfer/2026-10-24/1_00000000-0000-4000-8000-000000000001.transfer";

/** The queued finish of a transfer upload. */
const DATA = {
  storageKey: KEY,
  uploadId: "u-1",
  token: "t",
  parts: [{ partNumber: 1, etag: "e" }],
  assetSource: "transfer",
};

/**
 * The queued job.
 * @returns The job BullMQ hands the handler.
 */
function job(): Job<typeof DATA> {
  return { data: DATA } as unknown as Job<typeof DATA>;
}

beforeEach(() => {
  h.finishUpload.mockReset();
  h.error.mockReset();
  h.info.mockReset();
});

describe("T39 the upload-finish job on a transfer", () => {
  it("logs a finished transfer as upload_finished with status transferred and no error", async () => {
    const finished: UploadFinishResult = { outcome: { status: "transferred" } };
    h.finishUpload.mockResolvedValue(finished);

    await runUploadFinish(job() as never);

    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info).toHaveBeenCalledWith({ key: KEY, status: "transferred" }, "upload_finished");
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs a transfer refused as too large as upload_finish_failed", async () => {
    const refused: UploadFinishResult = {
      outcome: { status: "voided" },
      refused: { reason: "too_large" },
    };
    h.finishUpload.mockResolvedValue(refused);

    await runUploadFinish(job() as never);

    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith(
      { err: undefined, key: KEY, reason: "too_large" },
      "upload_finish_failed",
    );
  });
});
