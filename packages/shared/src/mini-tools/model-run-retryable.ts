// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** A failure reason reduced to its categories: one per item (person or window) and the step outside every item. */
export interface ModelRunFailure { items: readonly { category: string }[]; shared: { category: string } | null }

/**
 * Whether retrying a failed model run's failed items can succeed (execution design §10.5 last paragraph): stopped items
 * follow what stopped them and are ignored; every other item, and the shared step, must be a timeout (an expiry included)
 * or failed.
 * @param failure - The reason's categories.
 * @returns True when the run is retryable.
 * @throws {never} Never.
 */
export function modelRunRetryable(failure: ModelRunFailure): boolean {
  const failed = [...failure.items.filter((item) => item.category !== "stopped"), ...(failure.shared === null ? [] : [failure.shared])];
  return failed.length > 0 && failed.every((item) => item.category === "timeout" || item.category === "failed");
}
