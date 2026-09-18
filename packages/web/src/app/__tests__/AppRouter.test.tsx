// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { AppRouter } from '@web/app/AppRouter';
import { lazyRoute } from '@web/app/lazy-route';
import { behindLoadingScreen } from '@web/app/loading-boundary';

/** Where `lazy-route` records the one reload a tab is allowed. */
const RELOAD_KEY = 'breatic.chunkReload';

type PageComponent = () => React.JSX.Element;

interface PendingPage {
  /** The route element, still waiting for its module. */
  Page: React.LazyExoticComponent<PageComponent>;
  /** Resolves the module, as the network would. */
  deliver: () => void;
}

/**
 * A page whose module has not arrived yet, plus the switch that delivers it.
 *
 * The promise stays pending until `deliver` is called, which is how a test
 * holds the app in the state a reader sees while a route chunk is still on
 * the wire.
 * @returns The lazy component and the function that resolves its module.
 */
function pendingPage(): PendingPage {
  // `React.lazy` does not run its factory until the first render, so this is
  // still the placeholder when the object below is built. The returned
  // `deliver` reads the binding at call time rather than capturing it.
  let resolveModule = (): void => {};
  const Page = React.lazy<PageComponent>(
    () =>
      new Promise<{ default: PageComponent }>((resolve) => {
        resolveModule = (): void => {
          resolve({
            default: () => <div data-testid='arrived'>arrived</div>,
          });
        };
      }),
  );
  return {
    Page,
    deliver: (): void => {
      resolveModule();
    },
  };
}

describe('AppRouter', () => {
  it('shows the loading screen until the page module arrives', async () => {
    const { Page, deliver } = pendingPage();
    const router = createMemoryRouter(
      behindLoadingScreen([{ path: '/', element: <Page /> }]),
      { initialEntries: ['/'] },
    );

    render(<AppRouter router={router} />);
    expect(screen.getByTestId('loading-screen')).toBeInTheDocument();

    deliver();

    expect(await screen.findByTestId('arrived')).toBeInTheDocument();
    expect(
      screen.queryByTestId('loading-screen'),
    ).not.toBeInTheDocument();
  });

  it('keeps the router off React transitions', () => {
    // A router state update wrapped in `React.startTransition` leaves already
    // revealed content on screen while the next page suspends, so the reader
    // would sit on the page they left until the chunk lands. `useTransitions`
    // defaults to undefined, which wraps them; false is what makes the
    // boundary above swap in on navigation too, not only on the first mount.
    //
    // The on-screen half of this is smoke (A3): a data-router navigation
    // builds a `Request` from a jsdom `AbortSignal`, which undici rejects, so
    // no navigation completes under vitest — the same limit `routes.test.tsx`
    // works around by never navigating. This pins the wiring so deleting the
    // prop fails here rather than only in a browser.
    const router = createMemoryRouter([{ path: '/', element: <div /> }]);
    const tree = AppRouter({ router }) as React.ReactElement<
      React.ComponentProps<typeof RouterProvider>
    >;

    expect(tree.props.useTransitions).toBe(false);
  });

  it('leaves the router mounted above the loading screen', () => {
    // React destroys the effects of whatever a boundary hides behind its
    // fallback. With the boundary above `RouterProvider`, the provider's
    // subscription to the router dies for the length of every chunk wait, so a
    // reader who presses Back while the loading screen is up is not followed:
    // measured on the production build, the address bar went to /studio and
    // the project page arrived four seconds later and stayed.
    //
    // The boundary therefore belongs inside the router, which is what this
    // pins: nothing may stand between `AppRouter` and `RouterProvider`.
    const router = createMemoryRouter([{ path: '/', element: <div /> }]);

    expect(AppRouter({ router }).type).toBe(RouterProvider);
  });

  it('does not hand the reload budget back while a guard shows its own screen', async () => {
    // The guard renders a screen instead of its children, so nothing under the
    // boundary suspends and the boundary commits — with the page module not
    // even asked for yet. This is the shape that reopened the loop on all seven
    // guarded entries when the signal was "the boundary committed", and the
    // boundary is a component now, so that signal is one `useEffect` away.
    sessionStorage.setItem(RELOAD_KEY, '1');
    const Page = lazyRoute(() => new Promise<never>(() => {}));
    const Guard = ({
      children,
    }: {
      children?: React.ReactNode;
    }): React.JSX.Element => {
      void children;
      return <div>auth pending</div>;
    };
    const router = createMemoryRouter(
      behindLoadingScreen([
        {
          path: '/',
          element: (
            <Guard>
              <Page />
            </Guard>
          ),
        },
      ]),
      { initialEntries: ['/'] },
    );

    render(<AppRouter router={router} />);
    await screen.findByText('auth pending');

    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('1');
  });
});
