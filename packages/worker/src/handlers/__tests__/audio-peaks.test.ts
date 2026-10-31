// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The peaks read of an audio row (inner#1305 §4.4). The handler hands the row
 * to the domain service and writes down a read that found nothing; what to
 * read lives in the service.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

const readAudioPeaks = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, audioPeaksService: { ...actual.audioPeaksService, readAudioPeaks } };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { getNodeTaskConfig, logger } from "@breatic/core";
import type { AudioPeaksJob } from "@breatic/domain";
import { runAudioPeaks } from "@worker/handlers/audio-peaks.js";

/** When the read was queued, which its two hours count from. */
const QUEUED_AT = 1_800_000_000_000;

/**
 * One queued read.
 * @param assetId - The row.
 * @returns The job.
 */
function job(assetId = "asset-1"): Job<AudioPeaksJob> {
  return { data: { assetId }, timestamp: QUEUED_AT } as Job<AudioPeaksJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an audio peaks job", () => {
  it("hands its row to the service with two hours from when it was queued", async () => {
    readAudioPeaks.mockResolvedValue("generated");

    await runAudioPeaks(job("asset-9"));

    expect(readAudioPeaks).toHaveBeenCalledWith("asset-9", QUEUED_AT + getNodeTaskConfig().default_budget_ms);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("writes down a row that had no sound to read", async () => {
    readAudioPeaks.mockResolvedValue("none");

    await runAudioPeaks(job("asset-9"));

    expect(logger.warn).toHaveBeenCalledWith({ assetId: "asset-9" }, "audio_peaks_nothing_found");
  });

  // The queue retries what throws, a read that came back failed included.
  it("lets a failed read through for the queue to retry", async () => {
    readAudioPeaks.mockRejectedValue(new Error("peaks of asset-1 came back failed"));

    await expect(runAudioPeaks(job())).rejects.toThrow("came back failed");
  });
});
