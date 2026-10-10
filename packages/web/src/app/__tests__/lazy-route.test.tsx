// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { captureException } from '@sentry/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@sentry/react')>(),
  captureException: vi.fn(),
}));

// Imported for its type: `freshDocument` re-imports the module for each case,
// and the cases should stop compiling when its signatures change.
import * as lazyRouteModule from '@web/app/lazy-route';
import { LoadingBoundary } from '@web/app/loading-boundary';

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
 * `vi.resetModules()` clears the registry, so each case gets its own copy and
 * nothing one case asked for is counted in the next.
 * @returns The module's exports, freshly evaluated.
 */
async function freshDocument(): Promise<typeof lazyRouteModule> {
  vi.resetModules();
  return import('@web/app/lazy-route');
}

/**
 * Render a lazy route the way the route table does, and wait for it to settle.
 * @param Page - The component `lazyRoute` returned.
 */
async function show(Page: React.ComponentType): Promise<void> {
  render(
    <React.Suspense fallback={<div data-testid='waiting' />}>
      <Page />
    </React.Suspense>,
  );
  await screen.findByTestId(/page-unavailable-screen|page/u);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('lazyRoute', () => {
  it('shows the page once its chunk arrives', async () => {
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(async () => ({
      default: () => <div data-testid='page' />,
    }));

    await show(Page);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    { editingSurface: false, surface: 'ordinary' },
    { editingSurface: true, surface: 'editing' },
  ])('reports the original render failure on the $surface surface', async ({ editingSurface, surface }) => {
    const error = new TypeError('Failed to fetch dynamically imported module');
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(() => Promise.reject(error), { editingSurface });

    await act(async () => {
      render(
        <React.Suspense fallback={<div data-testid='waiting' />}>
          <Page />
        </React.Suspense>,
      );
    });

    expect(vi.mocked(captureException).mock.calls[0]?.[0]).toBe(error);
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      tags: {
        error_boundary: 'route-chunk',
        chunk_stage: 'render',
        chunk_surface: surface,
      },
    });
    expect(reload).not.toHaveBeenCalled();
    if (editingSurface) {
      expect(screen.getByTestId('page-unavailable-screen')).toBeInTheDocument();
    } else {
      expect(screen.getByTestId('waiting')).toBeInTheDocument();
      expect(screen.queryByTestId('page-unavailable-screen')).toBeNull();
    }
  });

  it('reports a preload failure once when the same page is later rendered and preloaded again', async () => {
    const error = new TypeError('Failed to fetch dynamically imported module');
    const reload = watchReload();
    const { lazyRoute, preloadMatched } = await freshDocument();
    const Page = lazyRoute(() => Promise.reject(error), { editingSurface: true });
    const matches = [{ route: { element: <Page /> } }];

    await act(async () => {
      preloadMatched(matches, true);
    });
    expect(vi.mocked(captureException).mock.calls[0]?.[0]).toBe(error);
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      tags: {
        error_boundary: 'route-chunk',
        chunk_stage: 'preload',
        chunk_surface: 'editing',
      },
    });

    await show(Page);
    await act(async () => {
      preloadMatched(matches, true);
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('page-unavailable-screen')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports failures of different pages independently', async () => {
    const error = new TypeError('Failed to fetch dynamically imported module');
    const { lazyRoute, preloadMatched } = await freshDocument();
    const secondError = new TypeError('Failed to fetch dynamically imported module');
    const First = lazyRoute(() => Promise.reject(error));
    const Second = lazyRoute(() => Promise.reject(secondError));

    await act(async () => {
      preloadMatched([
        { route: { element: <First /> } },
        { route: { element: <Second /> } },
      ], true);
    });

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenNthCalledWith(1, error, {
      tags: {
        error_boundary: 'route-chunk',
        chunk_stage: 'preload',
        chunk_surface: 'ordinary',
      },
    });
    expect(captureException).toHaveBeenNthCalledWith(2, secondError, {
      tags: {
        error_boundary: 'route-chunk',
        chunk_stage: 'preload',
        chunk_surface: 'ordinary',
      },
    });
  });

  it('reports nothing while a slow module is pending or after it arrives', async () => {
    const reload = watchReload();
    const { lazyRoute, preloadMatched } = await freshDocument();
    let finish: ((module: { default: React.ComponentType<unknown> }) => void) | undefined;
    const module = new Promise<{ default: React.ComponentType<unknown> }>((resolve) => {
      finish = resolve;
    });
    const Page = lazyRoute(() => module);

    await act(async () => {
      preloadMatched([{ route: { element: <Page /> } }], true);
      render(
        <React.Suspense fallback={<div data-testid='waiting' />}>
          <Page />
        </React.Suspense>,
      );
    });
    expect(screen.getByTestId('waiting')).toBeInTheDocument();
    expect(captureException).not.toHaveBeenCalled();

    await act(async () => {
      finish?.({ default: () => <div data-testid='page' /> });
    });

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(captureException).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('says the page did not load on the one the reader works in', async () => {
    // A reader who kept a tab open across a deploy holds an index.html naming
    // chunks from the previous build. The editing surface is where they were
    // going to work, so it tells them it did not load and hands them the
    // refresh (user 2026-09-18).
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(missingChunk(), { editingSurface: true });

    await show(Page);

    expect(screen.getByTestId('page-unavailable-screen')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves an ordinary page waiting, and reloads nothing', async () => {
    // These read like any web page: the entry does not arrive, and refreshing
    // is the reader's to press. Nothing on any route reloads the tab.
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(missingChunk());

    render(
      <React.Suspense fallback={<div data-testid='waiting' />}>
        <Page />
      </React.Suspense>,
    );
    await screen.findByTestId('waiting');
    await Promise.resolve();

    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('page-unavailable-screen')).toBeNull();
    expect(screen.getByTestId('waiting')).toBeInTheDocument();
  });

  it('refreshes the page when the reader presses the button', async () => {
    // The whole of the recovery is this press. Nothing reloads on its own
    // (user 2026-09-18), so a screen whose button does nothing leaves the
    // reader with no way out at all.
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(missingChunk(), { editingSurface: true });
    await show(Page);

    await userEvent.click(screen.getByRole('button'));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a chunk again once it has failed', async () => {
    // Design §6.1: the payload is READY holding the notice, and the browser's
    // own module map records the failed fetch permanently. Re-entering the
    // route shows the notice again and puts no request on the wire — which is
    // why the notice has to carry the way out.
    const { lazyRoute } = await freshDocument();
    const load = vi.fn(missingChunk());
    const Page = lazyRoute(load, { editingSurface: true });
    await show(Page);

    render(
      <React.Suspense fallback={null}>
        <Page />
      </React.Suspense>,
    );

    expect(await screen.findAllByTestId('page-unavailable-screen')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

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
    // Design §6.2: the judgement is "does this branch have a guarded ancestor",
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

  it('gates a wrapper that holds no page, and opens the boundary that holds none either', async () => {
    // Two wrappers the walk cannot tell apart: a guard written
    // `<Guard><Outlet/></Guard>`, whose page arrives from the child route, and
    // the loading boundary, whose element carries no children because
    // `behindLoadingScreen` puts the table on the route's `children` field.
    // Neither has a page under it. They are told apart by the boundary saying
    // for itself that it renders whatever it is handed. Anything that does not
    // say so decides something, and the gate holds.
    //
    // The real `LoadingBoundary` stands here rather than a stub: that one
    // property on that one component is the whole of the open side, and
    // removing it withholds the entire table from a reader with no remembered
    // session — every entry, `/login` included.
    const { lazyRoute, preloadMatched } = await freshDocument();
    const gated = vi.fn(async () => ({ default: () => null }));
    const open = vi.fn(async () => ({ default: () => null }));
    const Gated = lazyRoute(gated);
    const Open = lazyRoute(open);
    const Outlet = (): null => null;
    const Guard = ({ children }: { children?: React.ReactNode }): null => {
      void children;
      return null;
    };
    preloadMatched(
      [
        { route: { element: <Guard><Outlet /></Guard> } },
        { route: { element: <Gated /> } },
      ],
      false,
    );
    preloadMatched(
      [{ route: { element: <LoadingBoundary /> } }, { route: { element: <Open /> } }],
      false,
    );

    expect(gated).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('passes over a route that renders no page', async () => {
    const { preloadMatched } = await freshDocument();

    expect(() => {
      preloadMatched([{ route: { element: <div /> } }, { route: {} }], true);
    }).not.toThrow();
  });

  it('keeps a module that will not load from reaching the reader as an error', async () => {
    // A preload nobody awaits still rejects, and an unhandled rejection prints
    // a console error in the reader's browser — and fails this run, which is
    // what makes the assertion below more than a count.
    //
    // `load` is a plain closure: a `vi.fn` attaches its own handler to whatever
    // the implementation returns, so a rejection routed through a spy can never
    // go unhandled and this case would pass with the swallow deleted.
    const { lazyRoute, preloadMatched } = await freshDocument();
    let calls = 0;
    const load = (): Promise<never> => {
      calls += 1;
      return missingChunk()();
    };
    const Page = lazyRoute(load);

    preloadMatched([{ route: { element: <Page /> } }], true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(1);
  });
});
