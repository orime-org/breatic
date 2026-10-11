// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a pickup does when the work it started is not finished
 * (inner#1337 §3.1).
 *
 * A task waits on an upstream — a prediction, a container job — by going
 * back to the queue between two questions about it, so no worker slot is
 * held while nothing is happening. The waiting ends at the task's two-hour
 * budget (`default_budget_ms` in `config/node-tasks.yaml`).
 */

/**
 * This pickup cannot finish its work yet — the upstream work is still going,
 * the question about it got no usable answer, or no reading place was free:
 * the run goes back to the queue and comes back at `resumeAt`, spending none
 * of its attempts.
 */
export class StillRunning extends Error {
  /**
   * Work that cannot finish on this pickup.
   * @param resumeAt - When to ask again, in epoch milliseconds.
   */
  constructor(readonly resumeAt: number) {
    super("the work cannot finish on this pickup");
    this.name = "StillRunning";
  }
}
