// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two answers a pickup gives when the work it started is not finished
 * (inner#1337 §3.1).
 *
 * A task waits on an upstream — a prediction, a container job — by going
 * back to the queue between two questions about it, so no worker slot is
 * held while nothing is happening. The waiting ends at the task's two-hour
 * budget (`default_budget_ms` in `config/node-tasks.yaml`).
 */

/**
 * The work is still going: the run goes back to the queue and comes back at
 * `resumeAt`, spending none of its attempts.
 */
export class StillRunning extends Error {
  /**
   * Work read while it was still going.
   * @param resumeAt - When to ask again, in epoch milliseconds.
   */
  constructor(readonly resumeAt: number) {
    super("the upstream work is still running");
    this.name = "StillRunning";
  }
}

/**
 * The task's two hours ran out with its work unfinished. The message is the
 * cause code the task row holds.
 */
export class TaskDeadlinePassed extends Error {
  /** A task past its deadline. */
  constructor() {
    super("expired");
    this.name = "TaskDeadlinePassed";
  }
}

/**
 * Throw when the deadline has passed.
 * @param deadlineAt - The task's deadline, in epoch milliseconds.
 * @throws {TaskDeadlinePassed} When it has.
 */
export function assertBeforeDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) throw new TaskDeadlinePassed();
}

/**
 * What a still-going answer means at this moment: wait again before the
 * deadline, end as expired at or after it. Any other error passes through.
 * @param err - What the question about the work threw.
 * @param deadlineAt - The task's deadline, in epoch milliseconds.
 * @returns The error to throw.
 */
export function againOrExpired(err: unknown, deadlineAt: number): unknown {
  return err instanceof StillRunning && Date.now() >= deadlineAt ? new TaskDeadlinePassed() : err;
}
