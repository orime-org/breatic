// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A pickup that cannot finish its work yet: the upstream work is still going,
 * the question about it got no usable answer, no reading place was free
 * (inner#1337 §3.1), or the task waits for a free running slot because its
 * person runs as many tasks as the limit allows (inner#1968). The worker puts
 * the job back on the queue until `resumeAt`, spending none of its attempts,
 * so no worker slot is held while nothing happens; the waiting on upstream
 * work ends at the task's two-hour budget (`default_budget_ms` in
 * `config/node-tasks.yaml`). Published as its own entry,
 * `@breatic/domain/still-running`, so a worker module can load the class
 * without the rest of the package.
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
