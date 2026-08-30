// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The contract between the server that asks for a video's cover and the worker
 * that extracts it (#173, design §5.2).
 *
 * Its own queue rather than `tasks`, because that queue carries a failure net
 * built for generations: it reads `targetNodeIds` off a `TaskJobData` and
 * stamps every one of them failed. A cover that cannot be extracted must not
 * do that — the video it belongs to registered successfully before this job
 * was ever enqueued, and telling the node it failed would contradict the row
 * already in the ledger. `tasks` also assumes a `tasks` table row, which cover
 * extraction has none of.
 *
 * The payload carries everything the worker needs, because a worker holds no
 * request context: the studio that pays for the cover, where the node lives,
 * and the lease generation the write-back has to be fenced with.
 */

/** The queue a video cover extraction is asked for on. */
export const VIDEO_COVER_QUEUE = "video-cover";

/** The BullMQ job name within that queue. */
export const VIDEO_COVER_JOB = "extract-cover";

/** What the worker is told about the video it should extract a cover from. */
export interface VideoCoverJobData {
  /**
   * The key this upload was granted. One upload is one key, so it identifies
   * the job (BullMQ dedups on an explicit job id) and keys the node history
   * row the worker writes, which a replay must not duplicate.
   */
  storageKey: string;
  /** The registered video row; the cover's id is written back onto it. */
  videoAssetId: string;
  /**
   * The registered canonical URL of the video — what ffmpeg reads and what the
   * node event pins. A dedup hit resolves to a different row than this upload
   * stored, so this is that row's URL, never the key just written.
   */
  videoUrl: string;
  /** The studio the cover is registered under, read off the upload grant. */
  ownerStudioId: string;
  /** Who uploaded, credited as the cover's registrant and the feed's actor. */
  userId: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  /**
   * The lease generation the node's handling was opened under. The write-back
   * carries it so collab's CAS drops it once the node belongs to a newer one.
   */
  leaseGen: number;
  /** What the video weighs, for the history row's metadata. */
  sizeBytes: number;
  /** The video's mime type, for the history row's metadata. */
  mimeType: string;
  /** The name the user's file had, when the upload carried one. */
  filename: string | null;
  /** What started this upload — `mini_tool` changes which feed event is written. */
  source: string | null;
  /** The mini-tool that produced it, when one did. */
  toolName: string | null;
}
