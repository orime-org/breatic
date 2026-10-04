// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import SlugSetupPage from '@web/pages/auth/SlugSetupPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import {
  slugFieldShowsConflict,
  useSlugAvailability,
} from '@web/pages/studio/container/dialogs/use-slug-availability';
import type { SlugCheck } from '@web/pages/studio/container/dialogs/slug-util';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Mock only the network-touching `authApi.setupStudio`; keep everything
// else (types) real so the page wiring is exercised.
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

// Mock the shared live-availability hook so each test can pin the slug check
// precisely. The hook's own race-safety / debounce logic
// is covered by use-slug-availability.test.tsx.
vi.mock('@web/pages/studio/container/dialogs/use-slug-availability');

/**
 * Drive `useSlugAvailability` to a fixed check for the test.
 * @param check - The check the mocked hook returns.
 */
function setAvailability(check: SlugCheck): void {
  vi.mocked(useSlugAvailability).mockReturnValue(check);
}

/**
 * Render the page inside a router with a `/studio` destination so a
 * successful setup (which navigates there) is observable by asserting
 * the destination marker renders.
 * @param strict - wrap in `React.StrictMode` to exercise double-mount.
 * @returns the render result.
 */
function setup(strict = false): ReturnType<typeof render> {
  const tree = (
    <MemoryRouter initialEntries={['/choose-slug']}>
      <Routes>
        <Route path='/choose-slug' element={<SlugSetupPage />} />
        <Route path='/studio' element={<div data-testid='studio-page' />} />
      </Routes>
    </MemoryRouter>
  );
  const client = new QueryClient();
  const wrapped = (
    <QueryClientProvider client={client}>{tree}</QueryClientProvider>
  );
  return render(
    strict ? <React.StrictMode>{wrapped}</React.StrictMode> : wrapped,
  );
}

describe('SlugSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to `valid` so the form is interactive (submit enabled);
    // individual tests override via `setAvailability`.
    setAvailability({ state: 'valid' });
    // A signed-in but not-yet-onboarded user (the state that reaches
    // this page): personalStudio is null until setup-studio runs.
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'foo', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base' },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('renders the slug form with an enabled submit and the available line when available', () => {
    setup();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    // When the live check reports `valid`, the helper line shows the
    // availability confirmation (it replaces the default URL helper).
    expect(screen.getByText('Slug is available')).toHaveClass(
      'text-status-success-foreground',
    );
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeInTheDocument();
    // The check is `valid`, so submit is enabled.
    expect(submit).toBeEnabled();
  });

  it('shows the default URL helper line when the input is empty', () => {
    // Empty input → empty check → the page shows where the handle will live.
    setAvailability({ state: 'empty' });
    setup();
    const hint = screen.getByTestId('onboarding-slug-hint');
    expect(hint).toHaveTextContent(
      'Your home will live at /studio/…. 6–39 characters',
    );
    expect(hint).toHaveClass('text-muted-foreground');
    // Empty is not `valid`, so submit is disabled.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  // INVARIANT (design §7 #8): StrictMode double-mount must not fire a
  // setup-studio request — the page has no mount effect, so a remount
  // never leaks a network call.
  it('StrictMode double-mount fires no setup-studio request', () => {
    setup(true);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the format error and disables submit when the slug is malformed (no API call)', async () => {
    // The live hook (mocked) reports the local shape failure.
    setAvailability({ state: 'invalid', reason: 'format' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'Bad_Slug');
    expect(
      screen.getByText(
        'Start with a lowercase letter; use only lowercase letters, numbers and single hyphens, not at the end.',
      ),
    ).toHaveClass('text-status-error-foreground');
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the length error and disables submit when the slug is too short', async () => {
    setAvailability({ state: 'invalid', reason: 'length' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'abc');
    expect(screen.getByText('Must be 6–39 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the reserved/taken error and disables submit for a reserved slug', async () => {
    setAvailability({ state: 'invalid', reason: 'reserved' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'settings');
    expect(
      screen.getByText('That Slug is already in use.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the "checking" line while the live check is in flight', async () => {
    setAvailability({ state: 'checking' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'pending-handle');
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    // Cannot submit while still checking.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('on success calls setup-studio, stores the personal studio, and navigates to /studio', async () => {
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null },
    });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByTestId('studio-page')).toBeInTheDocument(),
    );
    expect(authApi.setupStudio).toHaveBeenCalledTimes(1);
    expect(authApi.setupStudio).toHaveBeenCalledWith({ slug: 'my-handle' });
    const stored = useCurrentUserStore.getState().user;
    expect(stored?.personalStudio).toEqual({
      name: 'my-handle',
      slug: 'my-handle',
      avatarUrl: null,
    });
    // Display name now reflects the personal studio (lifting the gate).
    expect(stored?.name).toBe('my-handle');
    // A studio created moments ago has no avatar, and the store keeps that
    // absent rather than storing an empty string (#1882).
    expect(stored?.avatarUrl).toBeUndefined();
  });

  it('surfaces a 409 on a taken slug as the inline "taken" line (no navigation)', async () => {
    vi.mocked(authApi.setupStudio).mockRejectedValueOnce(
      new ApiException({ status: 409, message: 'slug taken' }),
    );
    // The real re-ask refreshes the cached answer the live hook reads.
    vi.mocked(slugFieldShowsConflict).mockImplementationOnce(
      async (_client, _err, _slug, fieldShown) => {
        setAvailability({ state: 'invalid', reason: 'taken' });
        return fieldShown();
      },
    );
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'taken-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(
        screen.getByText('That Slug is already in use.'),
      ).toBeInTheDocument(),
    );
    expect(slugFieldShowsConflict).toHaveBeenCalledWith(
      expect.any(QueryClient),
      expect.any(ApiException),
      'taken-handle',
      expect.any(Function),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
    // The user's onboarding state is unchanged — still gated.
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('shows the server message when a 409 is not about the slug', async () => {
    vi.mocked(authApi.setupStudio).mockRejectedValueOnce(
      new ApiException({ status: 409, message: 'slug taken' }),
    );
    vi.mocked(slugFieldShowsConflict).mockResolvedValueOnce(false);
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'free-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('slug taken');
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
  });

  it('surfaces a non-409 failure as the form-level error line (no navigation)', async () => {
    vi.mocked(authApi.setupStudio).mockRejectedValueOnce(
      new ApiException({ status: 500, message: 'boom' }),
    );
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'good-handle');
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
