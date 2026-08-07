// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stop waiting for the alert transport (#40). Its one caller is
 * `store-alert.ts`.
 *
 * NOT FOR STORING, and it used to be. A store is one event with two outcomes —
 * it lands or it does not — and only the write itself can say which. A clock
 * racing it cancels nothing, so giving up produces no answer at all, just a
 * third state that then got the document rescued to disk and an operator mailed
 * about it. Three such alerts fired in smoke against a database answering in
 * 250ms. Every store path now waits for its answer.
 *
 * WHY THE ALERT IS DIFFERENT. It carries no content — the rescue file is
 * already on disk before it is sent — and its failure mode is nobody being
 * told, not anything being lost. What it must not do is hold the caller: the
 * gate awaits it inside `beforeUnloadDocument`, and the transport is built
 * without timeout options, so it inherits nodemailer's two-minute connection
 * timeout. An unreachable SMTP host during a database outage would hold every
 * unloading document in memory for two minutes each.
 *
 * WHAT IT DOES NOT DO. It does not cancel anything. Giving up here makes THIS
 * caller stop waiting and nothing else; the send may still complete afterwards.
 *
 * WHY IT REPORTS RATHER THAN THROWS. Giving up and being refused are different
 * events, and the caller says which in its log line.
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
