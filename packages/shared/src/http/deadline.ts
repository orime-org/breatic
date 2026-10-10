// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's deadline, carried down every call it makes (inner#1367).
 *
 * One instant per task — when it was opened plus its two-hour budget — and no
 * call on its chain has a figure of its own. Passed as a signal because a
 * signal holds across a call's resends, where a per-delivery timeout would
 * start over on each: gRPC propagates deadlines the same way, so a callee can
 * never stretch what its caller had left.
 */

import { MAX_TIMER_MS } from "@shared/http/constants.js";

/** The task's deadline came before the call could finish. */
export class DeadlinePassed extends Error {
  /** Build the error. */
  constructor() {
    super("the task's deadline has passed");
    this.name = "DeadlinePassed";
  }
}

/**
 * A signal raised at the deadline.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param now - The clock now, in epoch ms.
 * @returns The signal, whose reason is a {@link DeadlinePassed}.
 * @throws {DeadlinePassed} When the deadline has already come, so nothing is
 *   started that could not finish.
 */
export function signalUntil(deadlineAt: number, now: number = Date.now()): AbortSignal {
  const left = deadlineAt - now;
  if (!(left > 0)) throw new DeadlinePassed();
  const controller = new AbortController();
  // A run with no deadline of its own is never cut here. A timer cannot hold
  // more than MAX_TIMER_MS and rewrites anything larger to one millisecond.
  if (left > MAX_TIMER_MS) return controller.signal;
  const timer = setTimeout(() => controller.abort(new DeadlinePassed()), left);
  // A task that ends early leaves this pending for the rest of its two
  // hours; in Node it must not hold the process open for that.
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}
