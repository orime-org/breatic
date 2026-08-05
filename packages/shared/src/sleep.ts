// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Wait for a duration, optionally cutting the wait short on cancellation.
 *
 * Internal to this package: the retry loop is its only caller, and it is not
 * exported. An earlier version named the browser upload and the worker as
 * consumers; neither can reach it now, and neither did.
 *
 * The signal is what makes it worth having over a bare timer. It spaces out
 * retries, and a caller who presses stop partway into a wait should not have
 * to sit through the rest of it — the loop's own cancellation check cannot
 * help, because it does not run until the wait ends.
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
