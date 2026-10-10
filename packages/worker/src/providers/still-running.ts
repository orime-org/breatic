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

import { signalUntil } from "@breatic/shared";

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
 * The task's deadline as the signal every call to an upstream carries
 * (inner#1367). Past the deadline it is already raised, so a call made then
 * fails at once and the run ends the way any call past it does.
 * @param deadlineAt - The task's deadline, in epoch milliseconds.
 * @returns The signal.
 */
export function deadlineSignal(deadlineAt: number): AbortSignal {
  return Date.now() < deadlineAt
    ? signalUntil(deadlineAt)
    : AbortSignal.abort(new TaskDeadlinePassed());
}
