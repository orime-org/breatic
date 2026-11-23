// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Studio page's one poll (#1580, test spec K-12 to K-26; design §4 and §5.4). The page asks once on mount, then
 * again `nextPollMs` after each answer, with the uploads it is waiting for; it reads the bell or the transfer again
 * only when the answer differs from the one before, and hands every ended upload to its waiter. A hidden tab pauses
 * it, showing the tab again asks at once, and leaving the page stops it. At most one request is out at a time.
 */

import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_STATUS_MAX_KEYS, type UploadStatus } from '@breatic/shared';
import type * as StudioPageModule from '@web/data/api/studio-page';

vi.mock('@web/data/api/studio-page', async (importOriginal) => {
  const actual = await importOriginal<typeof StudioPageModule>();
  return { ...actual, studioPageApi: { ...actual.studioPageApi, poll: vi.fn() } };
});

import { studioPageApi } from '@web/data/api/studio-page';
import { waitForUploadEnding } from '@web/data/upload/upload-status';
import { useStudioPagePoll } from '@web/pages/studio/shell/use-studio-page-poll';

const SLUG = 'acme';

/** One answer of the poll. */
interface Answer {
  notifications: { unread: number; latestAt: string | null };
  transfer: { id: string; status: string; updatedAt: string } | null;
  uploads: UploadStatus[];
  nextPollMs: number;
}

/**
 * An answer, with the parts a case varies.
 * @param over - What differs.
 * @returns The answer.
 */
function answerWith(over: Partial<Answer> = {}): Answer {
  return { notifications: { unread: 1, latestAt: '2026-11-22T00:00:00.000Z' }, transfer: null, uploads: [], nextPollMs: 2000, ...over };
}

const poll = vi.mocked(studioPageApi.poll);
let client = new QueryClient();
let invalidate = vi.spyOn(client, 'invalidateQueries');
let visibility: DocumentVisibilityState = 'visible';

/**
 * Show or hide the tab.
 * @param state - The new visibility.
 */
function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * The hook on a Studio page.
 * @returns The render result.
 */
function mount() {
  return renderHook(() => useStudioPagePoll(SLUG), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

/**
 * Let time pass and every answer that is due settle.
 * @param ms - How long.
 * @returns Once done.
 */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The calls that invalidated exactly this key.
 * @param queryKey - The key.
 * @returns How many.
 */
function invalidations(queryKey: readonly unknown[]): number {
  return invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey)).length;
}

