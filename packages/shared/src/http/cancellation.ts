// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Composing the caller's cancellation with a deadline of our own.
 *
 * Composed by hand rather than with `AbortSignal.any`, which is not in the
 * browser range this package still has to run in. Doing it here also means the
 * abort reason is ours to choose, so "the deadline fired" and "the person
 * pressed stop" do not arrive looking identical — and telling those apart is
 * what decides whether the request may be replayed.
 *
 * The teardown is the load-bearing part. Detaching from the caller's signal is
 * what lets the transport hold nothing once an attempt ends: a listener left
 * behind pins the response, and the caller's signal may outlive the request by
 * hours.
 */

/** A composed signal plus the teardown that must run when it is no longer needed. */
export interface DeadlineSignal {
  /** Aborts when the caller aborts, or when the budget runs out. */
  signal: AbortSignal;
  /** Whether this signal's own deadline is what fired. */
  expired: () => boolean;
  /** Release the timer and the forwarding listener. Always call it. */
  dispose: () => void;
}

/**
 * Compose the caller's cancellation with a deadline of our own.
 *
 * The distinction it preserves is the reason it exists: an operation that ran
 * out of budget and one a person stopped are different outcomes, and a caller
 * told "aborted" for both cannot tell which happened. `expired()` answers that
 * without inspecting error shapes, which is the same technique the per-attempt
 * deadline uses one module away and for the same reason.
 * @param callerSignal - The caller's cancellation, if any.
 * @param ms - How long this operation may still run.
 * @param described - The error to abort with when the deadline is what fires.
 * @returns The composed signal, a probe for which side fired, and teardown.
 */
export function withDeadline(
  callerSignal: AbortSignal | undefined,
  ms: number,
  described: string,
): DeadlineSignal {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(described));
  }, ms);

  /** Forward the caller's stop, preserving whatever reason it carried. */
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    expired: (): boolean => timedOut,
    dispose: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
