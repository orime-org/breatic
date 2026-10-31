// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Wait for a shared refresh while allowing just this caller to leave.
 * @param pending - The shared request, which this function never cancels.
 * @param signal - This turn's stop signal.
 * @returns Completion of the query for a caller still waiting.
 * @throws {unknown} The stop signal's reason when the turn ends.
 */
export async function waitForShared(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return pending;
  return new Promise<void>((resolve, reject) => {
    /**
     * Reject only this wait and leave the directory refresh alive.
     * @throws {never} Never.
     */
    const stop = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener("abort", stop); });
    if (signal.aborted) stop();
  });
}
