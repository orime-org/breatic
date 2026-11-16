// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a pickup does when the work it started is not finished
 * (inner#1337 §3.1).
 *
 * A task waits on an upstream — a prediction, a container job — by going
 * back to the queue between two questions about it, so no worker slot is
 * held while nothing is happening. The waiting ends at the task's two-hour
 * budget (`default_budget_ms` in `config/node-tasks.yaml`). A task waiting for
 * a free running slot goes back the same way (inner#1968).
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
   * @param publishFailures - Signals to the canvas that did not go out, for the caller to log.
   */
  constructor(readonly resumeAt: number, readonly publishFailures: readonly unknown[] = []) {
    super("the work cannot finish on this pickup");
    this.name = "StillRunning";
  }
}
