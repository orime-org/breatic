// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { AppRouter } from '@web/app/AppRouter';

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
    const router = createMemoryRouter([{ path: '/', element: <Page /> }], {
      initialEntries: ['/'],
    });

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
    const tree = AppRouter({ router });

    expect(tree.type).toBe(React.Suspense);
    const child = tree.props.children as React.ReactElement<
      React.ComponentProps<typeof RouterProvider>
    >;
    expect(child.type).toBe(RouterProvider);
    expect(child.props.useTransitions).toBe(false);
  });
});
