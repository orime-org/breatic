// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read an audio row's peaks after it registered (inner#1305 §4.4). What to
 * read is the domain service's; this hands it the row and writes down a read
 * that found no sound.
 */

import type { Job } from "bullmq";
import { budgetDeadlineFrom, logger } from "@breatic/core";
import { audioPeaksService, type AudioPeaksJob } from "@breatic/domain";

/**
 * Have the media container read one row's peaks.
 * @param job - The queued read.
 * @returns Nothing once the peaks are settled.
 * @throws {unknown} When the peaks came back failed, or the ingest Worker
 *   refused or could not be reached, so the queue tries again.
 */
export async function runAudioPeaks(job: Job<AudioPeaksJob>): Promise<void> {
  const { assetId } = job.data;
  // No task row stands behind a read, so its two hours count from when it was
  // queued (inner#1367).
  const deadlineAt = budgetDeadlineFrom(job.timestamp);
  const result = await audioPeaksService.readAudioPeaks(assetId, deadlineAt);
  if (result === "none") {
    logger.warn({ assetId }, "audio_peaks_nothing_found");
  }
}
