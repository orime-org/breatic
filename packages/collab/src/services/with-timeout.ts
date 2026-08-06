// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stop waiting for a store that is taking too long (#40).
 *
 * Both writers need this and neither can do without it. The yjs pool is built
 * with only a name and a size (`core/src/db/client.ts`), so it inherits
 * postgres.js's 30-second connect timeout — several times the whole
 * graceful-shutdown budget. Waiting that long means the timed round never
 * reaches the documents behind this one, and on shutdown it also means the
 * document's save mutex is still held when the library decides whether to run
 * the unload gate, so the gate is skipped and even the rescue file is lost.
 *
 * It does NOT cancel anything — nothing can cancel a database write in
 * flight. The abandoned write may still land later, which is why a store
 * carries a ticket the tracker can reject once the document has moved on.
 */

/**
 * Wait for a promise, giving up after a deadline.
 * @param work - The operation to wait for.
 * @param timeoutMs - How long to wait before giving up.
 * @returns Resolves when the work finishes or the deadline passes, whichever
 *   comes first. Never rejects on timeout — giving up is not an error, and
 *   whether the content landed is answered by the tracker, not by this call.
 */
export async function runWithTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
