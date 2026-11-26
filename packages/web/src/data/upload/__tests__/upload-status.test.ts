// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The page's table of uploads waiting for their ending (#1580, test spec area J, design §3 and §5.3). The table
 * asks the server nothing and keeps no timer; whatever wakes the page hands it an ending: the Project page from the
 * `upload:ended` message, the Studio page from its one poll. One `describe` per state of §5.3, one case per cell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadStatus } from '@breatic/shared';
import type * as AssetsModule from '@web/data/api/assets';

vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsModule>();
  return { ...actual, assetsApi: { ...actual.assetsApi, fetchUploadConfig: vi.fn() } };
});

import { assetsApi } from '@web/data/api/assets';
import { settleUploadEnding, waitForUploadEnding, waitingUploadKeys } from '@web/data/upload/upload-status';

let n = 0;
/**
 * A key no earlier case used; the table lives for the whole page, as it does in the browser.
 * @returns The key.
 */
function freshKey(): string {
  n += 1;
  return `uploads/j-${n}.png`;
}

/**
 * A completed ending for `key`.
 * @param key - The key.
 * @returns The ending.
 */
function completed(key: string): UploadStatus {
  return {
    key,
    state: 'completed',
    result: { assetId: `a-${key}`, fileUrl: `https://assets.example.test/${key}`, kind: 'image', width: 64, height: 48 },
  };
}

/**
 * Watch a wait: what it resolved or rejected with, and how many times.
 * @param wait - The wait.
 * @returns Its record, filled in as it settles.
 */
function watch(wait: Promise<unknown>): { value: unknown; error: unknown; settledTimes: number } {
  const record = { value: undefined as unknown, error: undefined as unknown, settledTimes: 0 };
  wait.then(
    (value) => {
      record.value = value;
      record.settledTimes += 1;
    },
    (error: unknown) => {
      record.error = error;
      record.settledTimes += 1;
    },
  );
  return record;
}

/** Let promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a key waiting', () => {
  it.each([
    ['completed', (key: string): UploadStatus => completed(key)],
    ['failed', (key: string): UploadStatus => ({ key, state: 'failed', reason: 'over_cap' })],
    ['transferred', (key: string): UploadStatus => ({ key, state: 'transferred' })],
  ] as const)('J-10 ends with the %s ending handed to it', async (_state, ending) => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    settleUploadEnding(ending(key));
    await flush();
    expect(wait.value).toEqual(ending(key));
    expect(waitingUploadKeys()).not.toContain(key);
  });

  it('J-11 ends with the ending the Studio poll hands it', async () => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    expect(waitingUploadKeys()).toContain(key);
    settleUploadEnding(completed(key));
    await flush();
    expect(wait.value).toEqual(completed(key));
  });

  it('J-18 keeps waiting when the poll says it is still finishing', async () => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    settleUploadEnding({ key, state: 'finishing' });
    await flush();
    expect(wait.settledTimes).toBe(0);
    expect(waitingUploadKeys()).toContain(key);
    settleUploadEnding(completed(key));
    await flush();
    expect(wait.value).toEqual(completed(key));
  });

  it('J-12 is dropped when its page goes away, and nothing is handed to it afterwards', async () => {
    const key = freshKey();
    const page = new AbortController();
    const wait = watch(waitForUploadEnding(key, page.signal));
    page.abort();
    await flush();
    expect((wait.error as DOMException).name).toBe('AbortError');
    expect(waitingUploadKeys()).not.toContain(key);
    settleUploadEnding(completed(key));
    await flush();
    expect(wait.settledTimes).toBe(1);
  });

  it('J-13 stays waiting while no message comes, with no request and no timer of its own', async () => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(wait.settledTimes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(assetsApi.fetchUploadConfig).not.toHaveBeenCalled();
    settleUploadEnding(completed(key));
  });

  it('J-19 ends every waiter on the same key', async () => {
    const key = freshKey();
    const first = watch(waitForUploadEnding(key));
    const second = watch(waitForUploadEnding(key));
    settleUploadEnding(completed(key));
    await flush();
    expect(first.value).toEqual(completed(key));
    expect(second.value).toEqual(completed(key));
  });

  it('J-19 keeps the other waiter when one on the same key goes away', async () => {
    const key = freshKey();
    const page = new AbortController();
    const gone = watch(waitForUploadEnding(key, page.signal));
    const kept = watch(waitForUploadEnding(key));
    page.abort();
    await flush();
    expect(waitingUploadKeys()).toContain(key);
    settleUploadEnding(completed(key));
    await flush();
    expect((gone.error as DOMException).name).toBe('AbortError');
    expect(kept.value).toEqual(completed(key));
  });

  it('is never registered when its page has already gone', async () => {
    const key = freshKey();
    const page = new AbortController();
    page.abort();
    const wait = watch(waitForUploadEnding(key, page.signal));
    await flush();
    expect((wait.error as DOMException).name).toBe('AbortError');
    expect(waitingUploadKeys()).not.toContain(key);
  });
});

describe('a key that ended', () => {
  it('J-14 ignores the message telling it again', async () => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    settleUploadEnding(completed(key));
    settleUploadEnding({ key, state: 'failed', reason: 'empty' });
    await flush();
    expect(wait.settledTimes).toBe(1);
    expect(wait.value).toEqual(completed(key));
  });

  it('J-15 ignores the poll telling it again', async () => {
    const key = freshKey();
    const wait = watch(waitForUploadEnding(key));
    settleUploadEnding(completed(key));
    await flush();
    settleUploadEnding(completed(key));
    await flush();
    expect(wait.settledTimes).toBe(1);
  });

  it('J-16 and J-17 does nothing when its page goes away or the connection drops', async () => {
    const key = freshKey();
    const page = new AbortController();
    const wait = watch(waitForUploadEnding(key, page.signal));
    settleUploadEnding(completed(key));
    await flush();
    page.abort();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(wait.settledTimes).toBe(1);
    expect(wait.value).toEqual(completed(key));
  });
});

describe('the table', () => {
  it('ignores an ending nobody waits for', () => {
    expect(() => settleUploadEnding(completed(freshKey()))).not.toThrow();
  });

  it('J-22 sets no timer and asks the server nothing while keys wait', async () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    for (const key of keys) void waitForUploadEnding(key);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(assetsApi.fetchUploadConfig).not.toHaveBeenCalled();
    for (const key of keys) settleUploadEnding(completed(key));
  });
});
