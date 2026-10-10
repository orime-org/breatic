// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { AppRouter } from '@web/app/AppRouter';
import { behindLoadingScreen } from '@web/app/loading-boundary';

vi.mock('react-router-dom', async (original) => {
  const actual = await original<typeof import('react-router-dom')>();
  return { ...actual, RouterProvider: vi.fn((props: React.ComponentProps<typeof actual.RouterProvider>) =>
    React.createElement(actual.RouterProvider, props)) };
});
afterEach(() => vi.clearAllMocks());

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
    render(<AppRouter router={router} />);
    expect(vi.mocked(RouterProvider).mock.calls.at(-1)?.[0].useTransitions).toBe(false);
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
    // pins: no Suspense boundary may hide `RouterProvider`.
    const router = createMemoryRouter([{ path: '/', element: <div /> }]);

    const { result } = renderHook(() => AppRouter({ router }));
    const pending: React.ReactNode[] = [result.current];
    let foundProvider = false;
    while (pending.length > 0) {
      const element = pending.pop();
      if (!React.isValidElement<{ children?: React.ReactNode }>(element)) continue;
      expect(element.type).not.toBe(React.Suspense);
      if (element.type === RouterProvider) {
        foundProvider = true;
        continue;
      }
      pending.push(...React.Children.toArray(element.props.children));
    }
    expect(foundProvider).toBe(true);
  });

});
