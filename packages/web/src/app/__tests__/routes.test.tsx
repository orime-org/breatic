// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import StudioLayout from '@web/pages/studio/shell/StudioLayout';
import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import ProjectPage from '@web/pages/project/ProjectPage';
import LoginPage from '@web/pages/auth/LoginPage';
import RegisterPage from '@web/pages/auth/RegisterPage';
import ForgotPasswordPage from '@web/pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '@web/pages/auth/ResetPasswordPage';
import VerifyEmailPage from '@web/pages/auth/VerifyEmailPage';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { QueryClientProvider } from '@web/app/providers/QueryClientProvider';
import { Navigate } from 'react-router-dom';
import { useCurrentUserStore } from '@web/stores';

function makeRouter(initialPath: string) {
  // Re-declare the same route table the production app uses but on a
  // memory router so jsdom tests don't touch window.location.
  return createMemoryRouter(
    [
      { path: '/', element: <Navigate to='/studio' replace /> },
      {
        // The studio layout route — rail + top bar persist; `/studio` is the
        // Recent index child (URL design §5.7, B correction).
        path: '/studio',
        element: (
          <ProtectedRoute>
            <StudioLayout />
          </ProtectedRoute>
        ),
        children: [{ index: true, element: <StudioRecentPage /> }],
      },
      {
        path: '/project/:projectId',
        element: (
          <ProtectedRoute>
            <ProjectPage />
          </ProtectedRoute>
        ),
      },
      {
        path: '/project/:projectId/space/:spaceId',
        element: (
          <ProtectedRoute>
            <ProjectPage />
          </ProtectedRoute>
        ),
      },
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '*', element: <Navigate to='/studio' replace /> },
    ],
    { initialEntries: [initialPath] },
  );
}

describe('routes', () => {
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
        personalStudio: { name: 'Tester', slug: 'tester' },
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
          <RouterProvider router={makeRouter('/studio')} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('banner')).toBeInTheDocument();
  });

  it('/project/:id resolves the project page (TopBar mounts)', async () => {
    render(
      <QueryClientProvider>
        <TooltipProvider>
          <RouterProvider router={makeRouter('/project/demo-1')} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('top-bar')).toBeInTheDocument();
  });

  it('/login renders the auth page (title key resolved by i18n)', async () => {
    render(<RouterProvider router={makeRouter('/login')} />);
    // Default boot locale is English; the title key resolves to "Sign in".
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('/register renders the auth page', async () => {
    render(<RouterProvider router={makeRouter('/register')} />);
    expect(
      await screen.findByRole('heading', { name: 'Create an account' }),
    ).toBeInTheDocument();
  });

  it('/forgot-password renders the auth page', async () => {
    render(<RouterProvider router={makeRouter('/forgot-password')} />);
    expect(
      await screen.findByRole('heading', { name: 'Forgot your password?' }),
    ).toBeInTheDocument();
  });

  it('/verify-email (no token) renders the check-inbox state', async () => {
    render(<RouterProvider router={makeRouter('/verify-email')} />);
    expect(
      await screen.findByRole('heading', { name: 'Check your inbox' }),
    ).toBeInTheDocument();
  });
});
