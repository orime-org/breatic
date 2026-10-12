// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
type Resolve = (ending: UploadEnding) => void;

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
  waitFor: (storageKey: string) => Promise<UploadEnding>;
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
  const waiting = new Map<string, Resolve[]>();
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
        for (const resolve of resolvers) resolve(status);
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
    waitFor: (storageKey) =>
      new Promise<UploadEnding>((resolve) => {
        const resolvers = waiting.get(storageKey) ?? [];
        waiting.set(storageKey, [...resolvers, resolve]);
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
 * @returns Its ending, once the server has one.
 */
export function waitForUploadEnding(storageKey: string): Promise<UploadEnding> {
  return pageList.waitFor(storageKey);
}
