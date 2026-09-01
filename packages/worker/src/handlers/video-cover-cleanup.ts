// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cover queue's failure net (#173, design §6.4.1).
 *
 * A node enters `handling` before the first byte moves and leaves it only when
 * something says so. The cover job's own event is what normally says so; this
 * covers the deaths that skip it — a worker that crashed mid-job, and a stall
 * BullMQ moved straight to failed without re-running the handler.
 *
 * What it announces is SUCCESS, which is where this differs from the `tasks`
 * queue's net. The video registered before this job was ever enqueued, so
 * stamping the node failed would contradict a row already in the ledger; what
 * the user gets is the video, with or without a cover.
 *
 * Which of the two is a question only the database can answer, because a job
 * that died holds no readable state. `cover_asset_id` is that answer: the job
 * writes it immediately after registering the cover, so a value there means
 * the cover exists — and announcing "video only" regardless would leave it
 * stored, counted against the studio, and never on screen.
 *
 * Cross-process by design, like the `tasks` net: a crashed worker runs none of
 * its own callbacks, so this is driven by `QueueEvents` 'failed', which every
 * live instance receives.
 */

import { getStorageAdapter } from "@breatic/core";
import { assetRepo, type VideoCoverJobData } from "@breatic/domain";
import { announceUpload } from "@worker/handlers/video-cover-job.js";

/** Minimal failed-job shape (BullMQ `Job` narrowed to what we read). */
export interface FailedCoverJobLike {
  data: VideoCoverJobData;
  /**
   * Terminal-completion timestamp (epoch ms). BullMQ sets `finishedOn` for
   * every terminal failure and only terminal failures, including the stalled
   * death — which leaves `attemptsMade` un-incremented and would slip past a
   * gate written on that instead. A stalled death is the likeliest way this
   * job dies, ffmpeg being what it waits on.
   */
  finishedOn?: number;
}

/** Read-side queue shape: fetch a job by id (satisfied by BullMQ `Queue`). */
export interface CoverJobFetcher {
  /**
   * Fetch a job by id, or `undefined` if it no longer exists. Terminally
   * failed jobs are retained by `removeOnFail.age` (24h, see `defaultJobOpts`),
   * so a job is fetchable right after its failure event.
   */
  getJob(jobId: string): Promise<FailedCoverJobLike | undefined>;
}

/**
 * Announce the upload for a cover job BullMQ has finally given up on.
 * @param queue - Read-side fetcher (a BullMQ `Queue`) resolving the job id.
 * @param jobId - The failed job's id from the `QueueEvents` 'failed' event.
 * @returns Whether an announcement was published.
 * @throws {Error} When the write-back cannot be published; the caller logs it,
 *   and collab's handling-lease sweeper is the backstop past this point.
 */
export async function reclaimFailedCoverJobById(
  queue: CoverJobFetcher,
  jobId: string,
): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;
  // BullMQ's 'failed' fires for retryable attempts too, and announcing now
  // would land ahead of the retry that is about to run.
  if (!job.finishedOn) return false;

  const cover = await assetRepo.findCoverOf(job.data.videoAssetId);
  const adapter = await getStorageAdapter();
  await announceUpload(
    job.data,
    cover ? adapter.publicUrl(cover.storageKey) : undefined,
  );
  return true;
}
