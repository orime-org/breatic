// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stop waiting for a store that is taking too long (#40).
 *
 * WHY A DEADLINE AT ALL. The yjs pool is built with only a name and a size
 * (`core/src/db/client.ts`), so it inherits postgres.js's 30-second connect
 * timeout — many times the whole graceful-shutdown budget. A round that waits
 * that long for one document never reaches the documents behind it, and each
 * of those is holding unstored content too.
 *
 * WHAT IT DOES NOT DO. It does not cancel anything — nothing can cancel a
 * database write in flight — and it does not release the document's save mutex,
 * which the library holds for the whole of `storeDocumentHooks`. Giving up here
 * makes THIS caller stop waiting and nothing else. The abandoned write may
 * still land later, which is why a store carries a ticket the tracker rejects
 * once the document has moved on.
 *
 * WHY IT REPORTS RATHER THAN THROWS. Giving up and being refused are different
 * events, and the caller has to be able to say which happened: an operator
 * reading "the database rejected this" acts differently from one reading "we
 * stopped waiting; it may well have landed". Throwing would flatten both into
 * one catch block, which is exactly how they came to be reported as the same
 * thing.
 */

/** How one bounded wait turned out. */
export interface TimedOutcome {
  /** True when the deadline passed before the work finished. */
  timedOut: boolean;
  /** What the work threw, if it threw before the deadline. */
  error?: unknown;
}

/**
 * Wait for a promise, giving up after a deadline.
 * @param work - The operation to wait for.
 * @param timeoutMs - How long to wait before giving up.
 * @returns Which of the two happened. Never rejects: neither giving up nor the
 *   work throwing says whether the content landed, and the caller answers that
 *   from the tracker instead.
 */
export async function runWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<TimedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timed out");
  try {
    const settled = await Promise.race([
      work.then(
        () => undefined,
        (error: unknown) => ({ error }),
      ),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (settled === TIMED_OUT) return { timedOut: true };
    return settled ? { timedOut: false, error: settled.error } : { timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
