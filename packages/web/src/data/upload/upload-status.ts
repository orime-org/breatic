// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page's list of uploads still finishing (inner#1367 §4.2a).
 *
 * Finishing an upload answers 202 and runs on the server as a job. Every
 * upload this page is waiting on goes in one list, and one timer asks the
 * server about all of them each round, up to `UPLOAD_STATUS_MAX_KEYS` per
 * request — the batch shape of AWS Batch's
 * `DescribeJobs` and Google AIP-231 — taking each out as its ending arrives.
 * The interval is the one the last answer named in `Retry-After`, the way an
 * Azure Resource Manager client polls a long-running operation.
 */

import {
  UPLOAD_STATUS_MAX_KEYS,
  type UploadStatus,
} from '@breatic/shared';
import { assetsApi } from '@web/data/api/assets';

/** How one upload ended, as the server told it: any status but still finishing. */
export type UploadEnding = Exclude<UploadStatus, { state: 'finishing' }>;

/** Hands one waiter its upload's ending. */
interface UploadObserver {
  settle: (ending: UploadEnding) => void;
}

/** What the list needs from the network and the clock. */
export interface UploadStatusListDeps {
  /** Ask how these uploads ended, at most `UPLOAD_STATUS_MAX_KEYS` at once. */
  fetchStatus: (keys: readonly string[]) => Promise<{
    items: UploadStatus[];
    retryAfterSeconds: number | null;
  }>;
  /** The interval to wait before the server has named one. */
  pollSeconds: () => Promise<number>;
  /** Run `fire` once after `ms`. */
  setTimer: (fire: () => void, ms: number) => void;
}

/** The list a page keeps. */
export interface UploadStatusList {
  /**
   * Wait for the ending of the upload under `storageKey`.
   * @param storageKey - The key its finish was queued under.
   * @returns Its ending, once the server has one.
   */
  waitFor: (storageKey: string, signal?: AbortSignal) => Promise<UploadEnding>;
}

/**
 * Split `keys` into requests no larger than one may carry.
 * @param keys - Every key waiting.
 * @returns The batches, in order.
 */
function batchesOf(keys: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += UPLOAD_STATUS_MAX_KEYS) {
    batches.push(keys.slice(i, i + UPLOAD_STATUS_MAX_KEYS));
  }
  return batches;
}

/**
 * Make a list of uploads still finishing.
 * @param deps - The network and the clock.
 * @returns The list.
 */
export function createUploadStatusList(deps: UploadStatusListDeps): UploadStatusList {
  const waiting = new Map<string, Set<UploadObserver>>();
  let scheduled = false;
  let retryAfterSeconds: number | null = null;

  /**
   * Ask about every upload still waiting, then schedule the next round while
   * any is left. A round that fails leaves the list as it was.
   * @returns Nothing once the round is done.
   */
  const round = async (): Promise<void> => {
    for (const keys of batchesOf([...waiting.keys()])) {
      let answer;
      try {
        answer = await deps.fetchStatus(keys);
      } catch {
        continue;
      }
      if (answer.retryAfterSeconds !== null) retryAfterSeconds = answer.retryAfterSeconds;
      for (const status of answer.items) {
        const resolvers = waiting.get(status.key);
        if (status.state === 'finishing' || resolvers === undefined) continue;
        waiting.delete(status.key);
        for (const observer of resolvers) observer.settle(status);
      }
    }
    scheduled = false;
    schedule();
  };

  /** Start the timer when something is waiting and none is running. */
  const schedule = (): void => {
    if (scheduled || waiting.size === 0) return;
    scheduled = true;
    void (async () => {
      let seconds;
      try {
        seconds = retryAfterSeconds ?? (await deps.pollSeconds());
      } catch {
        // The knobs are fetched and cached before any upload reaches its
        // finish, so this does not fail in a running session; if it ever does,
        // the next upload to wait asks again.
        scheduled = false;
        return;
      }
      deps.setTimer(() => {
        void round();
      }, seconds * 1000);
    })();
  };

  return {
    waitFor: (storageKey, signal) =>
      new Promise<UploadEnding>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Upload observation cancelled', 'AbortError'));
          return;
        }
        let settled = false;
        /**
         * End only this observer when its document releases it.
         * @throws {never} Never directly.
         */
        const abort = (): void => {
          if (settled) return;
          settled = true;
          const observers = waiting.get(storageKey);
          observers?.delete(observer);
          if (observers?.size === 0) waiting.delete(storageKey);
          signal?.removeEventListener('abort', abort);
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
        schedule();
      }),
  };
}

/** The page's list, against the real server and timers. */
const pageList = createUploadStatusList({
  fetchStatus: (keys) => assetsApi.fetchUploadStatus(keys),
  pollSeconds: async () => (await assetsApi.fetchUploadConfig()).uploadStatusPollSeconds,
  setTimer: (fire, ms) => {
    setTimeout(fire, ms);
  },
});

/**
 * Wait for the ending of an upload whose finish was queued.
 * @param storageKey - The key its finish was queued under.
 * @param signal - Ends this observer when its owning document closes.
 * @returns Its ending, once the server has one.
 * @throws {DOMException} When the observer is cancelled.
 */
export function waitForUploadEnding(storageKey: string, signal?: AbortSignal): Promise<UploadEnding> {
  return pageList.waitFor(storageKey, signal);
}
