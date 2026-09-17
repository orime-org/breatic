// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchRouteChunk } from '@web/app/lazy-route';

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
 * A chunk that is no longer on the server, identified the way a real one is.
 *
 * `fetchRouteChunk` keys its record on the factory's source text, which in a
 * build carries the chunk's hashed file name. Each test needs its own key, so
 * the name goes through `toString`.
 * @param name - Stands in for the chunk's file name.
 * @returns A factory that rejects the way a missing module does.
 */
function missingChunk(name: string): () => Promise<never> {
  const load = (): Promise<never> =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
  Object.defineProperty(load, 'toString', { value: () => `import("./${name}")` });
  return load;
}

/**
 * A chunk that arrives, identified the same way.
 * @param name - Stands in for the chunk's file name.
 * @returns A factory that resolves to a module.
 */
function arrivingChunk(name: string): () => Promise<{ default: string }> {
  const load = (): Promise<{ default: string }> =>
    Promise.resolve({ default: name });
  Object.defineProperty(load, 'toString', { value: () => `import("./${name}")` });
  return load;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchRouteChunk', () => {
  it('hands back the module when it arrives', async () => {
    const reload = watchReload();
    const page = arrivingChunk('page');

    await expect(fetchRouteChunk(page)).resolves.toEqual({ default: 'page' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a chunk cannot be fetched', async () => {
    const reload = watchReload();

    await expect(fetchRouteChunk(missingChunk('one'))).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('gives up on the chunk that already spent its reload', async () => {
    // A chunk that arrives and then throws fails the same way after the
    // reload. Reloading again would be a loop the reader cannot leave.
    const reload = watchReload();
    const broken = missingChunk('broken');

    await expect(fetchRouteChunk(broken)).rejects.toThrow();
    await expect(fetchRouteChunk(broken)).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps each chunk of one entry on its own budget', async () => {
    // The three /studio addresses load a layout and then a page. The layout
    // arriving must not re-arm the page's spent reload, and the page failing
    // must not be silenced by the layout having succeeded.
    const reload = watchReload();
    const page = missingChunk('studio-page');

    await expect(fetchRouteChunk(page)).rejects.toThrow();
    await fetchRouteChunk(arrivingChunk('studio-layout'));
    await expect(fetchRouteChunk(page)).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once per chunk when two of them are gone', async () => {
    const reload = watchReload();

    await expect(fetchRouteChunk(missingChunk('a'))).rejects.toThrow();
    await expect(fetchRouteChunk(missingChunk('b'))).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps a bound when the session store is unreachable', async () => {
    const reload = watchReload();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const broken = missingChunk('no-store');

    await expect(fetchRouteChunk(broken)).rejects.toThrow();
    await expect(fetchRouteChunk(broken)).rejects.toThrow();

    // Same chunk in the same document, so the in-memory record answers even
    // with no store to write to.
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