/**
 * Hold one poll's answer until the test gives it.
 * @returns The promise and its two ends.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  poll.mockReset();
  poll.mockResolvedValue(answerWith());
  client = new QueryClient();
  invalidate = vi.spyOn(client, 'invalidateQueries');
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pace', () => {
  it('asks once on mount, and takes the first answer as the baseline', async () => {
    const view = mount();
    await pass(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('K-12 schedules the next request the interval the answer named, not a number of its own', async () => {
    poll.mockResolvedValue(answerWith({ nextPollMs: 5000 }));
    const view = mount();
    await pass(0);
    await pass(4999);
    expect(poll).toHaveBeenCalledTimes(1);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('K-16 sends one request each time the interval comes round', async () => {
    const view = mount();
    await pass(0);
    await pass(2000);
    await pass(2000);
    expect(poll).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('K-26 keeps at most one request out while an answer is slow', async () => {
    const slow = deferred<Answer>();
    const view = mount();
    await pass(0);
    poll.mockReturnValueOnce(slow.promise);
    await pass(2000);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(20_000);
    expect(poll).toHaveBeenCalledTimes(2);
    slow.resolve(answerWith());
    await pass(0);
    await pass(2000);
    expect(poll).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('K-20 tries again the last named interval after a request fails', async () => {
    poll.mockResolvedValueOnce(answerWith({ nextPollMs: 3000 }));
    const view = mount();
    await pass(0);
    poll.mockRejectedValueOnce(new Error('network'));
    await pass(3000);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(2999);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(3);
    view.unmount();
  });
});

describe('what an answer reads again', () => {
  it('K-13 reads the bell again only when its count or newest time changed', async () => {
    poll
      .mockResolvedValueOnce(answerWith())
      .mockResolvedValueOnce(answerWith())
      .mockResolvedValueOnce(answerWith({ notifications: { unread: 2, latestAt: '2026-11-22T00:00:00.000Z' } }))
      .mockResolvedValueOnce(answerWith({ notifications: { unread: 2, latestAt: '2026-11-22T00:01:00.000Z' } }));
    const view = mount();
    await pass(0);
    await pass(2000);
    expect(invalidations(['notifications', 'unread'])).toBe(0);
    await pass(2000);
    expect(invalidations(['notifications', 'unread'])).toBe(1);
    await pass(2000);
    expect(invalidations(['notifications', 'unread'])).toBe(2);
    view.unmount();
  });

  it('K-14 reads the Studio\'s transfer again only when it changed', async () => {
    const offer = { id: 't-1', status: 'pending', updatedAt: '2026-11-22T00:00:00.000Z' };
    poll
      .mockResolvedValueOnce(answerWith())
      .mockResolvedValueOnce(answerWith())
      .mockResolvedValueOnce(answerWith({ transfer: offer }))
      .mockResolvedValueOnce(answerWith({ transfer: offer }));
    const view = mount();
    await pass(0);
    await pass(2000);
    expect(invalidations(['studio-transfer', 'live', SLUG])).toBe(0);
    await pass(2000);
    expect(invalidations(['studio-transfer', 'live', SLUG])).toBe(1);
    await pass(2000);
    expect(invalidations(['studio-transfer', 'live', SLUG])).toBe(1);
    view.unmount();
  });

  it('K-15 asks about exactly the uploads waiting, none when none wait, and hands each ending to its waiter', async () => {
    const view = mount();
    await pass(0);
    expect(poll.mock.calls[0]![1] ?? []).toEqual([]);
    const a = waitForUploadEnding('covers/a.png');
    const b = waitForUploadEnding('covers/b.png');
    const ended: UploadStatus = {
      key: 'covers/a.png', state: 'completed',
      result: { assetId: 'asset-a', fileUrl: 'https://assets.example.test/a.png', kind: 'image', width: 64, height: 48 },
    };
    poll.mockResolvedValueOnce(answerWith({ uploads: [ended, { key: 'covers/b.png', state: 'finishing' }] }));
    await pass(2000);
    expect([...(poll.mock.calls[1]![1] as string[])].sort()).toEqual(['covers/a.png', 'covers/b.png']);
    await expect(a).resolves.toEqual(ended);
    poll.mockResolvedValueOnce(answerWith({ uploads: [{ key: 'covers/b.png', state: 'failed', reason: 'empty' }] }));
    await pass(2000);
    expect(poll.mock.calls[2]![1]).toEqual(['covers/b.png']);
    await expect(b).resolves.toEqual({ key: 'covers/b.png', state: 'failed', reason: 'empty' });
    view.unmount();
  });
});

describe('while running', () => {
  it('K-17 pauses when the tab is hidden', async () => {
    const view = mount();
    await pass(0);
    setVisibility('hidden');
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('K-18 changes nothing when the tab is shown again while it runs', async () => {
    const view = mount();
    await pass(0);
    setVisibility('visible');
    await pass(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await pass(2000);
    expect(poll).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('K-19 stops when the page goes, and an answer still on its way changes nothing', async () => {
    const late = deferred<Answer>();
    const view = mount();
    await pass(0);
    poll.mockReturnValueOnce(late.promise);
    await pass(2000);
    view.unmount();
    late.resolve(answerWith({ notifications: { unread: 9, latestAt: '2026-11-22T00:09:00.000Z' } }));
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('while paused', () => {
  it('K-21 and K-22 sends nothing however long, and another hide changes nothing', async () => {
    const view = mount();
    await pass(0);
    setVisibility('hidden');
    await pass(10 * 60_000);
    setVisibility('hidden');
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('K-23 asks at once when the tab is shown, then runs again', async () => {
    const view = mount();
    await pass(0);
    setVisibility('hidden');
    await pass(60_000);
    setVisibility('visible');
    await pass(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(2000);
    expect(poll).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('K-24 stops when the page goes', async () => {
    const view = mount();
    await pass(0);
    setVisibility('hidden');
    view.unmount();
    setVisibility('visible');
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('K-25 ignores an answer that comes back after the tab was hidden, and starts nothing from it', async () => {
    const late = deferred<Answer>();
    const view = mount();
    await pass(0);
    poll.mockReturnValueOnce(late.promise);
    await pass(2000);
    setVisibility('hidden');
    late.resolve(answerWith({ notifications: { unread: 9, latestAt: '2026-11-22T00:09:00.000Z' } }));
    await pass(60_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

describe('many uploads waiting', () => {
  it('asks about at most the request limit at once, and every waiting key in turn', async () => {
    const keys = Array.from({ length: UPLOAD_STATUS_MAX_KEYS + 50 }, (_, i) => `uploads/many-${i}.png`);
    const page = new AbortController();
    for (const key of keys) void waitForUploadEnding(key, page.signal).catch(() => undefined);
    const view = mount();
    await pass(0);
    await pass(2000);
    const asked = poll.mock.calls.map(([, sent]) => sent as string[]);
    expect(asked).toHaveLength(2);
    for (const sent of asked) expect(sent.length).toBeLessThanOrEqual(UPLOAD_STATUS_MAX_KEYS);
    expect(new Set(asked.flat())).toEqual(new Set(keys));
    view.unmount();
    page.abort();
  });
});
