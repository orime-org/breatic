// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a task that failed is settled (inner#1367).
 *
 * Every call on a task's chain is bounded by its deadline, so a task cut
 * there fails with whatever the cut call threw. Its ending is the deadline's
 * all the same, and every place a task row is settled reads it from here, so
 * a reader sees one ending for a task that ran out of time whichever call was
 * running when it did.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param now - The clock now, in epoch ms.
 * @returns `expired` once the deadline has come, `failed` before it.
 */
export function failureOutcome(deadlineAt: number, now: number = Date.now()): "expired" | "failed" {
  return now >= deadlineAt ? "expired" : "failed";
}
