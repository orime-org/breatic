// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How an upload ended (inner#1367 §4.2a, #1580): finishing answers 202, and the
 * ending reaches the page through the `upload:ended` message or, on the Studio
 * page, through its one poll, which asks about several uploads in one request.
 */

/**
 * How many uploads one status request may ask about: as many as AWS Batch's
 * `DescribeJobs` takes, enough for every tile of one grid export in one round.
 */
export const UPLOAD_STATUS_MAX_KEYS = 100;

/**
 * How long the Studio page waits between polls before any answer has named the interval, in ms (#1580): the default
 * of `poll_interval_ms` in `config/studio-page.yaml`, which every answer then names as `nextPollMs`.
 */
export const STUDIO_PAGE_POLL_DEFAULT_MS = 2000;

/**
 * How many Projects one Studio page poll may ask about while they are being copied (inner#1706): as many as uploads,
 * one request's worth; a page with more asks about them in turn.
 */
export const COPYING_POLL_MAX_IDS = 100;

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
