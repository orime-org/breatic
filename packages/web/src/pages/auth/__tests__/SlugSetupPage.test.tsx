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
function setup(strict = false): ReturnType<typeof render> & { refresh: () => void } {
  const client = new QueryClient();
  const build = (): React.JSX.Element => {
    const wrapped = (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/choose-slug']}>
          <Routes>
            <Route path='/choose-slug' element={<SlugSetupPage />} />
            <Route path='/studio' element={<div data-testid='studio-page' />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    return strict ? <React.StrictMode>{wrapped}</React.StrictMode> : wrapped;
  };
  const result = render(build());
  // A fresh tree makes the page read the mocked check again.
  return { ...result, refresh: () => result.rerender(build()) };
}

describe('SlugSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to `valid` so a press goes through; individual tests override
    // via `setAvailability`.
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

  it('renders the slug form with its submit and the available line when available', () => {
    setup();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    // When the live check reports `valid`, the helper line shows the
    // availability confirmation (it replaces the default URL helper).
    expect(screen.getByText('Slug is available')).toHaveClass(
      'text-status-success-foreground',
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
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
  });

  it('keeps Continue pressable and says a slug is needed when it is empty (inner#1652)', async () => {
    setAvailability({ state: 'empty' });
    const user = userEvent.setup();
    setup();
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    const hint = screen.getByTestId('onboarding-slug-hint');
    expect(hint).toHaveTextContent('Enter a Slug.');
    expect(hint).toHaveClass('text-status-error-foreground');
    expect(screen.getByLabelText('Slug')).toHaveFocus();
    await user.type(screen.getByLabelText('Slug'), 'm');
    expect(hint).not.toHaveTextContent('Enter a Slug.');
  });

  // INVARIANT (design §7 #8): StrictMode double-mount must not fire a
  // setup-studio request — the page has no mount effect, so a remount
  // never leaks a network call.
  it('StrictMode double-mount fires no setup-studio request', () => {
    setup(true);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the format error and refuses the press when the slug is malformed (no API call)', async () => {
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
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
  });

  it('shows the length error and refuses the press when the slug is too short', async () => {
    setAvailability({ state: 'invalid', reason: 'length' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'abc');
    expect(screen.getByText('Must be 6–39 characters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
  });

  it('shows the reserved/taken error and refuses the press for a reserved slug', async () => {
    setAvailability({ state: 'invalid', reason: 'reserved' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'settings');
    expect(
      screen.getByText('That Slug is already in use.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
  });

  it('shows the "checking" line while the live check is in flight', async () => {
    setAvailability({ state: 'checking' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'pending-handle');
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('waits for a running check and then sets up the Studio (inner#1652)', async () => {
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null },
    });
    setAvailability({ state: 'checking' });
    const user = userEvent.setup();
    const { refresh } = setup();
    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-busy', 'true');

    setAvailability({ state: 'valid' });
    refresh();
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(authApi.setupStudio).toHaveBeenCalledWith({ slug: 'my-handle' });
  });

  it('reports a running check that comes back taken instead of sending (inner#1652)', async () => {
    setAvailability({ state: 'checking' });
    const user = userEvent.setup();
    const { refresh } = setup();
    await user.type(screen.getByLabelText('Slug'), 'taken-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    setAvailability({ state: 'invalid', reason: 'taken' });
    refresh();
    expect(authApi.setupStudio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveAttribute('aria-busy');
  });

  it('sends a slug the check could not reach, for the server to judge (inner#1652)', async () => {
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null },
    });
    setAvailability({ state: 'unverified' });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
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

  it('marks the submit button busy while the Studio is being set up, then leaves for /studio', async () => {
    let answer!: (value: Awaited<ReturnType<typeof authApi.setupStudio>>) => void;
    vi.mocked(authApi.setupStudio).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const busy = screen.getByRole('button', { name: 'Setting up...' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Slug')).not.toBeDisabled();

    answer({ personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null } });
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { busy: true })).toBeNull();
  });

  it('clears the busy mark on the submit button after a failed setup', async () => {
    let fail!: (reason: unknown) => void;
    vi.mocked(authApi.setupStudio).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Slug'), 'good-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Setting up...' })).toHaveAttribute('aria-busy', 'true');

    fail(new ApiException({ status: 500, message: 'boom' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    const idle = screen.getByRole('button', { name: 'Continue' });
    expect(idle).not.toHaveAttribute('aria-busy');
    expect(idle).not.toHaveAttribute('aria-disabled');
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
