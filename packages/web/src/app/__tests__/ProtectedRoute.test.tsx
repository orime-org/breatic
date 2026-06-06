// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import type { PersonalStudio } from '@web/data/api/auth';
import { useCurrentUserStore } from '@web/stores';

// Use the declarative `<MemoryRouter>` + `<Routes>` form rather than
// `createMemoryRouter` — the data router triggers an internal fetcher
// that hits a jsdom/undici AbortSignal mismatch on `<Navigate>` (see
// `src/app/__tests__/routes.test.tsx` for the same workaround).
function renderAt(
  initialPath: string,
  protectedChildren: React.ReactNode,
  requirePersonalStudio = true,
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path='/protected'
          element={
            <ProtectedRoute requirePersonalStudio={requirePersonalStudio}>
              {protectedChildren}
            </ProtectedRoute>
          }
        />
        <Route path='/login' element={<div data-testid='login-page' />} />
        <Route
          path='/choose-handle'
          element={<div data-testid='onboarding-page' />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const studio: PersonalStudio = { name: 'Alice', slug: 'alice' };

describe('ProtectedRoute', () => {
  beforeEach(() => {
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: false,
    });
  });

  it('!bootstrapped renders the loading shell (no redirect during initial /auth/me)', () => {
    // Initial boot: bootstrapped=false, user=null. ProtectedRoute must
    // NOT redirect — that would flash /login before the boot ping
    // resolves. Show the loading shell instead.
    renderAt('/protected', <div data-testid='protected-content' />);
    expect(screen.getByTestId('project-loading-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('bootstrapped + user=null bounces to /login', () => {
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />);
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('bootstrapped + user + personalStudio populated renders children', () => {
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'Alice', email: 'a@b.com', personalStudio: studio },
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />);
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  // INVARIANT (design §5.2 / §7 #4): an authenticated user whose
  // onboarding is incomplete (`personalStudio === null`) must be bounced
  // to the onboarding slug page — NOT rendered the protected page. This
  // is the gate that catches a half-finished email registration on any
  // protected URL.
  it('bootstrapped + user + personalStudio=null bounces to /choose-handle (not the protected page)', () => {
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'a', email: 'a@b.com', personalStudio: null },
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />);
    expect(screen.getByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  // INVARIANT (design §5.2): the onboarding page itself opts out of the
  // personal-studio gate (`requirePersonalStudio={false}`). Without this
  // exemption it would redirect to itself forever — the user is there
  // precisely because they have no personal studio yet.
  it('requirePersonalStudio=false renders children even when personalStudio=null (onboarding exemption)', () => {
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'a', email: 'a@b.com', personalStudio: null },
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />, false);
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  // The gate still requires a session: an unauthenticated user on the
  // exempt route bounces to /login, not onboarding (no studio is only
  // checked after the user-exists check).
  it('requirePersonalStudio=false still bounces unauthenticated users to /login', () => {
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />, false);
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });
});
