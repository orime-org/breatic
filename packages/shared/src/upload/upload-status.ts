// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upload status query (inner#1367 §4.2a): finishing an upload answers 202
 * and the browser asks how each of its uploads ended, several in one request.
 */

/**
 * How many uploads one status request may ask about: as many as AWS Batch's
 * `DescribeJobs` takes, enough for every tile of one grid export in one round.
 */
export const UPLOAD_STATUS_MAX_KEYS = 100;

/** What a finished upload registered as. */
export interface UploadStatusResult {
  assetId: string;
  fileUrl: string;
  kind: string;
  /** Pixel size read off the stored bytes; null when there is none. */
  width: number | null;
  height: number | null;
}

/**
 * Where one upload stands.
 *
 * `unknown` covers a key that was never issued and one issued to someone
 * else: telling the two apart would tell a caller which keys exist.
 */
export type UploadStatus =
  | { key: string; state: "finishing" }
  | { key: string; state: "completed"; result: UploadStatusResult }
  /** A transfer upload (inner#1006) finished: it registers no asset. */
  | { key: string; state: "transferred" }
  | { key: string; state: "failed"; reason: string }
  | { key: string; state: "unknown" };
