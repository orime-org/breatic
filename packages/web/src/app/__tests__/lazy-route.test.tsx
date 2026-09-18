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

/** What an earlier document left behind: the mark the module writes. */
const SPENT = '1';

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
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

    // The reload it asked for: a new document, with the mark still in session
    // storage because no page reached the screen.
    const after = await freshDocument();
    await expect(after.fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('holds however long this document took to fail', async () => {
    // The reader is on a weak link: the entry bundle alone takes half a minute,
    // so the failure lands long after the reload that produced this document.
    // Measured when the mark had an age limit: a page chunk that stays gone and
    // an entry chunk delayed 11s produced six documents in sixty seconds, 11s
    // apart, with the loading screen up the whole time.
    const reload = watchReload();
    sessionStorage.setItem(RELOAD_KEY, SPENT);
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('holds for a mark of any age, because only a page on screen clears it', async () => {
    // The mark is per tab and the one thing that removes it is a page reaching
    // the reader, so a mark that is still here belongs to a tab that has shown
    // nothing since it reloaded — however long ago that was. Giving that tab a
    // second reload on account of the wait is the loop above.
    const reload = watchReload();
    sessionStorage.setItem(RELOAD_KEY, SPENT);
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('spends one reload when a chunk arrives before the one that is gone', async () => {
    // `/studio` fetches two chunks in one document: the layout resolves, and
    // only then does the Outlet render the index child. A document that
    // handed its budget back on the first arrival would find an absent mark
    // when the second fails and claim another reload — and so would the
    // document after it, forever. Measured before this was pinned: 51
    // documents in twelve seconds.
    const reload = watchReload();

    for (let visit = 0; visit < 3; visit += 1) {
      const { fetchRouteChunk } = await freshDocument();
      await fetchRouteChunk(() => Promise.resolve({ default: 'layout' }));
      await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();
    }

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves the document alone when the reader has moved on', async () => {
    // `React.lazy` keeps an abandoned payload alive, so a chunk the reader
    // walked away from still settles here. Reloading then takes away a page
    // they are using and spends the one reload the next deploy needs.
    const reload = vi.fn();
    let href = 'https://app.example/register';
    // Never `{ ...window.location }` here: spreading it inside the getter that
    // replaces it re-enters that getter, so every read of `window.location`
    // throws before reaching a line of what this case names — and the case
    // passes on the exception.
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      reload,
      get href(): string {
        return href;
      },
    } as unknown as Location);
    const { fetchRouteChunk } = await freshDocument();

    await expect(
      fetchRouteChunk(() => {
        // The reader presses Back; the request they left behind fails after.
        href = 'https://app.example/login';
        return Promise.reject(
          new TypeError('Failed to fetch dynamically imported module'),
        );
      }),
    ).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it('hands the budget back once a page module is on screen', async () => {
    // Design §6.1, `SPENT × PAGE_ON_SCREEN` — the only way out of SPENT.
    // Without it a tab that reloaded once for any reason meets every later
    // deploy with no budget and lands on the error screen. Measured: eight
    // hours after the reload, still zero reloads.
    vi.useRealTimers();
    sessionStorage.setItem(RELOAD_KEY, SPENT);
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(async () => ({
      default: () => <div>page</div>,
    }));

    render(
      <React.Suspense fallback={<div>waiting</div>}>
        <Page />
      </React.Suspense>,
    );
    await screen.findByText('page');

    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });

  it('holds the budget while a second chunk is still on its way', async () => {
    // `/studio` fetches two: the layout resolves, and only then does its Outlet
    // render the index child. A boundary commits its children together, so the
    // layout arriving is not a page reaching the reader — treating it as one
    // reopens the loop (measured once at 51 documents in twelve seconds).
    vi.useRealTimers();
    sessionStorage.setItem(RELOAD_KEY, SPENT);
    const { lazyRoute } = await freshDocument();
    const Child = lazyRoute(() => new Promise<never>(() => {}));
    const Layout = lazyRoute(async () => ({
      default: () => <Child />,
    }));

    render(
      <React.Suspense fallback={<div>waiting</div>}>
        <Layout />
      </React.Suspense>,
    );
    await screen.findByText('waiting');

    expect(sessionStorage.getItem(RELOAD_KEY)).toBe(SPENT);
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

  it('treats a record it did not write as the reload already spent', async () => {
    // Nothing else writes this key, so a value in an unexpected shape means
    // the tab has a reload behind it and something garbled the record. The
    // reader gets the error and a refresh of their own rather than a reload
    // this tab cannot account for.
    const reload = watchReload();
    sessionStorage.setItem(RELOAD_KEY, 'not-a-time');
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
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

describe('preloadMatched', () => {
  it('starts the module of every route the address matches', async () => {
    // Nothing the page chunk needs comes out of `/auth/me`, and nothing the
    // index child needs comes out of the layout chunk. Waiting for either is a
    // chain the reader pays a round trip for, so the modules for the whole
    // matched branch start together.
    const { lazyRoute, preloadMatched } = await freshDocument();
    const layout = vi.fn(async () => ({ default: () => null }));
    const child = vi.fn(async () => ({ default: () => null }));
    const Layout = lazyRoute(layout);
    const Child = lazyRoute(child);
    // A guard that shows its own screen instead of its children while it
    // waits: the page underneath is never rendered, so only a walk of the
    // element finds it.
    const Guard = ({ children }: { children?: React.ReactNode }): null => {
      void children;
      return null;
    };

    preloadMatched(
      [
        { route: { element: <Guard><Layout /></Guard> } },
        { route: { element: <Child /> } },
      ],
      true,
    );

    expect(layout).toHaveBeenCalledTimes(1);
    expect(child).toHaveBeenCalledTimes(1);
  });

  it('leaves a guarded branch alone for a reader with no session yet', async () => {
    // Design §6.3: the judgement is "does this branch have a guarded ancestor",
    // not "does this one element carry a wrapper". A layout route's children
    // render inside its Outlet and carry no wrapper of their own, so asking per
    // element withholds the root of the branch and fetches the leaf — which is
    // what the three /studio entries did. Measured on a 4 Mbps link: opening a
    // shared /project link with no session put the sign-in field on screen
    // 502 ms later, behind 2.4 MB of canvas the reader never sees.
    const { lazyRoute, preloadMatched } = await freshDocument();
    const layout = vi.fn(async () => ({ default: () => null }));
    const child = vi.fn(async () => ({ default: () => null }));
    const open = vi.fn(async () => ({ default: () => null }));
    const Layout = lazyRoute(layout);
    const Child = lazyRoute(child);
    const Open = lazyRoute(open);
    const Guard = ({ children }: { children?: React.ReactNode }): null => {
      void children;
      return null;
    };

    preloadMatched(
      [
        { route: { element: <Guard><Layout /></Guard> } },
        { route: { element: <Child /> } },
      ],
      false,
    );
    preloadMatched([{ route: { element: <Open /> } }], false);

    expect(layout).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    // A branch the address reaches without passing a guard is the reader's
    // either way, so it still starts.
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('passes over a route that renders no page', async () => {
    const { preloadMatched } = await freshDocument();

    expect(() => {
      preloadMatched([{ route: { element: <div /> } }, { route: {} }], true);
    }).not.toThrow();
  });

  it('keeps a module that will not load from reaching the reader as an error', async () => {
    // A preload nobody awaits still rejects, and an unhandled rejection is a
    // console error in every browser the reader might be using.
    const reload = watchReload();
    const { lazyRoute, preloadMatched } = await freshDocument();
    const Page = lazyRoute(missingChunk());

    preloadMatched([{ route: { element: <Page /> } }], true);
    await Promise.resolve();

    expect(reload).not.toHaveBeenCalled();
  });
});

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
