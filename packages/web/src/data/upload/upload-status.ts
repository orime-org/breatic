// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page's table of uploads waiting for their ending (inner#1367 §4.2a, #1580).
 *
 * Finishing an upload answers 202 and runs on the server as a job. An upload is waited for from the moment its ticket
 * names its key, before any byte moves, so an ending that comes before the finish request returns still finds its
 * waiter. The table asks the server nothing and keeps no timer: whatever wakes the page hands it an ending through
 * {@link settleUploadEnding}, the Project page from the `upload:ended` message and the Studio page from its one poll,
 * which reads the waiting keys from {@link waitingUploadKeys}. A wait belongs to the page that started it and ends
 * with it, through the signal it was given.
 */

import type { UploadStatus } from '@breatic/shared';

/** How one upload ended, as the server told it: any status but still finishing. */
export type UploadEnding = Exclude<UploadStatus, { state: 'finishing' }>;

/** Hands one waiter its upload's ending. */
interface UploadObserver {
  settle: (ending: UploadEnding) => void;
}

const waiting = new Map<string, Set<UploadObserver>>();

/**
 * Wait for the ending of the upload under `storageKey`. The wait is registered before this returns.
 * @param storageKey - The key its ticket named.
 * @param signal - Ends this wait when its page or upload stops.
 * @returns Its ending, once one is handed in.
 * @throws {DOMException} `AbortError` when the wait is stopped first.
 */
export function waitForUploadEnding(storageKey: string, signal?: AbortSignal): Promise<UploadEnding> {
  return new Promise<UploadEnding>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload observation cancelled', 'AbortError'));
      return;
    }
    let settled = false;
    /** Take only this waiter back when its owner stops. */
    const abort = (): void => {
      if (settled) return;
      settled = true;
      const observers = waiting.get(storageKey);
      observers?.delete(observer);
      if (observers?.size === 0) waiting.delete(storageKey);
      reject(new DOMException('Upload observation cancelled', 'AbortError'));
    };
    const observer: UploadObserver = {
      settle: (ending) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve(ending);
      },
    };
    const observers = waiting.get(storageKey) ?? new Set<UploadObserver>();
    observers.add(observer);
    waiting.set(storageKey, observers);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Hand an upload's status to whoever waits for it; a status still finishing, or one nobody waits for, changes nothing.
 * @param status - How the server says the upload stands.
 */
export function settleUploadEnding(status: UploadStatus): void {
  if (status.state === 'finishing') return;
  const observers = waiting.get(status.key);
  if (observers === undefined) return;
  waiting.delete(status.key);
  for (const observer of observers) observer.settle(status);
}

/**
 * The keys some wait is registered for.
 * @returns Them, in the order they were first waited for.
 */
export function waitingUploadKeys(): string[] {
  return [...waiting.keys()];
}
