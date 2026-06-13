// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import RegisterPage from '@web/pages/auth/RegisterPage';
import RecoveryCodePage from '@web/pages/auth/RecoveryCodePage';
import { authApi } from '@web/data/api/auth';
import { useCurrentUserStore } from '@web/stores';

// Mock only the network-touching `authApi.register`; keep types +
// deriveDisplayName real.
vi.mock('@web/data/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@web/data/api/auth')>(
      '@web/data/api/auth',
    );
  return {
    ...actual,
    authApi: { register: vi.fn() },
  };
});

function setup() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path='/register' element={<RegisterPage />} />
        <Route path='/recovery-code' element={<RecoveryCodePage />} />
        <Route
          path='/choose-slug'
          element={<div data-testid='onboarding-page' />}
        />
        <Route path='/studio' element={<div data-testid='studio-page' />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RegisterPage (two-step entry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  // The username rewrite removed the free-form "Name" field entirely —
  // identity now comes from the onboarding slug, not registration.
  it('renders email + password only, with no name field', () => {
    setup();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('registers with email + password only (no name in the request body)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({
      user: { id: 'u1', email: 'foo@bar.com', personalStudio: null, credits: 0 },
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
    });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Email'), 'foo@bar.com');
    await user.type(screen.getByLabelText('Password'), 'supersecret');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(authApi.register).toHaveBeenCalledWith({
        email: 'foo@bar.com',
        password: 'supersecret',
      }),
    );
    // Step one leaves the user gated (personalStudio null) in the store.
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  // INVARIANT (design §5.1): after acknowledging the recovery code, the
  // user is sent to step two (the onboarding slug page), NOT straight to
  // /studio — a half-finished sign-up must complete onboarding first.
  it('continue from the recovery screen navigates to /choose-slug (not /studio)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({
      user: { id: 'u1', email: 'foo@bar.com', personalStudio: null, credits: 0 },
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
    });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Email'), 'foo@bar.com');
    await user.type(screen.getByLabelText('Password'), 'supersecret');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // The recovery-code screen gates Continue behind the ack checkbox.
    const ack = await screen.findByLabelText(
      /I have saved this recovery code/i,
    );
    await user.click(ack);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByTestId('onboarding-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
  });
});
