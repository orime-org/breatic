// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Imported for its type: `freshDocument` re-imports the module for each case,
// and the cases should stop compiling when its signatures change.
import * as lazyRouteModule from '@web/app/lazy-route';

/** Where the module records its last reload; the tests drive it directly. */
const RELOAD_KEY = 'breatic.chunkReload';

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

/** A chunk that is no longer on the server. */
function missingChunk(): () => Promise<never> {
  return () =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
}

/**
 * Load the module the way a freshly loaded document does.
 *
 * `vi.resetModules()` clears the registry, so anything the module kept in a
 * variable is gone — which is what a reload does to it. Every case that spans
 * a reload goes through here, because a guard that only holds inside one
 * document does not guard the loop worth stopping.
 * @returns The module's exports, freshly evaluated.
 */
async function freshDocument(): Promise<typeof lazyRouteModule> {
  vi.resetModules();
  return import('@web/app/lazy-route');
}

/** A round number to hang the document timeline off. */
const T0 = new Date('2026-09-17T00:00:00Z').getTime();

/**
 * Say when this document started and what the clock reads.
 *
 * The guard compares a stored timestamp against `performance.timeOrigin`, and
 * a reload gives the next document a later one. jsdom keeps a single origin
 * for the whole run, so the cases that span a reload set it themselves.
 * @param started - The document's `performance.timeOrigin`.
 * @param now - What `Date.now()` reads; defaults to the document's start.
 */
function documentStartedAt(started: number, now = started): void {
  vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(started);
  vi.setSystemTime(now);
}

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  documentStartedAt(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchRouteChunk', () => {
  it('hands back the module when it arrives', async () => {
    const reload = watchReload();
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(() => Promise.resolve({ default: 'page' }))).resolves.toEqual({
      default: 'page',
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a chunk cannot be fetched', async () => {
    const reload = watchReload();
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again on the document its own reload produced', async () => {
    // A build that is broken for some other reason fails again on the new
    // document; reloading for that one too is a loop the reader can neither
    // leave nor see.
    const reload = watchReload();

    const before = await freshDocument();
    await expect(before.fetchRouteChunk(missingChunk())).rejects.toThrow();

    // The reload it asked for: a new document, started a moment later.
    documentStartedAt(T0 + 1_000);
    const after = await freshDocument();
    await expect(after.fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('holds even when this document took far longer than the window to fail', async () => {
    // The reader is on a weak link: the entry bundle alone takes half a minute,
    // so the failure lands long after the reload that produced this document.
    // Measured before this was anchored to the document: a page chunk that
    // stays gone and an entry chunk delayed 11s produced six documents in
    // sixty seconds, 11s apart, with the loading screen up the whole time.
    const reload = watchReload();
    documentStartedAt(T0, T0 + 30_000);
    sessionStorage.setItem(RELOAD_KEY, String(T0 - 100));
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads for a mark left by an earlier visit', async () => {
    // A tab that recovered hours ago, kept open, and met a fresh deploy: the
    // old mark says nothing about this document.
    const reload = watchReload();
    sessionStorage.setItem(RELOAD_KEY, String(T0 - 3_600_000));
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('gives the tab its recovery back once a chunk arrives', async () => {
    // Landing on the page is what says the reload worked. Leaving the mark
    // would spend this tab's one reload on a deploy that already succeeded.
    sessionStorage.setItem(RELOAD_KEY, String(T0 - 100));
    const { fetchRouteChunk } = await freshDocument();

    await fetchRouteChunk(() => Promise.resolve({ default: 'page' }));

    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it('does not reload at all when the session store is unreachable', async () => {
    // With nowhere to record the reload, nothing can stop the next document
    // from reloading again. The error reaches the reader instead, and a
    // refresh is theirs to make.
    const reload = watchReload();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the record cannot be written', async () => {
    const reload = watchReload();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('treats an unreadable record as no record', async () => {
    const reload = watchReload();
    sessionStorage.setItem(RELOAD_KEY, 'not-a-time');
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

interface BoundaryProps {
  /** The tree to render, and to replace with nothing when it throws. */
  children: React.ReactNode;
}

/** Catches the render error a failed chunk produces, so the test can assert on the reload. */
class Boundary extends React.Component<BoundaryProps, { failed: boolean }> {
  /**
   * @param props - The component props.
   */
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  /**
   * @returns The state that records the failure.
   */
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /**
   * @returns The children, or the failure marker once one of them threw.
   */
  override render(): React.ReactNode {
    return this.state.failed
      ? React.createElement('div', { 'data-testid': 'boundary' })
      : this.props.children;
  }
}

describe('lazyRoute', () => {
  it('carries the recovery into the component it returns', async () => {
    // `lazyRoute` is what the route table calls, and a version of it that
    // skipped `fetchRouteChunk` would look identical there. This drives the
    // component itself rather than the helper behind it.
    vi.useRealTimers();
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(missingChunk());

    render(
      React.createElement(
        Boundary,
        null,
        React.createElement(React.Suspense, { fallback: null }, React.createElement(Page)),
      ),
    );

    expect(await screen.findByTestId('boundary')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
