// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read an audio row's peaks after it registered (inner#1305 §4.4). What to
 * read is the domain service's; this hands it the row, writes down a read
 * that found no sound, and tells every live Project referencing the audio
 * that its peaks are there (#1580), so a cut band open on it draws them.
 */

import type { Job } from "bullmq";
import { assetRepo, budgetDeadlineFrom, getStorageAdapter, logger, publishAssetPeaksReady } from "@breatic/core";
import { audioPeaksService, type AudioPeaksJob } from "@breatic/domain";

/**
 * Have the media container read one row's peaks.
 * @param job - The queued read.
 * @returns Nothing once the peaks are settled and announced.
 * @throws {unknown} When the peaks came back failed, the ingest Worker
 *   refused or could not be reached, or an announcement could not be sent,
 *   so the queue tries again; a retry finds the peaks there and announces again.
 */
export async function runAudioPeaks(job: Job<AudioPeaksJob>): Promise<void> {
  const { assetId } = job.data;
  // No task row stands behind a read, so its two hours count from when it was
  // queued (inner#1367).
  const deadlineAt = budgetDeadlineFrom(job.timestamp);
  const result = await audioPeaksService.readAudioPeaks(assetId, deadlineAt);
  if (result === "none") {
    logger.warn({ assetId }, "audio_peaks_nothing_found");
    return;
  }
  if (result !== "generated" && result !== "existing") return;
  const asset = await assetRepo.findById(assetId);
  if (asset === null) return;
  const url = (await getStorageAdapter()).publicUrl(asset.storageKey);
  for (const projectId of await assetRepo.listProjectsReferencingAsset(assetId)) {
    await publishAssetPeaksReady(projectId, assetId, url);
  }
}
