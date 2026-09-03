// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long a task is given before it counts as dead (#186, design §4.6.2).
 *
 * The number is a conservative time: within it the task will certainly finish
 * under normal conditions, and failing to finish means something outside what
 * we promise went wrong. It is the sole basis on which a task is judged dead,
 * so it is computed here from what the server already knows and from the
 * bounds in `config/node-tasks.yaml`.
 *
 * Bias long. Killing a live task costs the user their wait and their credits;
 * judging late costs a longer wait.
 */

import { getStorageConfig, getNodeTaskConfig } from "@breatic/core";

/**
 * The conservative time for one upload, from the size it declared.
 *
 * The transfer estimate runs at `client_put_min_bytes_per_sec` — the slowest
 * rate a part is allowed to move at before the browser gives up on it, so an
 * upload that is still alive is by definition faster than this. On top of it
 * sits the cover reserve: a video's cover is extracted after the bytes land,
 * and the task is not done until that has had its chance.
 * @param sizeBytes - What the ticket request declared.
 * @returns Whole milliseconds, held between the configured bounds.
 */
export function uploadBudgetMs(sizeBytes: number): number {
  const { client_put_min_bytes_per_sec: rate } = getStorageConfig().upload;
  const { min_budget_ms, max_budget_ms, cover_reserve_ms } =
    getNodeTaskConfig().upload;

  // A size that is zero, negative or not a number has no transfer estimate.
  // The ticket endpoint refuses all three long before this, and a deadline
  // has no "cannot say" outlet, so it takes the shortest one on offer.
  const transferMs =
    Number.isFinite(sizeBytes) && sizeBytes > 0
      ? (sizeBytes / rate) * 1000
      : 0;

  const raw = transferMs + cover_reserve_ms;
  return Math.round(Math.min(max_budget_ms, Math.max(min_budget_ms, raw)));
}
