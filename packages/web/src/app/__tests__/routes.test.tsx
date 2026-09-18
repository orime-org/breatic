// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { configure, getConfig, render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';

// This is a ROUTE-RESOLUTION test: it asserts each path maps to the right page
// component (e.g. /project/:id → ProjectPage, top-bar mounts). ProjectPage gates
// its body on the meta doc's collab socket status, so stub the socket to a
// terminal `connected` state — the real WebSocket lifecycle is covered by
// collab-socket / use-socket / SpaceDocSync unit tests, not here.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: null;
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({
    provider: null,
    synced: true,
    status: 'connected',
    authFailedReason: null,
  }),
}));

import { AppRouter } from '@web/app/AppRouter';
import { baseRoutes } from '@web/app/routes';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { QueryClientProvider } from '@web/app/providers/QueryClientProvider';
import { useCurrentUserStore } from '@web/stores';

/**
 * A memory router over the production route table.
 *
 * The table itself is imported rather than re-declared: a copy passes while
 * describing routes production no longer has, which is what the copy this
 * replaced had drifted into.
 * @param initialPath - The address to open at.
 * @returns A router jsdom can drive without touching window.location.
 */
function makeRouter(initialPath: string) {
  return createMemoryRouter(baseRoutes, { initialEntries: [initialPath] });
}

/**
 * How long a route may take to appear.
 *
 * The pages load on demand (task #142), so vitest transforms a page's whole
 * module graph at render time rather than when this file is imported. That is
 * the test runner's cost, not the reader's — a built chunk is already
 * compiled — and under `turbo test`, with every package's suite running at
 * once, it runs past `findBy`'s one-second default.
 */
const ROUTE_ARRIVAL_MS = 15_000;

describe('routes', () => {
  // Every wait in this file is a page arriving, so the budget is set once
  // rather than passed at each call: an assertion added later would otherwise
  // take the one-second default and flake under `turbo test`. Restored
  // afterwards so the budget cannot outlive this file, whatever the runner's
  // isolation settings are.
  let defaultTimeout = 0;
  beforeAll(() => {
    defaultTimeout = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: ROUTE_ARRIVAL_MS });
  });
  afterAll(() => {
    configure({ asyncUtilTimeout: defaultTimeout });
  });

  // `<Navigate>` redirects (/ → /studio and * → /studio) exercise the data
  // router's internal fetcher which trips a jsdom/undici AbortSignal mismatch.
  // The redirects themselves are one-liner `<Navigate replace />` elements;
  // exercising them via smoke / build is enough. Here we just assert that the
  // concrete page routes resolve to the correct components.

  beforeEach(() => {
    // Protected routes (Studio + Project) gate on
    // `useCurrentUserStore.user`. The production AuthBootstrap fires
    // `/auth/me` once on mount; here we short-circuit by seeding the
    // store directly so the route renders past the loading shell.
    useCurrentUserStore.setState({
      // A fully-onboarded user (non-null personalStudio) so the
      // protected routes render past both the auth gate AND the
      // personal-studio onboarding gate.
      user: {
        id: 'test-user',
        name: 'Tester',
        email: 't@t.com',
        personalStudio: { name: 'Tester', slug: 'tester', avatarUrl: null },
        membershipTier: 'base',
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('/studio renders the layout + recent landing (top bar lives in the layout)', async () => {
    render(
      <QueryClientProvider>
        <TooltipProvider>
          <AppRouter router={makeRouter('/studio')} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('banner')).toBeInTheDocument();
  });

  it('/project/:id resolves the project page (TopBar mounts)', async () => {
    render(
      <QueryClientProvider>
        <TooltipProvider>
          <AppRouter router={makeRouter('/project/demo-1')} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('top-bar')).toBeInTheDocument();
  });

  it('/login renders the auth page (title key resolved by i18n)', async () => {
    render(<AppRouter router={makeRouter('/login')} />);
    // Default boot locale is English; the title key resolves to "Sign in".
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('/register renders the auth page', async () => {
    render(<AppRouter router={makeRouter('/register')} />);
    expect(
      await screen.findByRole('heading', { name: 'Create an account' }),
    ).toBeInTheDocument();
  });

  it('/forgot-password renders the auth page', async () => {
    render(<AppRouter router={makeRouter('/forgot-password')} />);
    expect(
      await screen.findByRole('heading', { name: 'Forgot your password?' }),
    ).toBeInTheDocument();
  });

  it('/verify-email (no token) renders the check-inbox state', async () => {
    render(<AppRouter router={makeRouter('/verify-email')} />);
    expect(
      await screen.findByRole('heading', { name: 'Check your inbox' }),
    ).toBeInTheDocument();
  });
});
