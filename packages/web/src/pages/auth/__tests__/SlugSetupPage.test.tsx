// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import SlugSetupPage from '@web/pages/auth/SlugSetupPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Mock only the network-touching `authApi.setupStudio`; keep everything
// else (types, deriveDisplayName) real so the page wiring is exercised.
vi.mock('@web/data/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@web/data/api/auth')>(
      '@web/data/api/auth',
    );
  return {
    ...actual,
    authApi: { setupStudio: vi.fn() },
  };
});

/**
 * Render the page inside a router with a `/studio` destination so a
 * successful setup (which navigates there) is observable by asserting
 * the destination marker renders.
 */
function setup(strict = false) {
  const tree = (
    <MemoryRouter initialEntries={['/choose-slug']}>
      <Routes>
        <Route path='/choose-slug' element={<SlugSetupPage />} />
        <Route path='/studio' element={<div data-testid='studio-page' />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

describe('SlugSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A signed-in but not-yet-onboarded user (the state that reaches
    // this page): personalStudio is null until setup-studio runs.
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'foo', email: 'foo@bar.com', personalStudio: null },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('renders the slug form with the helper text and submit', () => {
    setup();
    expect(screen.getByLabelText('Handle')).toBeInTheDocument();
    // Helper explains where the handle lives (the homepage URL).
    expect(
      screen.getByText(/Your home will live at/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  // INVARIANT (design §7 #8): StrictMode double-mount must not fire a
  // setup-studio request — the page has no mount effect, so a remount
  // never leaks a network call.
  it('StrictMode double-mount fires no setup-studio request', () => {
    setup(true);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('rejects a malformed slug client-side without calling the API', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'Bad_Slug');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(
      screen.getByText('Lowercase letters, numbers and hyphens only.'),
    ).toBeInTheDocument();
  });

  it('rejects a too-short slug client-side with the length error', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByText('Must be 6–39 characters.')).toBeInTheDocument();
  });

  it('rejects a reserved slug client-side', async () => {
    const user = userEvent.setup();
    setup();
    // `settings` is reserved AND ≥6 chars, so it clears the length check
    // and trips the reserved-word rule (not the length one).
    await user.type(screen.getByLabelText('Handle'), 'settings');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByText('That handle is already in use.')).toBeInTheDocument();
  });

  it('on success calls setup-studio, stores the personal studio, and navigates to /studio', async () => {
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle' },
    });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByTestId('studio-page')).toBeInTheDocument(),
    );
    expect(authApi.setupStudio).toHaveBeenCalledWith({ slug: 'my-handle' });
    const stored = useCurrentUserStore.getState().user;
    expect(stored?.personalStudio).toEqual({
      name: 'my-handle',
      slug: 'my-handle',
    });
    // Display name now reflects the personal studio (lifting the gate).
    expect(stored?.name).toBe('my-handle');
  });

  it('surfaces a 409 conflict as the inline "taken" error (no navigation)', async () => {
    vi.mocked(authApi.setupStudio).mockRejectedValueOnce(
      new ApiException({ status: 409, message: 'slug taken' }),
    );
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'taken-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByText('That handle is already in use.')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
    // The user's onboarding state is unchanged — still gated.
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('surfaces a non-409 failure as the form-level error line', async () => {
    vi.mocked(authApi.setupStudio).mockRejectedValueOnce(
      new ApiException({ status: 500, message: 'boom' }),
    );
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'good-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('boom');
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
