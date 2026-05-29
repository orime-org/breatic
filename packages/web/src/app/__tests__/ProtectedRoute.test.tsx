import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import { useCurrentUserStore } from '@web/stores';

// Use the declarative `<MemoryRouter>` + `<Routes>` form rather than
// `createMemoryRouter` — the data router triggers an internal fetcher
// that hits a jsdom/undici AbortSignal mismatch on `<Navigate>` (see
// `src/app/__tests__/routes.test.tsx` for the same workaround).
function renderAt(initialPath: string, protectedChildren: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path='/protected'
          element={<ProtectedRoute>{protectedChildren}</ProtectedRoute>}
        />
        <Route path='/login' element={<div data-testid='login-page' />} />
      </Routes>
    </MemoryRouter>,
  );
}

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
    expect(
      screen.getByTestId('project-loading-screen'),
    ).toBeInTheDocument();
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

  it('bootstrapped + user populated renders children', () => {
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'Alice', email: 'a@b.com' },
      role: null,
      loading: false,
      bootstrapped: true,
    });
    renderAt('/protected', <div data-testid='protected-content' />);
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });
});
