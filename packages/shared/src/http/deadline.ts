// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's deadline, carried down every call it makes (inner#1367).
 *
 * One instant per task — when it was opened plus its two-hour budget — and no
 * call on its chain has a figure of its own. It reaches the transport twice:
 * as a signal, which holds across a call's resends, and as the per-delivery
 * timeout, so the transport's own default never ends a delivery sooner. gRPC
 * propagates deadlines the same way, so a callee can never stretch what its
 * caller had left.
 */

import { MAX_TIMER_MS } from "@shared/http/constants.js";

/**
 * The task's deadline came before its work could finish. The message is the
 * cause code the task row holds.
 */
export class DeadlinePassed extends Error {
  /** Build the error. */
  constructor() {
    super("expired");
    this.name = "DeadlinePassed";
  }
}

/**
 * Throw when the deadline has come, before work that could not finish starts.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param now - The clock now, in epoch ms.
 * @throws {DeadlinePassed} When it has.
 */
export function assertBeforeDeadline(deadlineAt: number, now: number = Date.now()): void {
  if (now >= deadlineAt) throw new DeadlinePassed();
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
  assertBeforeDeadline(deadlineAt, now);
  const left = deadlineAt - now;
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

/** What a call on a task's chain hands the transport. */
export interface UntilDeadline {
  /** Raised at the deadline: ends the call and its resends. */
  signal: AbortSignal;
  /** The time left, which each delivery may take. */
  timeoutMs: number;
}

/**
 * The transport options of a call that must finish by the task's deadline.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param now - The clock now, in epoch ms.
 * @returns The signal and the time left.
 * @throws {DeadlinePassed} When the deadline has already come.
 */
export function untilDeadline(deadlineAt: number, now: number = Date.now()): UntilDeadline {
  const signal = signalUntil(deadlineAt, now);
  return { signal, timeoutMs: Math.min(deadlineAt - now, MAX_TIMER_MS) };
}

/**
 * The same, for a call that still goes out once the deadline has come — the
 * read that finds a job's ending, the lookup that prices work which finished
 * right at it — under the transport's own bound.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param now - The clock now, in epoch ms.
 * @returns The options, or undefined once the deadline has come.
 */
export function untilDeadlineIfAhead(
  deadlineAt: number,
  now: number = Date.now(),
): UntilDeadline | undefined {
  return now < deadlineAt ? untilDeadline(deadlineAt, now) : undefined;
}
