// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the running-task gate throws when a task must wait for a free running
 * slot (inner#1968). The worker's own `StillRunning` (inner#1337 §3.1) says
 * the same about upstream work; the worker puts the job back on the queue for
 * either, spending none of its attempts.
 */

/**
 * This pickup cannot start the task yet: its person runs as many tasks as the
 * limit allows, or another pickup of theirs holds the gate. The run goes back
 * to the queue and comes back at `resumeAt`.
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
