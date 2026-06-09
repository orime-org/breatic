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
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import type { SlugStatus } from '@web/pages/studio/container/dialogs/use-slug-availability';
import type { SlugError } from '@web/pages/studio/container/dialogs/slug-util';
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

// Mock the shared live-availability hook so the page renders without a
// QueryClientProvider (the real hook calls `useQuery`) and so each test can
// pin the slug status precisely. The hook's own race-safety / debounce logic
// is covered by use-slug-availability.test.tsx.
vi.mock('@web/pages/studio/container/dialogs/use-slug-availability');

/**
 * Drive `useSlugAvailability` to a fixed status for the test.
 * @param status - the availability status the mocked hook returns.
 * @param reason - the failure reason, when `status` is `'invalid'` / `'taken'`.
 */
function setAvailability(status: SlugStatus, reason?: SlugError): void {
  vi.mocked(useSlugAvailability).mockReturnValue({
    status,
    reason: reason ?? undefined,
  });
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
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

describe('SlugSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to `available` so the form is interactive (submit enabled);
    // individual tests override via `setAvailability`.
    setAvailability('available');
    // A signed-in but not-yet-onboarded user (the state that reaches
    // this page): personalStudio is null until setup-studio runs.
    useCurrentUserStore.setState({
      user: { id: 'u1', name: 'foo', email: 'foo@bar.com', personalStudio: null },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('renders the slug form with an enabled submit and the available line when available', () => {
    setup();
    expect(screen.getByLabelText('Handle')).toBeInTheDocument();
    // When the live check reports `available`, the helper line shows the
    // availability confirmation (it replaces the default URL helper).
    expect(screen.getByText('Handle is available')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeInTheDocument();
    // Availability is `available`, so submit is enabled.
    expect(submit).toBeEnabled();
  });

  it('shows the default URL helper line when the input is idle', () => {
    // Empty input → idle status → the page shows where the handle will live.
    setAvailability('idle');
    setup();
    expect(screen.getByText(/Your home will live at/i)).toBeInTheDocument();
    // Idle is not `available`, so submit is disabled.
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
    setAvailability('invalid', 'format');
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'Bad_Slug');
    expect(
      screen.getByText('Lowercase letters, numbers and hyphens only.'),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the length error and disables submit when the slug is too short', async () => {
    setAvailability('invalid', 'length');
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'abc');
    expect(screen.getByText('Must be 6–39 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the reserved/taken error and disables submit for a reserved slug', async () => {
    setAvailability('invalid', 'reserved');
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'settings');
    expect(
      screen.getByText('That handle is already in use.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(authApi.setupStudio).not.toHaveBeenCalled();
  });

  it('shows the "checking availability" line while the live check is in flight', async () => {
    setAvailability('checking');
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Handle'), 'pending-handle');
    expect(screen.getByText('Checking availability…')).toBeInTheDocument();
    // Cannot submit while still checking.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
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
    expect(authApi.setupStudio).toHaveBeenCalledTimes(1);
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
      expect(
        screen.getByText('That handle is already in use.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
    // The user's onboarding state is unchanged — still gated.
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('surfaces a non-409 failure as the form-level error line (no navigation)', async () => {
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
