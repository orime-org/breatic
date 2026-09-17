// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { reloadOnStaleChunk } from '@web/app/reload-on-stale-chunk';

/**
 * Replace `window.location.reload` with a spy for one test.
 * @returns The spy, which records each reload the code under test asks for.
 */
function watchReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);
  return reload;
}

/**
 * Whether a promise has settled, without waiting on it.
 * @param promise - The promise to watch.
 * @returns A function answering whether it settled by the time it is called.
 */
function settlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  return () => settled;
}

const STALE = (): Promise<never> =>
  Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reloadOnStaleChunk', () => {
  it('hands back the module when it arrives', async () => {
    const reload = watchReload();
    const module = { default: 'the page' };

    await expect(reloadOnStaleChunk(async () => module)).resolves.toBe(module);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the chunk cannot be fetched', async () => {
    const reload = watchReload();

    const hasSettled = settlement(reloadOnStaleChunk(STALE));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // The reader must not see an error screen flash before the reload lands,
    // so the promise the router is waiting on never settles.
    expect(hasSettled()).toBe(false);
  });

  it('gives up rather than reloading a second time', async () => {
    // A chunk that arrives and then throws fails again after the reload. Two
    // reloads would be a loop the reader cannot leave, so the second failure
    // is handed to the error boundary instead.
    const first = watchReload();
    void reloadOnStaleChunk(STALE);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    vi.restoreAllMocks();
    const second = watchReload();

    await expect(reloadOnStaleChunk(STALE)).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    );
    expect(second).not.toHaveBeenCalled();
  });

  it('forgets the reload once a chunk arrives', async () => {
    const first = watchReload();
    void reloadOnStaleChunk(STALE);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    await reloadOnStaleChunk(async () => ({ default: 'the page' }));

    vi.restoreAllMocks();
    const later = watchReload();
    void reloadOnStaleChunk(STALE);

    // A later deploy in the same session is a fresh stale chunk, not the loop
    // the guard above exists to stop.
    await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1));
  });
});
