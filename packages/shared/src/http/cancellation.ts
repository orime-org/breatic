// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Turning cancellation into something a caller can act on.
 *
 * Two jobs live here because both are about the same thing — a stop that has
 * to arrive with an honest reason attached — and both were previously written
 * inline, more than once each.
 *
 * `abortReason` existed in three copies (the body guard, the wait, and the
 * poll loop), each with its own fallback wording and its own spelling of the
 * aborted check. Three copies of a rule is a rule that drifts, and this one
 * governs what a person sees when they press stop.
 *
 * `withDeadline` is what lets a budget cover a whole operation rather than one
 * request inside it. Composed by hand rather than with `AbortSignal.any`,
 * which is not in the browser range this package still has to run in — and
 * composing it here means the reason is ours to choose, so "the budget ran
 * out" and "the person pressed stop" do not arrive looking identical.
 */

/**
 * The error a cancelled operation should reject with.
 *
 * A caller that aborted with its own `Error` gets that error back — the whole
 * point of `abort(reason)` is that the reason survives — and anything else
 * (a string, a bare `DOMException`, nothing at all) becomes a described one.
 * @param signal - The signal that was aborted, if there was one.
 * @param described - What to say when the caller gave no usable reason.
 * @returns An error safe to throw or reject with.
 */
export function abortReason(signal: AbortSignal | undefined, described: string): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(described);
}

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
