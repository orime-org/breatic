// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an audio row's peaks after it registers (inner#1305 §4.4).
 *
 * The cut band draws an audio source's waveform from a peaks file beside it.
 * Reading one decodes the whole object, so it runs here, on its own queue,
 * after the row stands: an upload's finish and a billed mini-tool run never
 * wait on it. Only the row an upload wrote gets a job; bytes that landed on a
 * row the studio already held are that row's, and it got its own.
 */

import { createQueue, defaultJobOpts, env } from "@breatic/core";
import { readStoredMediaAtIngest } from "@breatic/shared";

import { findById } from "@domain/asset/asset.repo.js";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";

/** The queue the read travels on. */
export const AUDIO_PEAKS_QUEUE = "audio-peaks";

/** One read, as the worker receives it. */
export interface AudioPeaksJob {
  assetId: string;
}

/** What one read job did with its row. */
export type AudioPeaksResult = "generated" | "existing" | "none" | "gone";

/** The Worker answered, and the peaks did not come back: the queue retries. */
export class AudioPeaksReadFailed extends Error {
  /**
   * Name the row whose peaks did not come back.
   * @param assetId - The row whose peaks were asked for.
   */
  constructor(assetId: string) {
    super(`peaks of ${assetId} came back failed`);
    this.name = "AudioPeaksReadFailed";
  }
}

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Queue a peaks read for a registered row, when it is an upload's own audio.
 *
 * Keyed by the row, so a re-delivered finish adds nothing while the row's job
 * is still held; one after it has been cleared queues a fresh read, which the
 * ingest Worker answers as `existing` without a container.
 * @param outcome - What registration answered.
 * @returns Whether a job was queued.
 * @throws {unknown} When the queue's Redis refused the job.
 */
export async function scheduleAudioPeaks(outcome: IngestReportOutcome): Promise<boolean> {
  if (outcome.status !== "registered" && outcome.status !== "already_registered") return false;
  if (!outcome.ownRow || outcome.mimeType?.startsWith("audio/") !== true) return false;
  queue ??= createQueue(AUDIO_PEAKS_QUEUE);
  const job: AudioPeaksJob = { assetId: outcome.assetId };
  // BullMQ refuses a custom id that contains a colon.
  await queue.add("read", job, { ...defaultJobOpts(), jobId: `audio-peaks-${outcome.assetId}` });
  return true;
}

/**
 * Have the media container read one row's peaks.
 * @param assetId - The row.
 * @param deadlineAt - When the job runs out, in epoch ms; the read is bounded
 *   by it and nothing else.
 * @returns What became of the peaks.
 * @throws {AudioPeaksReadFailed} When the Worker answered without peaks.
 * @throws {unknown} When the Worker refused or could not be reached.
 */
export async function readAudioPeaks(assetId: string, deadlineAt: number): Promise<AudioPeaksResult> {
  const row = await findById(assetId);
  if (row === null || row.deletedAt !== null) return "gone";
  const read = await readStoredMediaAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    storageKey: row.storageKey,
    contentType: row.mimeType,
    deadlineAt,
    wantPeaks: true,
  });
  if (read.peaks === undefined || read.peaks === "failed") throw new AudioPeaksReadFailed(assetId);
  return read.peaks;
}
