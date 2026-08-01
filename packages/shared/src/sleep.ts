// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Wait for a duration, optionally cutting the wait short on cancellation.
 *
 * Shared so the retry loop and the poll loop cannot drift into two slightly
 * different timers.
 *
 * The signal matters most where this is used to space out retries: a user
 * who presses stop 20 ms into an eight-second backoff should not wait out
 * the backoff. A bare timer cannot express that, and the retry loop's own
 * cancellation check does not help — it does not run until the sleep ends.
 * @param ms - Milliseconds to wait.
 * @param signal - Cancellation. When it fires, the wait rejects instead of
 *   resolving, so the caller can stop rather than proceed.
 * @returns A promise that resolves once the delay has elapsed.
 * @throws {Error} The signal's reason when cancelled — the caller's own
 *   error if it supplied one.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * Turn the signal's reason into something throwable.
     * @returns The caller's error when it supplied one, else a generic one.
     */
    const cancellation = (): Error =>
      signal?.reason instanceof Error ? signal.reason : new Error("wait cancelled");

    if (signal?.aborted === true) {
      reject(cancellation());
      return;
    }

    /** Release both the timer and the listener, whichever settled first. */
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    /** Cut the wait short when the caller cancels. */
    const onAbort = (): void => {
      cleanup();
      reject(cancellation());
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
